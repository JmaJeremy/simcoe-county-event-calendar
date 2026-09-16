import { shiftDate, toWallClock, type RawEvent, type Source, type SyncWindow } from '@scec/core'
import { parseIcs, type IcsMoment } from './ical-read.ts'
import { truncate } from './html.ts'
import { request } from './http.ts'

/**
 * Any published iCalendar feed, as a source.
 *
 * Libraries and venues hand out .ics readily — LibCal one per calendar, Tockify one per
 * board — so the mapping lives here and the platforms that build their own addresses
 * (libcal.ts) call it. Times arrive as UTC instants and are converted to Simcoe County wall
 * time once, here, as normalize expects; an all-day event's DTEND is the morning after it
 * finishes, so it is pulled back to the last day it is really on.
 */

/** Where feeds put an event's picture, in the absence of a standard property for one. */
const IMAGE_PROPERTIES = ['X-TKF-FEATURED-IMAGE', 'X-IMAGE', 'X-GOOGLE-CALENDAR-IMAGE']

/** A published moment as the naive local wall string the rest of the pipeline uses. */
const wallOf = (moment: IcsMoment, timeZone: string): string =>
  moment.kind === 'utc' ? toWallClock(new Date(`${moment.value}:00Z`), timeZone) : moment.value

/**
 * LOCATION is free text, and feeds fill it differently: LibCal writes a branch name,
 * Tockify a room followed by the whole street address. A street number in the rest is what
 * separates the two, and an address is worth having — an event page without one is an error
 * to Google, not a warning.
 */
export function splitLocation(location: string | undefined): { venueName?: string; address?: string } {
  const text = location?.trim()
  if (!text) return {}
  const [first, ...rest] = text.split(',').map((part) => part.trim())
  const remainder = rest.join(', ')
  return /\d/.test(remainder) ? { venueName: first || undefined, address: text } : { venueName: text }
}

export interface IcsMapResult {
  events: RawEvent[]
  skippedOutsideWindow: number
}

export function mapIcsEvents(ics: string, window: SyncWindow, timeZone: string): IcsMapResult {
  const events: RawEvent[] = []
  let skippedOutsideWindow = 0

  for (const event of parseIcs(ics)) {
    const allDay = event.start.kind === 'date'
    const start = wallOf(event.start, timeZone)
    const localStart = allDay ? `${start}T00:00` : start
    const date = localStart.slice(0, 10)
    // The feed runs months past our window at both ends; the window is what we keep.
    if (date < window.from || date > window.to) {
      skippedOutsideWindow++
      continue
    }

    const place = splitLocation(event.location)
    let localEnd: string | undefined
    if (event.end) {
      const end = wallOf(event.end, timeZone)
      // An all-day event's DTEND is the morning after it finishes.
      localEnd = allDay ? `${shiftDate(end, -1)}T23:59` : end
    }

    events.push({
      externalId: event.uid,
      title: event.summary ?? 'Untitled event',
      description: event.description ? truncate(event.description) || undefined : undefined,
      localStart,
      localEnd,
      allDay,
      timePrecision: allDay ? 'date-only' : 'exact',
      venueName: place.venueName,
      address: place.address,
      municipalityHint: event.location || undefined,
      categories: event.categories,
      imageUrl: IMAGE_PROPERTIES.map((p) => event.extra[p]).find((v) => v?.startsWith('https://')),
      url: event.url ?? '',
      raw: event,
    })
  }
  return { events, skippedOutsideWindow }
}

export async function fetchIcs(source: Source, window: SyncWindow): Promise<RawEvent[]> {
  const config = source.config
  if (config.platform !== 'ics') throw new Error(`Source ${source.slug} is not an ics source`)
  return fetchIcsFeeds(config.urls, source, window)
}

/** Fetch each feed, map it, and keep one copy of an event listed on two of them. */
export async function fetchIcsFeeds(urls: string[], source: Source, window: SyncWindow): Promise<RawEvent[]> {
  const events: RawEvent[] = []
  const seen = new Set<string>()
  for (const url of urls) {
    const ics = await request(url, { headers: { Accept: 'text/calendar' } })
    if (!ics.includes('BEGIN:VCALENDAR')) throw new Error(`${url}: not an iCalendar feed`)
    for (const event of mapIcsEvents(ics, window, source.timezone).events) {
      if (seen.has(event.externalId)) continue
      seen.add(event.externalId)
      events.push(event)
    }
  }
  return events
}
