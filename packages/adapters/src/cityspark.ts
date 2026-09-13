import { resolveMunicipality, type RawEvent, type Source, type SyncWindow } from '@scec/core'
import { slugify, stripTags, truncate } from './html.ts'
import { postJson } from './http.ts'

/**
 * CitySpark — the calendar behind Metroland's simcoe.com/events.
 *
 * The portal page is a JS app over `POST /api/events/GetEvents/{portal}`; the request
 * body below is what the page itself sends (found in its bundle, PortalScripts/Simcoe).
 * A hundred events a page, `skip` to page, `Possible` is always 0 so we page until a
 * short page comes back.
 *
 * Two things learned from the live data:
 *   - The distance filter is decorative. A 75 km radius from Barrie returned Markham,
 *     Toronto and Bolton. So every row is placed with the gazetteer and anything outside
 *     the county is dropped HERE, not left for normalize to file under "no municipality".
 *   - `DateStart` is the LOCAL wall time wearing a bogus `Z`; `StartUTC` is the real
 *     instant and `StartLocal` is null. We take `DateStart` and strip the `Z`.
 */

export interface CitySparkEvent {
  PId: number
  Id: string
  Name: string
  DateStart: string
  DateEnd: string | null
  AllDay: boolean
  HasTime: boolean
  Free: boolean
  Price: number | null
  PriceHigh: number | null
  PriceText: string | null
  Venue: string | null
  Address: string | null
  CityState: string | null
  Zip: string | null
  PrimaryUrl: string | null
  TicketUrl: string | null
  Description: string | null
  MediumImg: string | null
  LargeImg?: string | null
  Labels?: string[]
}

export interface CitySparkResponse {
  Value: CitySparkEvent[] | null
  Success: boolean
  ErrorMessage: string | null
}

const PAGE_SIZE = 100
const MAX_PAGES = 15

export const citySparkUrl = (portal: string): string => `https://portal.cityspark.com/api/events/GetEvents/${portal}`

export function citySparkBody(config: { ppid: number; lat: number; lng: number; distanceKm: number }, window: SyncWindow, skip: number) {
  return {
    ppid: config.ppid,
    start: `${window.from}T00:00:00`,
    end: `${window.to}T23:59:59`,
    labels: [],
    pick: null,
    tps: null,
    sparks: null,
    sort: 'Date',
    category: null,
    distance: config.distanceKm,
    lat: config.lat,
    lng: config.lng,
    search: '',
    skip,
    defFilter: null,
  }
}

/** '2026-12-30T19:00:00Z' (a local time in disguise) → '2026-12-30T19:00'. */
const localOf = (value: string | null): string | undefined =>
  value ? value.replace(/Z$/, '').slice(0, 16) : undefined

const priceText = (e: CitySparkEvent): string | undefined => {
  if (e.PriceText?.trim()) return e.PriceText.trim()
  if (e.Free) return 'Free'
  if (typeof e.Price === 'number') {
    return e.PriceHigh && e.PriceHigh !== e.Price ? `$${e.Price}–$${e.PriceHigh}` : `$${e.Price}`
  }
  return undefined
}

export interface CitySparkMapResult {
  events: RawEvent[]
  outsideCounty: number
}

export function mapCitySparkEvents(portalHomepage: string, rows: CitySparkEvent[]): CitySparkMapResult {
  const events: RawEvent[] = []
  let outsideCounty = 0

  for (const e of rows) {
    const city = e.CityState?.replace(/,\s*ON$/i, '').trim() || undefined
    const municipality = resolveMunicipality(city, e.Address, e.Venue)
    if (!municipality) {
      outsideCounty++
      continue
    }
    const start = localOf(e.DateStart)
    if (!start) continue
    const hasTime = e.HasTime && !e.AllDay
    const address = [e.Address, e.CityState, e.Zip].filter((v): v is string => !!v?.trim()).join(', ')

    events.push({
      externalId: String(e.PId),
      title: e.Name.trim(),
      description: e.Description ? truncate(stripTags(e.Description)) || undefined : undefined,
      localStart: hasTime ? start : `${start.slice(0, 10)}T00:00`,
      localEnd: hasTime ? localOf(e.DateEnd) : undefined,
      allDay: !hasTime,
      timePrecision: hasTime ? 'exact' : 'date-only',
      venueName: e.Venue?.trim() || undefined,
      address: address || undefined,
      municipalityHint: city,
      costText: priceText(e),
      isFree: e.Free ? true : undefined,
      categories: [],
      imageUrl: e.LargeImg ?? e.MediumImg ?? undefined,
      // The portal's own detail route, so a reader lands on the listing rather than on
      // whatever third-party site the organiser linked.
      url: `${portalHomepage.replace(/\/$/, '')}/#/details/${slugify(e.Name)}/${e.PId}`,
      raw: e,
    })
  }
  return { events, outsideCounty }
}

export async function fetchCitySpark(source: Source, window: SyncWindow): Promise<RawEvent[]> {
  const config = source.config
  if (config.platform !== 'cityspark') throw new Error(`Source ${source.slug} is not a cityspark source`)

  const rows: CitySparkEvent[] = []
  const seen = new Set<number>()
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await postJson<CitySparkResponse>(citySparkUrl(config.portal), citySparkBody(config, window, page * PAGE_SIZE))
    if (!body.Success) throw new Error(`CitySpark ${config.portal}: ${body.ErrorMessage ?? 'request failed'}`)
    const value = body.Value ?? []
    let fresh = 0
    for (const row of value) {
      if (seen.has(row.PId)) continue
      seen.add(row.PId)
      rows.push(row)
      fresh++
    }
    // A short page, or a page of nothing new, is the end.
    if (value.length < PAGE_SIZE || fresh === 0) break
  }
  return mapCitySparkEvents(source.homepage, rows).events
}
