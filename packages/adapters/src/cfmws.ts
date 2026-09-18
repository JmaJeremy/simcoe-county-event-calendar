import { request } from './http.ts'
import type { RawEvent, Source, SyncWindow } from '@scec/core'

/**
 * CFMWS (Canadian Forces Morale and Welfare Services) base pages, such as CFB Borden's.
 *
 * The site is Kentico, and its events widget draws from a JSON array the page itself
 * declares as `var loadedData = [...]`. The "Load more" button only pages through that
 * array in the browser; with `loadedData` present the script never asks the server for
 * more, so the page holds the whole list.
 *
 * Learned from the live data (2026-09-18, Borden): 9 events, of which 7 were online —
 * national Teams webinars listed on every base's page — and are dropped, as online events
 * are everywhere here. Times read "2026-10-23 6:15:11 p.m.", with seconds that are an
 * artefact of the editor and are ignored. There is no description in the data.
 */

export interface CfmwsEvent {
  event_name: string
  event_multidayevent?: boolean
  event_startdate: string
  event_enddate?: string | null
  event_recurrence?: string | null
  event_location?: string | null
  event_virtual?: boolean
  event_demo?: string | null
  event_externalurl?: string | null
  event_cta_link?: string | null
}

/** The array assigned to `loadedData`, cut out by bracket depth rather than a regex. */
export function extractLoadedData(html: string): CfmwsEvent[] {
  const at = html.indexOf('var loadedData')
  if (at < 0) throw new Error('CFMWS page: no loadedData array (template changed?)')
  const start = html.indexOf('[', at)
  let depth = 0
  let inString = false
  for (let i = start; i < html.length; i++) {
    const c = html[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') {
      depth--
      if (depth === 0) return JSON.parse(html.slice(start, i + 1)) as CfmwsEvent[]
    }
  }
  throw new Error('CFMWS page: loadedData array never closes')
}

/** '2026-10-23 6:15:11 p.m.' → '2026-10-23T18:15'. */
export function cfmwsWallTime(value: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])\.?m\.?$/i.exec(value.trim())
  if (!m) throw new Error(`CFMWS: unreadable time "${value}"`)
  const [, date, h, min, half] = m
  const hour = (Number(h) % 12) + (half!.toLowerCase() === 'p' ? 12 : 0)
  return `${date}T${String(hour).padStart(2, '0')}:${min}`
}

export function mapCfmwsEvents(origin: string, place: string, rows: CfmwsEvent[], window: SyncWindow): RawEvent[] {
  const events: RawEvent[] = []
  for (const e of rows) {
    if (e.event_virtual) continue
    if (e.event_recurrence && e.event_recurrence !== 'None') {
      throw new Error(`CFMWS: "${e.event_name}" recurs (${e.event_recurrence}), which this adapter does not expand yet`)
    }
    const localStart = cfmwsWallTime(e.event_startdate)
    const date = localStart.slice(0, 10)
    if (date < window.from || date > window.to) continue
    const localEnd = e.event_enddate ? cfmwsWallTime(e.event_enddate) : undefined
    const path = e.event_externalurl?.trim() || e.event_cta_link?.trim() || ''
    const location = e.event_location?.trim()
    events.push({
      // The page's own URL slug is the only stable key the data carries.
      externalId: `${path || e.event_name}@${date}`,
      title: e.event_name.trim(),
      localStart,
      localEnd: localEnd && localEnd > localStart ? localEnd : undefined,
      allDay: false,
      timePrecision: 'exact',
      venueName: location || place,
      municipalityHint: place,
      categories: e.event_demo && e.event_demo !== 'All' ? [e.event_demo] : [],
      url: path.startsWith('http') ? path : `${origin}${path}`,
      raw: e,
    })
  }
  return events
}

export async function fetchCfmws(source: Source, window: SyncWindow): Promise<RawEvent[]> {
  const config = source.config
  if (config.platform !== 'cfmws') throw new Error(`Source ${source.slug} is not a cfmws source`)
  const html = await request(`${config.origin}${config.eventsPath}`)
  return mapCfmwsEvents(config.origin, config.place, extractLoadedData(html), window)
}
