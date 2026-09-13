import type { RawEvent, Source, SyncWindow } from '@scec/core'
import { absolute, decodeEntities, isoDate, monthNumber, parseClock, stripTags, textOf, truncate } from './html.ts'
import { mapLimit, request } from './http.ts'

/**
 * SPACES — the community platform behind Village Media's event listings (BarrieToday,
 * OrilliaMatters, MidlandToday, CollingwoodToday). Each news site fronts a
 * `<town>.spaces.ca` instance; the news domains 403 non-browser clients, the SPACES
 * hosts do not.
 *
 * `GET /events?StartDate=&EndDate=` renders event cards; the page's infinite scroller
 * then POSTs the same form to `/posts/eventsbysite` with `page=N` and gets a fragment of
 * more cards (an empty body means the end). Cards carry the category, title, a link, an
 * image and a human date line — `Sep 12 9:30 AM - Sep 13 5:00 PM`, `Sep 13 2:30 PM -
 * 4:30 PM`, or just `Sep 13` — with no year, which is inferred from the window.
 *
 * Everything else lives in the detail page as free text the organiser typed, so the
 * adapter reads the description and picks out `Location:` / `Cost:` style lines when
 * they exist. Listings are user-submitted: this is the source most likely to duplicate
 * a town's own calendar, and the one whose fields deserve the least trust.
 */

interface Card {
  id: string
  category: string
  link: string
  title: string
  when: string
  imageUrl?: string
}

const CARD = /<div class="card card-body" data-id="(\d+)" data-page="\d+">([\s\S]*?)(?=<div class="card card-body" data-id=|<\/div>\s*<div class="scroll-page">|$)/g

export function parseCards(html: string): Card[] {
  const cards: Card[] = []
  for (const m of html.matchAll(CARD)) {
    const block = m[2]!
    const link = /<a href="([^"]+)" class="[^"]*event-details[^"]*"/.exec(block)?.[1]
    const title = /<span class="(?:med-)?short-post">([\s\S]*?)<\/span>/.exec(block)?.[1]
    const when = /<\/button><div><div>([^<]*)<\/div>/.exec(block)?.[1]
    if (!link || !title || !when) continue
    cards.push({
      id: m[1]!,
      category: textOf(/IN\s*<a href="\/[a-z-]+"[^>]*>([^<]*)<\/a>/.exec(block)?.[1] ?? ''),
      link,
      title: textOf(title),
      when: decodeEntities(when).replace(/\s+/g, ' ').trim(),
      imageUrl: /<img src="([^"]+)"/.exec(block)?.[1],
    })
  }
  return cards
}

export interface WhenParsed {
  startDate: string
  startTime?: string
  endDate?: string
  endTime?: string
}

const DATE_PART = /^([A-Za-z]{3,4})\s+(\d{1,2})(?:\s+(\d{1,2}:\d{2}\s*[AP]M))?$/i
const TIME_ONLY = /^(\d{1,2}:\d{2}\s*[AP]M)$/i

/** 'Sep 12 9:30 AM - Sep 13 5:00 PM' and friends. Year from the window. */
export function parseWhen(text: string, window: SyncWindow): WhenParsed | null {
  const [left, right] = text.split(/\s+[-–]\s+/).map((s) => s.trim())
  const l = DATE_PART.exec(left ?? '')
  if (!l) return null
  const year = (month: number): number => {
    const startYear = Number(window.from.slice(0, 4))
    return month < Number(window.from.slice(5, 7)) ? startYear + 1 : startYear
  }
  const lm = monthNumber(l[1]!)
  if (!lm) return null
  const out: WhenParsed = { startDate: isoDate(year(lm), lm, Number(l[2])), startTime: l[3] ? parseClock(l[3]) : undefined }

  if (right) {
    const r = DATE_PART.exec(right)
    const t = TIME_ONLY.exec(right)
    if (r && monthNumber(r[1]!)) {
      const rm = monthNumber(r[1]!)!
      out.endDate = isoDate(year(rm), rm, Number(r[2]))
      out.endTime = r[3] ? parseClock(r[3]) : undefined
    } else if (t) {
      out.endDate = out.startDate
      out.endTime = parseClock(t[1]!)
    }
  }
  return out
}

export interface DetailData {
  description?: string
  venueName?: string
  address?: string
  costText?: string
  organizer?: string
}

const LABELLED = (labels: string): RegExp => new RegExp(`^\\s*(?:${labels})\\s*[:\\-–]\\s*(.+)$`, 'im')

/** The detail page: the organiser's text plus any labelled lines inside it. */
export function parseDetail(html: string): DetailData {
  const post = /<div id="post" class="card"[\s\S]*?<div class="card-body">([\s\S]*?)<div class="snippet snippet-md/.exec(html)?.[1] ?? ''
  const organizer = /<span class="title">([^<]*)<\/span>/.exec(post)?.[1]
  const body = /<h3>[\s\S]*?<\/h3>([\s\S]*?)$/.exec(post)?.[1] ?? post
  const text = stripTags(body)

  const pickLine = (labels: string): string | undefined => LABELLED(labels).exec(text)?.[1]?.trim() || undefined
  const location = pickLine('location|where|venue|place')
  const address = pickLine('address')

  return {
    description: truncate(text) || undefined,
    venueName: location && !address ? location : location,
    address: address ?? undefined,
    costText: pickLine('cost|price|admission|tickets?|fee|entry'),
    organizer: organizer ? decodeEntities(organizer).trim() : undefined,
  }
}

export function mapCards(host: string, cards: Card[], details: Map<string, DetailData>, window: SyncWindow): RawEvent[] {
  const out: RawEvent[] = []
  for (const card of cards) {
    const when = parseWhen(card.when, window)
    if (!when) continue
    const detail = details.get(card.id) ?? {}
    const hasTime = !!when.startTime
    const endsSameOrLater = when.endDate && when.endDate >= when.startDate
    // A card with a date range but no clock times is a multi-day, all-day event.
    const allDay = !hasTime

    out.push({
      externalId: `${card.id}@${when.startDate}`,
      title: card.title,
      description: detail.description,
      localStart: `${when.startDate}T${when.startTime ?? '00:00'}`,
      localEnd: endsSameOrLater && when.endTime ? `${when.endDate}T${when.endTime}` : undefined,
      allDay,
      timePrecision: hasTime ? 'exact' : 'date-only',
      venueName: detail.venueName,
      address: detail.address,
      costText: detail.costText,
      categories: card.category ? [card.category] : [],
      organizer: detail.organizer,
      imageUrl: card.imageUrl?.replace(/;w=\d+;h=\d+;mode=crop;?$/, ''),
      url: absolute(`https://${host}`, card.link),
      raw: { card, detail: details.get(card.id) },
    })
  }
  return out
}

export async function fetchSpaces(source: Source, window: SyncWindow): Promise<RawEvent[]> {
  const config = source.config
  if (config.platform !== 'spaces') throw new Error(`Source ${source.slug} is not a spaces source`)
  const { host } = config
  const base = `https://${host}`

  const cards = parseCards(await request(`${base}/events?StartDate=${window.from}&EndDate=${window.to}`))
  for (let page = 2; page <= 10; page++) {
    const form = new URLSearchParams({ Query: '', SpaceId: '', StartDate: window.from, EndDate: window.to, ftype: '0', page: String(page) })
    const fragment = await request(`${base}/posts/eventsbysite`, {
      method: 'POST',
      body: form.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
    })
    const more = parseCards(fragment)
    if (more.length === 0) break
    cards.push(...more)
  }

  // Cards for the same post can repeat across pages; keep the first.
  const unique = [...new Map(cards.map((c) => [c.id, c])).values()]
  const details = new Map<string, DetailData>()
  await mapLimit(unique, 4, async (card) => {
    try {
      details.set(card.id, parseDetail(await request(absolute(base, card.link))))
    } catch {
      // The card alone is still a listing.
    }
  })
  return mapCards(host, unique, details, window)
}
