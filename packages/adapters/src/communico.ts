import { stripTags, truncate } from './html.ts'
import { getJson } from './http.ts'
import type { RawEvent, Source, SyncWindow } from '@scec/core'

/**
 * Communico, the events platform behind Barrie Public Library.
 *
 * The events page is a JavaScript app with no feed of its own, but the calendar it draws
 * calls one endpoint, found by watching the page in a browser: `/eeventcaldata`, with the
 * query as JSON in `req`. It takes a start date and a number of days, and answers the whole
 * span in one request — 848 events across 195 days, every one with its own id, its own page
 * and naive local start and end times.
 *
 * Learned from the live data (2026-09-16):
 *   - `event_type` is INPERSON or ONLINE. The 21 online ones happen nowhere in particular
 *     and are dropped, as online events are everywhere else here.
 *   - `location` is the branch (Downtown, Holly, Painswick), `venues` the room within it,
 *     and `venue_name` only appears when the library runs something at somebody else's
 *     address — a community centre, the college.
 *   - Every event has `registration_cost: "0"` and no billing: library programmes are free,
 *     and that is a structural statement, not a guess from the description.
 *   - `image` is a bare filename, served from /images/events/{tenant}/.
 */

export interface CommunicoEvent {
  id: string
  recurring_id?: string
  title: string
  sub_title?: string | null
  description?: string | null
  long_description?: string | null
  event_start: string
  event_end?: string | null
  event_type?: string
  private_event?: string
  location?: string | null
  venues?: string | null
  venue_name?: string | null
  venue_type?: string | null
  registration_cost?: string | null
  enable_billing?: string | null
  image?: string | null
  url?: string | null
  tagsArray?: string[]
  agesArray?: string[]
}

/** How many days of events one request asks for, inclusive of both ends. */
export const daysInWindow = (window: SyncWindow): number =>
  Math.round((Date.parse(`${window.to}T00:00:00Z`) - Date.parse(`${window.from}T00:00:00Z`)) / 86_400_000) + 1

export const communicoUrl = (host: string, window: SyncWindow): string => {
  const req = { private: false, date: window.from, days: daysInWindow(window), locations: [], ages: [], types: [], tags: [], isFeatured: false }
  return `https://${host}/eeventcaldata?event_type=0&req=${encodeURIComponent(JSON.stringify(req))}`
}

/** Images are served from the tenant's own folder, named after the subdomain. */
const imageUrl = (host: string, file: string | null | undefined): string | undefined =>
  file ? `https://${host}/images/events/${host.split('.')[0]}/${file}` : undefined

export interface CommunicoMapResult {
  events: RawEvent[]
  online: number
}

export function mapCommunicoEvents(host: string, rows: CommunicoEvent[]): CommunicoMapResult {
  const events: RawEvent[] = []
  let online = 0

  for (const e of rows) {
    if (e.private_event === '1') continue
    // Some online events are typed INPERSON but held at the "Online branch".
    if ((e.event_type && e.event_type !== 'INPERSON') || e.location?.trim().toLowerCase() === 'online') {
      online++
      continue
    }
    const branch = e.location?.trim() || undefined
    const external = e.venue_name?.trim() || undefined
    const description = e.long_description || e.description
    const free = e.registration_cost === '0' && e.enable_billing === '0'

    events.push({
      externalId: String(e.id),
      title: [e.title.trim(), e.sub_title?.trim()].filter(Boolean).join(' — '),
      description: description ? truncate(stripTags(description)) || undefined : undefined,
      localStart: e.event_start,
      localEnd: e.event_end || undefined,
      allDay: false,
      timePrecision: 'exact',
      /*
       * The branch, and never the room. Rooms are named after people and places — the
       * Downtown branch has an Angus Ross Room, and Angus is a hamlet in Essa — and every
       * name here is read by the gazetteer, which placed those events a township away.
       * The branch alone says where it is; the room says nothing a reader needs.
       */
      venueName: external ?? branch,
      // Branch names are Barrie's own; only an outside venue can say otherwise.
      municipalityHint: external,
      costText: free ? 'Free' : e.registration_cost ? `$${e.registration_cost}` : undefined,
      isFree: free ? true : undefined,
      categories: [...(e.tagsArray ?? []), ...(e.agesArray ?? [])].map((c) => c.trim()).filter(Boolean),
      imageUrl: imageUrl(host, e.image),
      url: e.url?.trim() || `https://${host}/event/${e.id}`,
      raw: e,
    })
  }
  return { events, online }
}

export async function fetchCommunico(source: Source, window: SyncWindow): Promise<RawEvent[]> {
  const config = source.config
  if (config.platform !== 'communico') throw new Error(`Source ${source.slug} is not a communico source`)

  const rows = await getJson<CommunicoEvent[]>(communicoUrl(config.host, window))
  if (!Array.isArray(rows)) throw new Error(`Communico ${config.host}: expected an array of events`)
  return mapCommunicoEvents(config.host, rows).events
}
