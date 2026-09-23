import { decodeEntities, stripTags, truncate } from './html.ts'
import { request } from './http.ts'
import type { RawEvent, Source, SyncWindow } from '@scec/core'

/**
 * GrowthZone / ChamberMaster, the platform most chambers of commerce run on, read through
 * the XML its own calendar widget calls: `/api/events` on the `business.` host. Structured
 * data, no key, one request for everything — the Barrie chamber returned 149 events
 * reaching to 2028 in a single 220KB response.
 *
 * Unpublished, like Eventbrite's search: it is what the site itself uses, not a documented
 * API, so the adapter throws on a shape it does not recognise rather than quietly return
 * nothing.
 *
 * Learned from the live feed (2026-09-23):
 *   - **Only `APPROVED` is a real event.** Of 149 records, 137 were `PENDING` and those
 *     were three series auto-generated to 2028 between them — 104 copies of a weekly
 *     networking night at one restaurant, 24 of a monthly coworking day. Not one carried a
 *     description, a location or an admission. The 12 `APPROVED` are the curated ones: the
 *     Santa Claus Parade, Pet Palooza, the Women's Show, a YMCA block party.
 *   - A series is already expanded, one `EventID` per occurrence (the holiday market is ten
 *     rows), so `Recurrence` is metadata about the series and never needs expanding here.
 *   - `EventID` survives an edit, so it is the identity — unlike the slug, which carries
 *     the date on repeating events.
 *   - `StartDate`/`EndDate` are naive local wall clocks, which is what normalization wants.
 *   - The `URL` field is the organiser's own site (a greenhouse's shop page), NOT the
 *     event. The event's page is `/events/details/{Slug}-{EventID}`.
 *   - `LocationDesc` is pasted HTML with inline styles; `MapAddr1`/`MapCity` are clean.
 *   - `ContactEmail` is a real person's address and is never read. Nothing this adapter
 *     returns may carry one — see `no-email.test.ts`, which scans everything served.
 */

export interface GrowthZoneEvent {
  EventID: string
  Name: string
  Status: string
  StartDate: string
  EndDate?: string
  IsAllDayEvent?: string
  Slug: string
  Description?: string
  LocationDesc?: string
  MapAddr1?: string
  MapCity?: string
  AdmissionDesc?: string
  ContactDesc?: string
}

const FIELD = (record: string, tag: string): string | undefined => {
  const match = record.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  return match ? decodeEntities(match[1]!) : undefined
}

/** '<h3>FREE</h3>' and '4346 Highway 90,&nbsp;Springwater' both come back as plain text. */
const plain = (value: string | undefined): string | undefined => {
  if (!value) return undefined
  const text = stripTags(value).replace(/ /g, ' ').replace(/\s+/g, ' ').trim()
  return text.length > 0 ? text : undefined
}

/**
 * What it costs to attend — not what it costs to take part.
 *
 * The Barrie Santa Claus Parade's admission reads "FLOAT ENTRIES are: $250 Non-Member,
 * commercial businesses", which is the fee to put a float in the parade. Watching is free,
 * and taken at face value that text marks the biggest free event of Barrie's year as paid,
 * which drops it out of the view almost everyone uses. A vendor's or entrant's fee is not
 * an admission, so it is not returned at all and the cost stays unknown.
 *
 * "Free to Chamber Members" is dropped for the mirror of that reason: read plainly it says
 * free, and it means free for some and unstated for everyone else.
 */
const PARTICIPATION_FEE = /\b(float|vendor|booth|table|exhibitor|sponsor|entrant)s?\b.{0,20}\b(entr|fee|rate|cost|price)|entry fee/i
const MEMBERS_ONLY_FREE = /\bfree\b[^.]{0,30}\b(members?|membership)\b/i

const admission = (value: string | undefined): string | undefined => {
  const text = plain(value)
  if (!text || /^n\/?a$/i.test(text)) return undefined
  if (PARTICIPATION_FEE.test(text) || MEMBERS_ONLY_FREE.test(text)) return undefined
  return text
}

/** '2026-10-04T11:00:00' → '2026-10-04T11:00'. Already local; nothing to convert. */
const wall = (value: string): string => value.slice(0, 16)

export function mapGrowthZoneEvents(origin: string, xml: string, window?: SyncWindow): RawEvent[] {
  if (!xml.includes('<ArrayOfEventDisplay')) {
    throw new Error(`GrowthZone ${origin}: expected an ArrayOfEventDisplay document`)
  }
  const records = xml.match(/<EventDisplay[\s\S]*?<\/EventDisplay>/g) ?? []
  const events: RawEvent[] = []

  for (const record of records) {
    if (FIELD(record, 'Status')?.trim() !== 'APPROVED') continue
    const id = FIELD(record, 'EventID')?.trim()
    const name = plain(FIELD(record, 'Name'))
    const start = FIELD(record, 'StartDate')?.trim()
    const slug = FIELD(record, 'Slug')?.trim()
    if (!id || !name || !start || !slug) continue

    const localStart = wall(start)
    if (window && (localStart.slice(0, 10) < window.from || localStart.slice(0, 10) > window.to)) continue

    const end = FIELD(record, 'EndDate')?.trim()
    const localEnd = end ? wall(end) : undefined
    const allDay = FIELD(record, 'IsAllDayEvent')?.trim() === 'true'
    const city = plain(FIELD(record, 'MapCity'))
    const street = plain(FIELD(record, 'MapAddr1'))
    // The mapped address when there is one, because LocationDesc is pasted HTML; its text
    // otherwise, which is often the same address typed out.
    const address = street ? [street, city].filter(Boolean).join(', ') : plain(FIELD(record, 'LocationDesc'))
    const description = plain(FIELD(record, 'Description'))

    events.push({
      externalId: id,
      title: name,
      description: description ? truncate(description) || undefined : undefined,
      localStart: allDay ? `${localStart.slice(0, 10)}T00:00` : localStart,
      localEnd: localEnd && localEnd > localStart ? localEnd : undefined,
      allDay,
      timePrecision: allDay ? 'date-only' : 'exact',
      address,
      municipalityHint: city,
      costText: admission(FIELD(record, 'AdmissionDesc')),
      categories: [],
      organizer: plain(FIELD(record, 'ContactDesc')),
      url: `${origin}/events/details/${slug}-${id}`,
      raw: { id, slug },
    } satisfies RawEvent)
  }
  return events
}

export async function fetchGrowthZone(source: Source, window: SyncWindow): Promise<RawEvent[]> {
  const config = source.config
  if (config.platform !== 'growthzone') throw new Error(`Source ${source.slug} is not a growthzone source`)
  const xml = await request(`${config.origin}/api/events`)
  return mapGrowthZoneEvents(config.origin, xml, window)
}
