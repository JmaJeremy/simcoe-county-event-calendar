import { toWallClock, type RawEvent, type Source, type SyncWindow } from '@scec/core'
import { decodeEntities, stripTags, textOf, truncate } from './html.ts'
import { getJson, mapLimit, request } from './http.ts'

/**
 * WordPress EventON — the County of Simcoe's own calendar and Adjala-Tosorontio's.
 *
 * EventON keeps dates in post meta the REST API does not expose, so this is a two-step
 * adapter: list the `ajde_events` posts (id, link, title) through WP REST, then read each
 * event page, which carries everything as data attributes on the event element —
 * `data-time="unixStart-unixEnd"`, `data-location_name`, `data-location_address` — plus a
 * schema.org Event JSON-LD block with the description and image.
 *
 * To keep that to a sane number of page fetches, the list is restricted to posts
 * PUBLISHED in the last ~13 months (`after=`): organisers post events weeks or months
 * ahead, not years, and the county's 202-post archive goes back to 2020. That cut the
 * county from 202 pages to 52 during research. Recurring events are separate posts here
 * (a series entry per date), so one page is one occurrence.
 *
 * Times come from the JSON-LD `startDate`/`endDate`, NOT from `data-time`. The unix
 * values in `data-time` are the wall time re-expressed in the WordPress site's configured
 * zone, and simcoe.ca's is set to UTC+1 (the page prints "(GMT+01:00)" next to every
 * time) while adjtos.ca's is America/Toronto — so the same attribute is five hours off on
 * one site and correct on the other. The JSON-LD carries the wall clock the page shows,
 * which matches the "Time: 5:30 p.m." organisers write in their descriptions. Its
 * offset suffix is ignored and the naive wall string handed to normalize like every other
 * platform's. `data-time` is only a fallback for a page with no usable JSON-LD, read as
 * true UTC.
 */

export interface EventonPost {
  id: number
  link: string
  title: { rendered: string }
  modified?: string
  event_type?: number[]
}

const PER_PAGE = 100
const PUBLISHED_WITHIN_DAYS = 400

export const eventonListUrl = (origin: string, after: string, page: number): string =>
  `${origin.replace(/\/$/, '')}/wp-json/wp/v2/ajde_events?per_page=${PER_PAGE}&page=${page}&after=${after}T00:00:00&_fields=id,link,title,modified,event_type&orderby=date&order=desc`

export const taxonomyUrl = (origin: string): string =>
  `${origin.replace(/\/$/, '')}/wp-json/wp/v2/event_type?per_page=100&_fields=id,name`

export function publishedAfter(window: SyncWindow): string {
  const d = new Date(`${window.from}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - PUBLISHED_WITHIN_DAYS)
  return d.toISOString().slice(0, 10)
}

interface PageData {
  /** Naive wall-clock 'YYYY-MM-DDTHH:mm' per occurrence, as the page displays them. */
  times: Array<{ localStart: string; localEnd?: string }>
  locationName?: string
  address?: string
  description?: string
  imageUrl?: string
  organizer?: string
}

/** The pure half: one event page in, its occurrence(s) and details out. */
const WALL = /(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{2})/

/** '2026-9-17T17:30-4:00' (EventON does not zero-pad) → '2026-09-17T17:30'. */
export function wallFromJsonLd(value: string | undefined): string | undefined {
  const m = value ? WALL.exec(value) : null
  if (!m) return undefined
  const pad = (v: string): string => v.padStart(2, '0')
  return `${m[1]}-${pad(m[2]!)}-${pad(m[3]!)}T${pad(m[4]!)}:${m[5]}`
}

export function parseEventPage(html: string, timezone = 'America/Toronto'): PageData {
  const times: PageData['times'] = []
  const seen = new Set<string>()
  const addTime = (localStart: string | undefined, localEnd: string | undefined) => {
    if (!localStart || seen.has(localStart)) return
    seen.add(localStart)
    times.push({ localStart, localEnd: localEnd && localEnd > localStart ? localEnd : undefined })
  }
  const attr = (name: string): string | undefined => {
    const m = new RegExp(`data-${name}="([^"]*)"`).exec(html)
    return m?.[1] ? decodeEntities(m[1]).trim() || undefined : undefined
  }

  let description: string | undefined
  let imageUrl: string | undefined
  for (const block of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    const raw = block[1]!
    if (!raw.includes('"Event"')) continue
    try {
      const data = JSON.parse(raw) as { description?: string; image?: string; startDate?: string; endDate?: string }
      addTime(wallFromJsonLd(data.startDate), wallFromJsonLd(data.endDate))
      description ??= data.description ? truncate(stripTags(data.description)) || undefined : undefined
      imageUrl ??= data.image || undefined
    } catch {
      // EventON writes this block by hand and an unescaped quote in a description breaks
      // it; the dates are still findable by pattern.
      addTime(wallFromJsonLd(/"startDate":\s*"([^"]+)"/.exec(raw)?.[1]), wallFromJsonLd(/"endDate":\s*"([^"]+)"/.exec(raw)?.[1]))
    }
  }
  if (times.length === 0) {
    for (const m of html.matchAll(/data-time="(\d+)-(\d+)"/g)) {
      const start = Number(m[1])
      const end = Number(m[2])
      addTime(toWallClock(start * 1000, timezone), end > start ? toWallClock(end * 1000, timezone) : undefined)
    }
  }
  if (!description) {
    const desc = /<div class="eventon_desc_in"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/.exec(html)?.[1]
    if (desc) description = truncate(stripTags(desc)) || undefined
  }
  const organizerBlock = /evo_metarow_organizer[\s\S]*?<h3[^>]*>[\s\S]*?<\/h3>([\s\S]*?)<\/div>/.exec(html)?.[1]
  const organizer = organizerBlock ? textOf(organizerBlock).replace(/^Organizer\s*/i, '') || undefined : undefined

  return { times, locationName: attr('location_name'), address: attr('location_address'), description, imageUrl, organizer }
}

export function mapEventonPost(
  post: EventonPost,
  page: PageData,
  window: SyncWindow,
  typeNames: Map<number, string> = new Map(),
): RawEvent[] {
  const title = textOf(post.title.rendered)
  const categories = (post.event_type ?? []).map((id) => typeNames.get(id)).filter((n): n is string => !!n)
  const out: RawEvent[] = []

  for (const t of page.times) {
    const { localStart, localEnd } = t
    const date = localStart.slice(0, 10)
    if (date < window.from || date > window.to) continue
    // EventON marks an all-day event by spanning 00:00 to 23:59.
    const allDay = localStart.endsWith('T00:00') && (localEnd?.endsWith('T23:59') ?? false)

    out.push({
      // One post is normally one occurrence; a post with several times gets one id each.
      externalId: page.times.length > 1 ? `${post.id}@${localStart}` : String(post.id),
      title,
      description: page.description,
      localStart,
      localEnd: allDay ? undefined : localEnd,
      allDay,
      timePrecision: allDay ? 'date-only' : 'exact',
      venueName: page.locationName,
      address: page.address,
      categories,
      organizer: page.organizer,
      imageUrl: page.imageUrl,
      url: post.link,
      raw: { post, times: page.times },
    })
  }
  return out
}

export async function fetchEventon(source: Source, window: SyncWindow): Promise<RawEvent[]> {
  const config = source.config
  if (config.platform !== 'eventon') throw new Error(`Source ${source.slug} is not an eventon source`)
  const { origin } = config

  const posts: EventonPost[] = []
  for (let page = 1; page <= 5; page++) {
    let batch: EventonPost[]
    try {
      batch = await getJson<EventonPost[]>(eventonListUrl(origin, publishedAfter(window), page))
    } catch (err) {
      // WordPress answers a page past the end with HTTP 400, not an empty array.
      if (page > 1 && err instanceof Error && /HTTP 400/.test(err.message)) break
      throw err
    }
    if (!Array.isArray(batch)) throw new Error(`Unexpected payload from ${origin}: not a list`)
    posts.push(...batch)
    if (batch.length < PER_PAGE) break
  }

  const typeNames = new Map<number, string>()
  try {
    for (const t of await getJson<Array<{ id: number; name: string }>>(taxonomyUrl(origin))) {
      typeNames.set(t.id, decodeEntities(t.name))
    }
  } catch {
    // Categories are a nicety; never lose the events over them.
  }

  const pages = await mapLimit(posts, 4, async (post) => {
    try {
      return parseEventPage(await request(post.link), source.timezone)
    } catch {
      return null
    }
  })

  return posts.flatMap((post, i) => {
    const page = pages[i]
    return page ? mapEventonPost(post, page, window, typeNames) : []
  })
}
