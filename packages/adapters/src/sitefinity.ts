import { stripTags, truncate } from './html.ts'
import { getJson } from './http.ts'
import { splitLocation } from './ics.ts'
import type { RawEvent, Source, SyncWindow } from '@scec/core'

/**
 * Progress Sitefinity, the CMS behind Tourism Barrie, read through its Events module's
 * public OData service: `/api/default/events`. JSON, no key, one request per hundred
 * events — the service refuses `$top` above 100 with a 400, so it is paged with `$skip`.
 *
 * Learned from the live data (255 events on record, 2026-09-18):
 *   - `EventStartWithOffset` is the local wall clock with a meaningless `Z` on it, and is
 *     right for every event. `EventStart` is only UTC for entries saved in Eastern time;
 *     seven of the hundred upcoming were saved with TimeZoneId "UTC" and offset 0, and for
 *     those `EventStart` IS the wall clock as typed. Reading it as an instant would open
 *     Doors Open Barrie at 6:00.
 *   - An all-day event ends at midnight the morning after, as in iCal (42 on record).
 *   - A time of 00:00 on an event that is not all-day means no time was given ("Culture
 *     Days", Sep 18 00:00 to Oct 4 23:00), not a midnight start.
 *   - Most listings are spans — 55 of 100, many season-long (Pumpkin Mania, Sep 19 to
 *     Oct 25). Anything not yet over is kept, so a festival already under way still shows.
 *   - `DisplayTimeOnEventDetails` is off for nearly all of them and is only a display
 *     switch: the times are real.
 *   - `Street` often starts with the venue ("Rounds Ranch, 1922 County Road 92") and
 *     `City` is free text, blank for 7 of 100. `Location` is only filled for a few.
 *   - The service can describe a recurring event (`IsRecurrent`, `RecurrenceExpression`);
 *     none of the 255 ever has been. One would need expanding, so it throws rather than
 *     quietly keep only the first date.
 */

export interface SitefinityEvent {
  Id: string
  Title: string
  Content?: string | null
  Summary?: string | null
  Description?: string | null
  EventStart: string
  EventEnd?: string | null
  EventStartWithOffset: string
  EventEndWithOffset?: string | null
  AllDayEvent?: boolean
  IsRecurrent?: boolean
  RecurrenceExpression?: string | null
  Location?: string | null
  Street?: string | null
  City?: string | null
  Admission?: string | null
  ContactName?: string | null
  ContactWeb?: string | null
  ImagePath?: string | null
  ItemDefaultUrl: string
}

interface ODataPage {
  value?: SitefinityEvent[]
}

/** The service's own ceiling; a request for more is refused. */
export const SITEFINITY_PAGE = 100

export function sitefinityUrl(origin: string, window: SyncWindow, skip: number): string {
  const params = new URLSearchParams({
    $top: String(SITEFINITY_PAGE),
    $skip: String(skip),
    // Not over yet, and starting inside the window. The stored times are an hour or four
    // off for some entries (see above), which only loosens the edges by a few hours.
    $filter: `EventEnd ge ${window.from}T00:00:00Z and EventStart le ${window.to}T23:59:59Z`,
    $orderby: 'EventStart',
  })
  return `${origin}/api/default/events?${params}`
}

/** '2026-09-19T10:00:00Z' → '2026-09-19T10:00': the wall clock, without the stray zone. */
const wall = (value: string): string => value.slice(0, 16)

const dayBefore = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

export function mapSitefinityEvents(origin: string, detailPath: string, rows: SitefinityEvent[]): RawEvent[] {
  return rows.map((e) => {
    if (e.IsRecurrent || e.RecurrenceExpression) {
      throw new Error(
        `Sitefinity ${origin}: "${e.Title}" (${e.Id}) is a recurring event, which this adapter does not expand yet`,
      )
    }
    const start = wall(e.EventStartWithOffset)
    const end = e.EventEndWithOffset ? wall(e.EventEndWithOffset) : undefined
    const untimed = e.AllDayEvent || start.endsWith('T00:00')

    let localEnd = end
    // An all-day event's end is the midnight after its last day.
    if (e.AllDayEvent && end?.endsWith('T00:00')) localEnd = `${dayBefore(end.slice(0, 10))}T23:59`
    if (localEnd && localEnd <= start) localEnd = undefined

    const city = e.City?.trim() || undefined
    const place = splitLocation([e.Location, e.Street, city].map((p) => p?.trim()).filter(Boolean).join(', '))
    const text = e.Content || e.Summary || e.Description
    const admission = e.Admission?.trim() || undefined

    return {
      externalId: e.Id,
      title: e.Title.trim(),
      description: text ? truncate(stripTags(text)) || undefined : undefined,
      localStart: untimed ? `${start.slice(0, 10)}T00:00` : start,
      localEnd,
      allDay: untimed,
      timePrecision: untimed ? 'date-only' : 'exact',
      venueName: place.venueName,
      address: place.address,
      municipalityHint: city,
      costText: admission,
      categories: [],
      organizer: e.ContactName?.trim() || undefined,
      imageUrl: e.ImagePath?.startsWith('https://') ? e.ImagePath : undefined,
      url: `${origin}${detailPath}${e.ItemDefaultUrl}`,
      raw: e,
    } satisfies RawEvent
  })
}

export async function fetchSitefinity(source: Source, window: SyncWindow): Promise<RawEvent[]> {
  const config = source.config
  if (config.platform !== 'sitefinity') throw new Error(`Source ${source.slug} is not a sitefinity source`)

  const rows: SitefinityEvent[] = []
  // A hard stop well past anything seen, so a service that ignores $skip cannot loop forever.
  for (let skip = 0; skip < 20 * SITEFINITY_PAGE; skip += SITEFINITY_PAGE) {
    const page = await getJson<ODataPage>(sitefinityUrl(config.origin, window, skip))
    if (!Array.isArray(page.value)) throw new Error(`Sitefinity ${config.origin}: expected an OData "value" array`)
    rows.push(...page.value)
    if (page.value.length < SITEFINITY_PAGE) break
  }
  return mapSitefinityEvents(config.origin, config.detailPath, rows)
}
