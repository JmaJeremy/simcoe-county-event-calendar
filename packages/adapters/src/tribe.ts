import { resolveMunicipality, type RawEvent, type Source, type SyncWindow } from '@scec/core'
import { stripTags, truncate } from './html.ts'
import { getJson } from './http.ts'

/**
 * WordPress "The Events Calendar" (Modern Tribe) REST API — New Tecumseth, two libraries,
 * the Barrie Film Festival and Barrie 360.
 *
 * The one source with a real, documented JSON API: `/wp-json/tribe/events/v1/events`
 * returns full event objects with venue, cost, categories and an id per occurrence.
 * Dates are naive local strings in the site's own zone ("2026-09-01 12:30:00"), which is
 * exactly what normalize expects; `utc_start_date` is deliberately ignored.
 */

export interface TribeEvent {
  id: number
  url: string
  title: string
  description?: string
  excerpt?: string
  start_date: string
  end_date?: string
  all_day?: boolean
  cost?: string
  categories?: Array<{ name: string }>
  tags?: Array<{ name: string }>
  venue?: { venue?: string; address?: string; city?: string; zip?: string } | unknown[]
  organizer?: Array<{ organizer?: string }> | Record<string, unknown>
  image?: { url?: string } | false
  website?: string
  hide_from_listings?: boolean
  status?: string
}

export interface TribePage {
  events: TribeEvent[]
  total: number
  total_pages: number
}

const PER_PAGE = 50

export const tribeUrl = (origin: string, window: SyncWindow, page: number): string =>
  `${origin.replace(/\/$/, '')}/wp-json/tribe/events/v1/events?start_date=${window.from}&end_date=${window.to}&per_page=${PER_PAGE}&page=${page}&status=publish`

/** WordPress leaves entities in `title` ("Flag Raising &#8211; …"); the helper decodes them. */
const text = (html: string | undefined): string | undefined => {
  const t = html ? stripTags(html).replace(/\s+/g, ' ').trim() : ''
  return t || undefined
}

/**
 * A series that occurs every single day for this long is a data-entry slip, not an event.
 * Barrie 360 lists Gussapolooza — a three-day festival held August 21-23, as its own
 * description says — as recurring daily from September to March: 195 copies. The longest
 * genuine daily run anywhere on the site when this was written was 37 days (Penetanguishene's
 * summer drop-in pickleball), so 90 leaves real series well clear.
 */
export const RUNAWAY_DAILY_DAYS = 90

const dayAfter = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** Drop every occurrence of a title-and-venue series with an unbroken daily run of RUNAWAY_DAILY_DAYS or more. */
export function dropRunawaySeries(events: RawEvent[]): { kept: RawEvent[]; dropped: string[] } {
  const series = new Map<string, Set<string>>()
  const key = (e: RawEvent) => `${e.title}\u0000${e.venueName ?? ''}`
  for (const e of events) {
    const dates = series.get(key(e)) ?? new Set<string>()
    dates.add(e.localStart.slice(0, 10))
    series.set(key(e), dates)
  }
  const runaway = new Set<string>()
  for (const [k, dates] of series) {
    if (dates.size < RUNAWAY_DAILY_DAYS) continue
    let run = 0
    let longest = 0
    let previous = ''
    for (const d of [...dates].sort()) {
      run = previous && dayAfter(previous) === d ? run + 1 : 1
      longest = Math.max(longest, run)
      previous = d
    }
    if (longest >= RUNAWAY_DAILY_DAYS) runaway.add(k)
  }
  return {
    kept: events.filter((e) => !runaway.has(key(e))),
    dropped: [...runaway].map((k) => k.split('\u0000')[0]!),
  }
}

export function mapTribeEvents(events: TribeEvent[]): RawEvent[] {
  const out: RawEvent[] = []
  for (const e of events) {
    if (e.hide_from_listings || (e.status && e.status !== 'publish')) continue
    const venue = e.venue && !Array.isArray(e.venue) ? e.venue : undefined
    const organizer = Array.isArray(e.organizer) ? e.organizer[0]?.organizer : undefined
    const address = [venue?.address, venue?.city, venue?.zip].filter((v): v is string => !!v?.trim()).join(', ')
    const description = e.description ? truncate(stripTags(e.description)) : text(e.excerpt)

    out.push({
      externalId: String(e.id),
      title: text(e.title) ?? 'Untitled event',
      description: description || undefined,
      localStart: e.start_date,
      localEnd: e.end_date || undefined,
      allDay: e.all_day ?? false,
      timePrecision: e.all_day ? 'date-only' : 'exact',
      venueName: text(venue?.venue),
      address: address || undefined,
      municipalityHint: venue?.city,
      costText: e.cost?.trim() || undefined,
      categories: [...(e.categories ?? []), ...(e.tags ?? [])].map((c) => c.name).filter(Boolean),
      organizer: text(organizer),
      imageUrl: e.image && typeof e.image === 'object' ? e.image.url : undefined,
      url: e.url,
      raw: e,
    })
  }
  return dropRunawaySeries(out).kept
}

export async function fetchTribe(source: Source, window: SyncWindow): Promise<RawEvent[]> {
  const config = source.config
  if (config.platform !== 'tribe') throw new Error(`Source ${source.slug} is not a tribe source`)

  const events: TribeEvent[] = []
  let page = 1
  let pages = 1
  do {
    const body = await getJson<TribePage>(tribeUrl(config.origin, window, page))
    if (!Array.isArray(body.events)) throw new Error(`Unexpected payload from ${config.origin}: no events array`)
    events.push(...body.events)
    pages = body.total_pages ?? 1
    page++
  } while (page <= pages && page <= 20)

  const mapped = mapTribeEvents(events)
  // A town's own calendar is in its town. A regional one (Barrie 360) reaches past the
  // county — Fiddle Park is in Shelburne — so an event with an address that places nowhere
  // in Simcoe is dropped here, as the CitySpark and Eventbrite adapters do. One with no
  // address at all is kept: it is usually local and simply unspecific.
  if (source.municipalitySlug !== null) return mapped
  return mapped.filter((e) => !e.address || resolveMunicipality(e.municipalityHint, e.address, e.venueName) !== null)
}
