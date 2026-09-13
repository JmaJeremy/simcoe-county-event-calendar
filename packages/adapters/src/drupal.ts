import { toWallClock, type RawEvent, type Source, type SyncWindow } from '@scec/core'
import { absolute, decodeEntities, textOf } from './html.ts'
import { request } from './http.ts'

/**
 * Drupal event views — Barrie, Innisfil, Collingwood, Tiny and Clearview all run the same
 * Upanup-built Drupal theme, but their events pages come in two shapes:
 *
 *   - `fullcalendar`: the page is a FullCalendar widget, and the Drupal FullCalendar View
 *     module embeds EVERY event as JSON inside `drupalSettings` (Barrie: 392, Tiny: 1,081
 *     back to 2021, Clearview: 82). One request, no HTML parsing, a per-occurrence id
 *     (`eid` = node id + delta), naive local `start`/`end` in the site's zone, `allDay`.
 *   - `rows`: a rendered list (`.views-row` with `<time datetime>`), all on one page
 *     (Innisfil: 237, Collingwood: 179). The node path names the FIRST occurrence only, so
 *     the id is `path@datetime`.
 *
 * Neither shape carries an address, cost or category; the node page does, but fetching
 * hundreds of them per run is not worth it for launch. The source's municipality covers
 * placement, and the title carries cost words when organisers care to say.
 */

interface FullCalendarEvent {
  title: string
  eid?: string
  url: string
  /** Naive local ISO, a bare date, or (Clearview's recurring instances) epoch seconds. */
  start: string | number
  end?: string | number | null
  allDay?: boolean
  des?: string
}

const SETTINGS = /<script type="application\/json" data-drupal-selector="drupal-settings-json">([\s\S]*?)<\/script>/

export function parseFullCalendar(html: string): FullCalendarEvent[] {
  const json = SETTINGS.exec(html)?.[1]
  if (!json) throw new Error('No drupalSettings block on the page')
  const settings = JSON.parse(json) as { fullCalendarView?: Array<{ calendar_options?: string | { events?: FullCalendarEvent[] } }> }
  const view = settings.fullCalendarView?.[0]
  if (!view) throw new Error('drupalSettings has no fullCalendarView — the page is not a FullCalendar view')
  const options = typeof view.calendar_options === 'string' ? (JSON.parse(view.calendar_options) as { events?: FullCalendarEvent[] }) : view.calendar_options
  return options?.events ?? []
}

/**
 * 'YYYY-MM-DDTHH:mm:ss' | 'YYYY-MM-DD' | epoch seconds → 'YYYY-MM-DDTHH:mm'. A bare date
 * gets midnight; epoch values (Clearview's repeating-rule instances) are rendered in the
 * site's zone.
 */
const wall = (value: string | number, timezone: string): string =>
  typeof value === 'number' ? toWallClock(value * 1000, timezone) : value.length === 10 ? `${value}T00:00` : value.slice(0, 16)

export function mapFullCalendar(origin: string, events: FullCalendarEvent[], window: SyncWindow, timezone = 'America/Toronto'): RawEvent[] {
  const out: RawEvent[] = []
  for (const e of events) {
    if (!e.start || !e.url) continue
    const localStart = wall(e.start, timezone)
    const date = localStart.slice(0, 10)
    if (date < window.from || date > window.to) continue
    const allDay = e.allDay === true || (typeof e.start === 'string' && e.start.length === 10)
    // FullCalendar's all-day end is EXCLUSIVE (the day after); a same-day all-day event
    // has end = start + 1 day. Keep multi-day spans, drop the phantom extra day.
    let localEnd: string | undefined
    if (e.end) {
      const endWall = wall(e.end, timezone)
      if (allDay) {
        const endDate = new Date(`${endWall.slice(0, 10)}T00:00:00Z`)
        endDate.setUTCDate(endDate.getUTCDate() - 1)
        const last = endDate.toISOString().slice(0, 10)
        localEnd = last > date ? `${last}T23:59` : undefined
      } else {
        localEnd = endWall
      }
    }
    // Clearview appends "<br><span class="fc-time">All Day</span>" to titles.
    const title = textOf(e.title.replace(/<span class="fc-time">[\s\S]*?<\/span>/g, ' '))
    const path = decodeEntities(e.url)

    out.push({
      externalId: e.eid?.trim() ? e.eid.trim() : `${path}@${localStart}`,
      title,
      localStart,
      localEnd,
      allDay,
      timePrecision: allDay ? 'date-only' : 'exact',
      categories: [],
      url: absolute(origin, path),
      raw: e,
    })
  }
  return out
}

const ROW = /<div class="views-row"[^>]*>([\s\S]*?)(?=<div class="views-row"|<div class="calendar-date-group"|<\/div>\s*<\/div>\s*<\/div>\s*<div class="view-footer|$)/g

export function parseRows(html: string): Array<{ path: string; title: string; start: string; end?: string }> {
  const rows: Array<{ path: string; title: string; start: string; end?: string }> = []
  const viewStart = html.search(/view-id-(calendar_events|calendar_view|events_calendar)/)
  const scope = viewStart >= 0 ? html.slice(viewStart) : html
  for (const m of scope.matchAll(ROW)) {
    const block = m[1]!
    const link = /views-field-title[\s\S]*?<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
    const times = [...block.matchAll(/<time datetime="([^"]+)"/g)].map((t) => t[1]!)
    if (!link || times.length === 0) continue
    rows.push({ path: decodeEntities(link[1]!), title: textOf(link[2]!), start: times[0]!, end: times[1] })
  }
  return rows
}

/**
 * '2026-09-15T17:30:00-04:00' → '2026-09-15T17:30' — the offset is dropped, not applied,
 * because the wall clock is what normalize wants. A bare '2026-09-12' is an all-day event
 * (Collingwood publishes a few dozen) and becomes midnight, date-only.
 */
const stripOffset = (iso: string): string => (iso.length === 10 ? `${iso}T00:00` : iso.slice(0, 16))

export function mapRows(origin: string, rows: ReturnType<typeof parseRows>, window: SyncWindow): RawEvent[] {
  const out: RawEvent[] = []
  for (const r of rows) {
    const allDay = r.start.length === 10
    const localStart = stripOffset(r.start)
    const date = localStart.slice(0, 10)
    if (date < window.from || date > window.to) continue
    let localEnd = r.end ? stripOffset(r.end) : undefined
    if (allDay && localEnd) {
      // Smart Date renders an all-day range as inclusive dates; keep multi-day spans only.
      localEnd = localEnd.slice(0, 10) > date ? `${localEnd.slice(0, 10)}T23:59` : undefined
    }
    out.push({
      externalId: `${r.path}@${localStart}`,
      title: r.title,
      localStart,
      localEnd: localEnd && localEnd > localStart ? localEnd : undefined,
      allDay,
      timePrecision: allDay ? 'date-only' : 'exact',
      categories: [],
      url: absolute(origin, r.path),
      raw: r,
    })
  }
  return out
}

export async function fetchDrupal(source: Source, window: SyncWindow): Promise<RawEvent[]> {
  const config = source.config
  if (config.platform !== 'drupal-events') throw new Error(`Source ${source.slug} is not a drupal-events source`)
  const html = await request(absolute(config.origin, config.listPath))
  return config.mode === 'fullcalendar'
    ? mapFullCalendar(config.origin, parseFullCalendar(html), window, source.timezone)
    : mapRows(config.origin, parseRows(html), window)
}
