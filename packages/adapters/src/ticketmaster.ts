import { resolveMunicipality, type AdapterContext, type RawEvent, type Source, type SyncWindow } from '@scec/core'
import { stripTags, truncate } from './html.ts'
import { getJson } from './http.ts'

/**
 * Ticketmaster, through its public Discovery API.
 *
 * Only the consumer key is used, as `apikey=` in the query string. The consumer secret is
 * for OAuth flows this never makes, and is deliberately not configured on the worker.
 *
 * By venue, not by radius. A 60 km radius from downtown Barrie returned Casino Rama and
 * nothing in Barrie itself — the Barrie Colts' 33 home games at Sadlon Arena were missing,
 * though the venue has coordinates 6 km from the search point — while asking for the venue
 * by id returned every one. So the source carries each Ticketmaster venue the gazetteer
 * places in the county (TICKETMASTER_VENUES in core) and asks for their events together.
 *
 * The key rides in the URL, and an HttpError's message carries its URL into sync_runs, the
 * CLI and the Worker log. Every error leaving here has the key redacted.
 *
 * In September 2026 none of the 62 events on sale carried `priceRanges`. A Ticketmaster
 * event is a ticketed event, so all of them are paid: they show under "Paid only" and on
 * municipality pages, not in the default free view.
 */

const API = 'https://app.ticketmaster.com/discovery/v2/events.json'
/** Venue ids per request. All 63 fit in one URL; this leaves room for the list to grow. */
const VENUES_PER_REQUEST = 50
const PAGE_SIZE = 200
const MAX_PAGES = 5

export interface TicketmasterEvent {
  id: string
  name: string
  url: string
  test?: boolean
  info?: string
  pleaseNote?: string
  dates: {
    start: { localDate?: string; localTime?: string; dateTBA?: boolean; dateTBD?: boolean; timeTBA?: boolean; noSpecificTime?: boolean }
    status?: { code?: string }
  }
  priceRanges?: Array<{ min?: number; max?: number }>
  classifications?: Array<{ segment?: { name?: string }; genre?: { name?: string }; subGenre?: { name?: string } }>
  images?: Array<{ ratio?: string; width?: number; url: string }>
  _embedded?: { venues?: Array<{ name?: string; city?: { name?: string }; address?: { line1?: string }; postalCode?: string }> }
}

export interface TicketmasterPage {
  _embedded?: { events?: TicketmasterEvent[] }
  page?: { totalPages?: number; number?: number }
}

export const ticketmasterUrl = (apikey: string, venueIds: string[], window: SyncWindow, page: number): string =>
  `${API}?apikey=${encodeURIComponent(apikey)}&venueId=${venueIds.map(encodeURIComponent).join(',')}` +
  `&startDateTime=${window.from}T00:00:00Z&endDateTime=${window.to}T23:59:59Z&size=${PAGE_SIZE}&page=${page}&sort=date,asc&locale=*`

/** The key, wherever it turns up in a message. */
export const redactKey = (message: string, apikey: string): string =>
  message.replace(/apikey=[^&\s]*/gi, 'apikey=REDACTED').split(apikey).join('REDACTED')

const dollars = (n: number): string => `$${Number.isInteger(n) ? n : n.toFixed(2)}`

/** A wide image big enough for a share card, and no bigger than needed. */
function pickImage(images: TicketmasterEvent['images']): string | undefined {
  const all = images ?? []
  const wide = all.filter((i) => i.ratio === '16_9' && (i.width ?? 0) >= 1024).sort((a, b) => (a.width ?? 0) - (b.width ?? 0))
  return (wide[0] ?? [...all].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0])?.url
}

export interface TicketmasterMapResult {
  events: RawEvent[]
  outsideCounty: number
}

export function mapTicketmasterEvents(rows: TicketmasterEvent[]): TicketmasterMapResult {
  const events: RawEvent[] = []
  let outsideCounty = 0

  for (const e of rows) {
    const start = e.dates?.start ?? {}
    // Test listings, and events without a date yet, are nothing to put on a calendar.
    if (e.test || start.dateTBA || start.dateTBD || !start.localDate) continue
    const venue = e._embedded?.venues?.[0]
    const city = venue?.city?.name?.trim() || undefined
    if (!resolveMunicipality(city, venue?.address?.line1, venue?.name)) {
      outsideCounty++
      continue
    }

    const hasTime = !!start.localTime && !start.timeTBA && !start.noSpecificTime
    const status = e.dates.status?.code
    const price = e.priceRanges?.find((p) => typeof p.min === 'number' && p.min > 0)
    const address = [venue?.address?.line1, city, venue?.postalCode].filter((v): v is string => !!v?.trim()).join(', ')

    events.push({
      externalId: e.id,
      // Normalization reads a status out of the title, so Ticketmaster's travels there.
      title: `${status === 'cancelled' ? 'CANCELLED: ' : status === 'rescheduled' ? 'RESCHEDULED: ' : ''}${e.name.trim()}`,
      description: e.info ? truncate(stripTags(e.info)) || undefined : e.pleaseNote ? truncate(stripTags(e.pleaseNote)) || undefined : undefined,
      localStart: hasTime ? `${start.localDate}T${start.localTime!.slice(0, 5)}` : `${start.localDate}T00:00`,
      allDay: !hasTime,
      timePrecision: hasTime ? 'exact' : 'date-only',
      venueName: venue?.name?.trim() || undefined,
      address: address || undefined,
      municipalityHint: city,
      costText: price ? (price.max && price.max !== price.min ? `${dollars(price.min!)}–${dollars(price.max)}` : dollars(price.min!)) : undefined,
      isFree: false,
      categories: (e.classifications ?? [])
        .flatMap((c) => [c.segment?.name, c.genre?.name, c.subGenre?.name])
        .filter((name): name is string => !!name && name !== 'Undefined'),
      imageUrl: pickImage(e.images),
      url: e.url,
      raw: e,
    })
  }
  return { events, outsideCounty }
}

export async function fetchTicketmaster(source: Source, window: SyncWindow, context?: AdapterContext): Promise<RawEvent[]> {
  const config = source.config
  if (config.platform !== 'ticketmaster') throw new Error(`Source ${source.slug} is not a ticketmaster source`)
  const apikey = context?.secrets.TICKETMASTER_CONSUMER_KEY
  if (!apikey) throw new Error('Ticketmaster needs TICKETMASTER_CONSUMER_KEY, and none is configured')

  const rows: TicketmasterEvent[] = []
  const seen = new Set<string>()
  try {
    for (let i = 0; i < config.venueIds.length; i += VENUES_PER_REQUEST) {
      const venueIds = config.venueIds.slice(i, i + VENUES_PER_REQUEST)
      for (let page = 0; page < MAX_PAGES; page++) {
        const body = await getJson<TicketmasterPage>(ticketmasterUrl(apikey, venueIds, window, page))
        for (const row of body._embedded?.events ?? []) {
          if (seen.has(row.id)) continue
          seen.add(row.id)
          rows.push(row)
        }
        if (page + 1 >= (body.page?.totalPages ?? 1)) break
      }
    }
  } catch (err) {
    throw new Error(redactKey(err instanceof Error ? err.message : String(err), apikey))
  }
  return mapTicketmasterEvents(rows).events
}
