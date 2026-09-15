import { resolveMunicipality, type AdapterContext, type RawEvent, type Source, type SyncWindow } from '@scec/core'
import { stripTags, truncate } from './html.ts'
import { request } from './http.ts'

/**
 * Eventbrite, through the search eventbrite.com's own pages call.
 *
 * The documented search, `GET /v3/events/search/`, was removed from Eventbrite's public API
 * in 2020 and answers 404. `POST /v3/destination/search/` is what the site uses: it takes
 * the same OAuth token as the documented endpoints and a bounding box, and answers JSON —
 * an API call, not scraping — but it is not in the published reference and can change
 * without notice. If it does, this throws and the source reports FAIL; it never quietly
 * returns an empty calendar.
 *
 * Learned from the live data (2026-09-15):
 *   - `page_size` is capped at 50 whatever is asked; pages follow a `continuation` token.
 *     The box around the county held 618 upcoming events, so 13 requests.
 *   - Only `dates: 'current_future'` is accepted — an explicit range is an ARGUMENTS_ERROR —
 *     so the window's far end is applied here, and past days never come back.
 *   - The box reaches Newmarket, Aurora and Shelburne: 348 of the 618 were in the county.
 *     Rows are placed with the gazetteer and the rest dropped HERE, as CitySpark's are.
 *   - `summary` is the only description on offer; expanding `full_description` is a 500.
 *   - Times are naive local strings in the event's own zone, which is what normalize wants.
 *   - `ticket_availability.is_free` is structural: 191 free, 157 paid.
 */

export const EVENTBRITE_SEARCH_URL = 'https://www.eventbriteapi.com/v3/destination/search/'
const MAX_PAGES = 30

interface Money {
  major_value?: string | null
}

export interface EventbriteEvent {
  id: string
  name: string
  url: string
  summary?: string | null
  start_date: string
  start_time?: string | null
  end_date?: string | null
  end_time?: string | null
  is_cancelled?: boolean | null
  is_online_event?: boolean | null
  hide_start_date?: boolean | null
  primary_venue?: {
    name?: string | null
    address?: { address_1?: string | null; city?: string | null; localized_address_display?: string | null } | null
  } | null
  image?: { url?: string | null; image_sizes?: { large?: string | null } | null } | null
  ticket_availability?: { is_free?: boolean | null; minimum_ticket_price?: Money | null; maximum_ticket_price?: Money | null } | null
  tags?: Array<{ prefix?: string; display_name?: string }>
}

export interface EventbriteSearchResponse {
  events?: { results?: EventbriteEvent[]; pagination?: { object_count?: number; continuation?: string | null } }
}

export function eventbriteBody(bbox: string, continuation?: string) {
  return {
    event_search: { bbox, dates: 'current_future', page_size: 50, online_events_only: false, ...(continuation ? { continuation } : {}) },
    'expand.destination_event': ['primary_venue', 'image', 'ticket_availability'],
    browse_surface: 'search',
  }
}

/** '30.00' → '$30', '12.50' → '$12.50'. Every event here is priced in CAD. */
const dollars = (money: Money | null | undefined): string | undefined => {
  const value = money?.major_value?.trim()
  return value ? `$${value.replace(/\.00$/, '')}` : undefined
}

export interface EventbriteMapResult {
  events: RawEvent[]
  outsideCounty: number
}

export function mapEventbriteEvents(rows: EventbriteEvent[], window: SyncWindow): EventbriteMapResult {
  const events: RawEvent[] = []
  let outsideCounty = 0

  for (const e of rows) {
    // An online event happens nowhere in particular, and a date past the window is next
    // year's business.
    if (e.is_online_event || !e.start_date || e.start_date > window.to) continue
    const venue = e.primary_venue ?? undefined
    const city = venue?.address?.city?.trim() || undefined
    const address = venue?.address?.localized_address_display?.trim() || undefined
    if (!resolveMunicipality(city, venue?.address?.address_1, address, venue?.name)) {
      outsideCounty++
      continue
    }

    const hasTime = !!e.start_time && !e.hide_start_date
    let localEnd: string | undefined
    if (hasTime && e.end_date && e.end_time) localEnd = `${e.end_date}T${e.end_time.slice(0, 5)}`
    else if (!hasTime && e.end_date && e.end_date !== e.start_date) localEnd = `${e.end_date}T23:59`

    const tickets = e.ticket_availability ?? undefined
    const low = dollars(tickets?.minimum_ticket_price)
    const high = dollars(tickets?.maximum_ticket_price)
    const costText = tickets?.is_free ? 'Free' : low ? (high && high !== low ? `${low}–${high}` : low) : undefined

    events.push({
      externalId: String(e.id),
      // Normalization reads a status out of the title, so a cancellation travels there.
      title: `${e.is_cancelled ? 'CANCELLED: ' : ''}${e.name.trim()}`,
      description: e.summary ? truncate(stripTags(e.summary)) || undefined : undefined,
      localStart: hasTime ? `${e.start_date}T${e.start_time!.slice(0, 5)}` : `${e.start_date}T00:00`,
      localEnd,
      allDay: !hasTime,
      timePrecision: hasTime ? 'exact' : 'date-only',
      venueName: venue?.name?.trim() || undefined,
      address,
      municipalityHint: city,
      costText,
      // Structural, unlike most sources: a paid ticket is a paid event.
      isFree: tickets && typeof tickets.is_free === 'boolean' ? tickets.is_free : undefined,
      categories: (e.tags ?? [])
        .filter((t) => t.prefix === 'EventbriteCategory' || t.prefix === 'EventbriteSubCategory')
        .map((t) => t.display_name ?? '')
        .filter(Boolean),
      imageUrl: e.image?.image_sizes?.large ?? e.image?.url ?? undefined,
      url: e.url,
      raw: e,
    })
  }
  return { events, outsideCounty }
}

export async function fetchEventbrite(source: Source, window: SyncWindow, context?: AdapterContext): Promise<RawEvent[]> {
  const config = source.config
  if (config.platform !== 'eventbrite') throw new Error(`Source ${source.slug} is not an eventbrite source`)
  const token = context?.secrets.EVENTBRITE_TOKEN
  if (!token) throw new Error('Eventbrite needs EVENTBRITE_TOKEN, and none is configured')

  const rows: EventbriteEvent[] = []
  const seen = new Set<string>()
  let continuation: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const text = await request(EVENTBRITE_SEARCH_URL, {
      method: 'POST',
      body: JSON.stringify(eventbriteBody(config.bbox, continuation)),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    })
    let body: EventbriteSearchResponse
    try {
      body = JSON.parse(text) as EventbriteSearchResponse
    } catch {
      throw new Error('Eventbrite search answered something that is not JSON')
    }
    const results = body.events?.results
    if (!Array.isArray(results)) throw new Error('Eventbrite search answered without events.results; the endpoint may have changed')
    for (const row of results) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      rows.push(row)
    }
    continuation = body.events?.pagination?.continuation ?? undefined
    if (!continuation || results.length === 0) break
  }
  return mapEventbriteEvents(rows, window).events
}
