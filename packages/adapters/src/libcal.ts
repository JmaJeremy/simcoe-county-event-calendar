import { fetchIcsFeeds } from './ics.ts'
import type { RawEvent, Source, SyncWindow } from '@scec/core'

/**
 * Springshare LibCal, read through the iCal feed it publishes for each calendar.
 *
 * LibCal's JSON API needs a key the library holds, but every calendar has a public
 * subscribe feed. The events in it are already expanded — no RRULE in any of ours — and
 * each carries `UID: LibCal-{cid}-{event}`, the stable per-occurrence id reconciliation
 * wants, plus its own URL. A library publishes several calendars (Springwater: children's,
 * adult, teen), so a source lists the ids it wants.
 */

export const libcalIcalUrl = (host: string, calendarId: number): string =>
  `https://${host}/ical_subscribe.php?src=p&cid=${calendarId}`

export async function fetchLibcal(source: Source, window: SyncWindow): Promise<RawEvent[]> {
  const config = source.config
  if (config.platform !== 'libcal') throw new Error(`Source ${source.slug} is not a libcal source`)
  return fetchIcsFeeds(config.calendarIds.map((id) => libcalIcalUrl(config.host, id)), source, window)
}
