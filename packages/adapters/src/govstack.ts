import type { EventDetail, RawEvent, Source, SyncWindow } from '@scec/core'
import { isoDate, monthNumber, parseClock, pick, slugify, stripTags, textOf, truncate } from './html.ts'
import { request } from './http.ts'

/**
 * Granicus govStack Events — twelve of our sources, every one a `calendar.` or `events.`
 * subdomain of a township's site (plus the Orillia Public Library).
 *
 * The calendar is server-rendered with no feed of any kind. The list view is the cheapest
 * route: `/default/List?StartDate=&EndDate=` returns the first 25 items and a
 * "(N Results Found)" count; its own paginator then loads `/default/_List?…&Page=k`
 * (0-based) fragments, which we fetch directly. Everything the site shows — title, date,
 * start time, address, category, description — is in the list item, so the detail page is
 * never needed. That keeps a source to ceil(N/25) requests.
 *
 * Quirks recorded from real pages:
 *   - The year is not in the list item, only the day and month, so it is inferred from the
 *     window (a month earlier than the window's start belongs to next year).
 *   - Multi-day entries can arrive with an EMPTY detail href ("Voting Period Begins" in
 *     Ramara's election calendar). The id is then synthesised from date, time and title.
 *   - "All Day" appears where a start time would be.
 */

const PAGE_SIZE = 25

interface Config {
  host: string
  excludeCategories?: string[]
}

const mmddyyyy = (iso: string): string => {
  const [y, m, d] = iso.split('-')
  return `${m}/${d}/${y}`
}

export const listUrl = (host: string, window: SyncWindow, page = 0): string => {
  const qs = `StartDate=${mmddyyyy(window.from)}&EndDate=${mmddyyyy(window.to)}`
  return page === 0
    ? `https://${host}/default/List?${qs}`
    : `https://${host}/default/_List?${qs}&Page=${page}`
}

export function resultCount(html: string): number {
  const m = /\((\d+)\s+Results?\s+Found\)/i.exec(html)
  return m ? Number(m[1]) : 0
}

export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE))
}

const ITEM = /<div class="icrt-calendarListItem">([\s\S]*?)(?=<div class="icrt-calendarListItem">|<div class="icrt-calendarPaginationWrapper"|<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<div class="icrt-calendarPagination)/g

interface ParsedItem {
  href: string
  title: string
  category: string
  day: number
  month: number
  timeText: string
  address: string
  description: string
}

/** The pure half: list HTML in, items out. Tested from a saved page. */
export function parseListItems(html: string): ParsedItem[] {
  const items: ParsedItem[] = []
  for (const m of html.matchAll(ITEM)) {
    const block = m[1]!
    const link = /<a class="meta-title" href="([^"]*)">([\s\S]*?)<\/a>([\s\S]*?)<p>([\s\S]*?)<\/p>/.exec(block)
    if (!link) continue
    const [, href, titleHtml, categoryHtml, whenWhere] = link
    const day = Number(pick(block, /<span class="date">\s*(\d{1,2})\s*<\/span>/) ?? NaN)
    const month = monthNumber(pick(block, /<span class="month">\s*([A-Za-z]+)\s*<\/span>/) ?? '') ?? NaN
    if (!Number.isFinite(day) || !Number.isFinite(month)) continue

    const [timePart = '', ...rest] = textOf(whenWhere!.replace(/<span>\|<\/span>/g, '|')).split('|')
    const descHtml = /<div class="icrt-calendarListItemDesc">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/.exec(block)?.[1] ?? ''

    items.push({
      href: href!.trim(),
      title: textOf(titleHtml!),
      category: textOf(categoryHtml!),
      day,
      month,
      timeText: timePart.trim(),
      address: rest.join('|').trim(),
      description: truncate(stripTags(descHtml)),
    })
  }
  return items
}

/**
 * Year inference. The window never spans more than ~15 months, so a month number lower
 * than the window's first month means the following year.
 */
export function yearFor(month: number, window: SyncWindow): number {
  const startYear = Number(window.from.slice(0, 4))
  const startMonth = Number(window.from.slice(5, 7))
  return month < startMonth ? startYear + 1 : startYear
}

export function mapItems(host: string, items: ParsedItem[], window: SyncWindow, exclude: string[] = []): RawEvent[] {
  const excluded = new Set(exclude.map((c) => c.toLowerCase()))
  const out: RawEvent[] = []

  for (const item of items) {
    if (excluded.has(item.category.toLowerCase())) continue

    const date = isoDate(yearFor(item.month, window), item.month, item.day)
    const clock = parseClock(item.timeText)
    const allDay = !clock
    const slug = item.href.replace(/^\/default\/Detail\//i, '').replace(/\/$/, '')

    // The detail slug is the platform's own key for the occurrence: date, time and title
    // in one string. Only when it is blank do we build one ourselves.
    const externalId = slug || `${date}-${(clock ?? '00:00').replace(':', '')}-${slugify(item.title)}`
    const url = slug
      ? `https://${host}/default/Detail/${slug}`
      : `https://${host}/default/Month?StartDate=${mmddyyyy(`${date.slice(0, 7)}-01`)}`

    out.push({
      externalId,
      title: item.title,
      description: item.description || undefined,
      localStart: `${date}T${clock ?? '00:00'}`,
      allDay,
      timePrecision: allDay ? 'date-only' : 'exact',
      address: item.address && !/^(various|tba|tbd|n\/a)$/i.test(item.address) ? item.address : undefined,
      categories: item.category ? [item.category] : [],
      url,
      raw: item,
    })
  }
  return out
}

export interface GovstackFetchResult {
  events: RawEvent[]
  requests: number
}

export async function fetchGovstack(source: Source, window: SyncWindow): Promise<RawEvent[]> {
  return (await fetchGovstackDetailed(source, window)).events
}

export async function fetchGovstackDetailed(source: Source, window: SyncWindow): Promise<GovstackFetchResult> {
  const config = source.config
  if (config.platform !== 'govstack') throw new Error(`Source ${source.slug} is not a govstack source`)
  const { host, excludeCategories = [] }: Config = config

  const first = await request(listUrl(host, window, 0))
  const total = resultCount(first)
  const pages = pageCount(total)
  const items = parseListItems(first)
  let requests = 1

  for (let page = 1; page < pages; page++) {
    items.push(...parseListItems(await request(listUrl(host, window, page))))
    requests++
  }

  if (total > 0 && items.length === 0) {
    throw new Error(`${host} reported ${total} results but the list markup yielded none — the template may have changed`)
  }
  return { events: mapItems(host, items, window, excludeCategories), requests }
}

/* ---------- the event's own page ---------- */

/**
 * govStack detail pages carry what the list view leaves out: the untruncated description,
 * where the price usually lives, and the organiser's poster.
 *
 * The page ships the description twice — `#text-less` is the same truncation the list
 * shows, `#tx_more` the whole thing behind a "See more" toggle — so the second is what we
 * want. Everything is read from inside the event's own container: these pages carry site
 * navigation, a footer and a facility price list, and a `$` from any of those would put a
 * price on a free event.
 */
const DETAIL_CONTAINER = /<div class="icrt-calendarContentDetail">([\s\S]*?)<div class="icrt-calendarContentSide/i

/**
 * The description ends where the "See more" toggle begins. Everything after that button —
 * contact details, the website link, the list of upcoming dates, and on recreation
 * calendars the facility's whole drop-in price list — belongs to the page, not the event.
 * Reading past it would put "$5.00" on a free seniors' walking group.
 */
function descriptionFrom(container: string): string {
  const start = container.search(/<div[^>]*id="tx_more"[^>]*>/i)
  const fallback = container.search(/<div[^>]*id="text-less"[^>]*>/i)
  const from = start >= 0 ? start : fallback
  if (from < 0) return ''

  const rest = container.slice(from)
  const end = rest.search(/<button[^>]*onclick="bToggle|<span[^>]*id="tx_dots"/i)
  return stripTags(end > 0 ? rest.slice(0, end) : rest).trim()
}

export function parseGovstackDetail(html: string, host: string): EventDetail {
  const container = DETAIL_CONTAINER.exec(html)?.[1] ?? ''
  if (!container) return {}

  const description = descriptionFrom(container)

  // The src is a path under the detail URL, and the page's own og:image is malformed
  // ("https:///default/..."), so resolve it against the host ourselves.
  const src = pick(container, /<img[^>]*id="event_image"[^>]*\ssrc="([^"]+)"/i)
  const imageUrl = src ? new URL(src, `https://${host}`).toString() : undefined

  return { description: description || undefined, imageUrl }
}

export async function fetchGovstackDetail(source: Source, url: string): Promise<EventDetail> {
  if (source.config.platform !== 'govstack') throw new Error(`Source ${source.slug} is not a govstack source`)
  return parseGovstackDetail(await request(url), source.config.host)
}
