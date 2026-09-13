import type { RawEvent, Source, SyncWindow } from '@scec/core'
import { stripTags, truncate } from './html.ts'
import { getJson } from './http.ts'

/**
 * WordPress "The Events Calendar" (Modern Tribe) REST API — New Tecumseth.
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
  return out
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

  return mapTribeEvents(events)
}
