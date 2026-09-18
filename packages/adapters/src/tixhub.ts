import { stripTags } from './html.ts'
import { request } from './http.ts'
import type { RawEvent, Source, SyncWindow } from '@scec/core'

/**
 * TIXHUB, the box-office system behind the Orillia Opera House — and so behind everything
 * it sells: Mariposa Arts Theatre's main stage, the Leacock Museum's events, the jazz
 * festival.
 *
 * The box office page is a shell; its listing comes from a CDN endpoint,
 * `cdn.tixhub.com/{tenant}/online/index_content.asp`, one table row per show:
 *
 *   <time datetime="2013-09-26">9/26/2026</time> | <time datetime="19:30">7:30 PM</time> |
 *   <a href="b_otix.asp?cboPerformances=6076&cboEvent=2486">Simply Queen…</a> | Orillia Opera House
 *
 * The date's `datetime` is a stale placeholder on every row; the text is read instead. A
 * run of performances is one row reading "Sep 18 - 19, 2026 / Multiple Dates" with no time
 * and `bmultiple=1`; its own content page lists each performance as an <option> whose
 * value is the performance id and whose text is "Friday, September 18, 2026 - 7:30 PM".
 * The performance id is the identity: one per sitting, stable across edits.
 *
 * Nothing on the listing states a price, but this is a box office: everything on it sells
 * tickets, so it is marked paid, as Ticketmaster is.
 */

export interface TixhubConfig {
  /** As the CDN spells it, e.g. 'Orillia-OH'. The public pages use it lowercased. */
  tenant: string
}

export interface TixhubRow {
  performanceId: string
  eventId: string
  title: string
  venue: string
  /** 'YYYY-MM-DD' for a single performance; null for a run, which needs its own page. */
  date: string | null
  /** 'HH:MM', or null. */
  time: string | null
  multiple: boolean
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const pad = (n: number | string) => String(n).padStart(2, '0')
const clean = (html: string) => stripTags(html).replace(/\s+/g, ' ').trim()

export const tixhubIndexUrl = (tenant: string) => `https://cdn.tixhub.com/${tenant}/online/index_content.asp`
export const tixhubEventContentUrl = (tenant: string, performanceId: string, eventId: string) =>
  `https://cdn.tixhub.com/${tenant}/online/b_otix_content.asp?cboPerformances=${performanceId}&cboEvent=${eventId}&bmultiple=1`
/** The page a reader buys from. */
export const tixhubPublicUrl = (tenant: string, performanceId: string, eventId: string) =>
  `https://secure1.tixhub.com/${tenant.toLowerCase()}/online/b_otix.asp?cboPerformances=${performanceId}&cboEvent=${eventId}`

/** '9/26/2026' → '2026-09-26'. */
const numericDate = (text: string): string | null => {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text)
  return m ? `${m[3]}-${pad(m[1]!)}-${pad(m[2]!)}` : null
}

/** '7:30 PM' → '19:30'. */
export const clock12 = (text: string): string | null => {
  const m = /(\d{1,2}):(\d{2})\s*([AP])M/i.exec(text)
  if (!m) return null
  return `${pad((Number(m[1]) % 12) + (m[3]!.toUpperCase() === 'P' ? 12 : 0))}:${m[2]}`
}

export function parseTixhubIndex(html: string): TixhubRow[] {
  const rows: TixhubRow[] = []
  for (const tr of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
    const link = /href=['"]b_otix\.asp\?cboPerformances=(\d+)&(?:amp;)?cboEvent=(\d+)([^'"]*)['"][^>]*>([\s\S]*?)<\/a>/i.exec(tr)
    if (!link) continue
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]!)
    const multiple = /bmultiple=1/.test(link[3]!) || /Multiple Dates/i.test(cells[0] ?? '')
    rows.push({
      performanceId: link[1]!,
      eventId: link[2]!,
      title: clean(link[4]!),
      venue: clean(cells[3] ?? ''),
      date: multiple ? null : numericDate(clean(cells[0] ?? '')),
      time: clock12(clean(cells[1] ?? '')),
      multiple,
    })
  }
  return rows
}

/** A run's performances: [performance id, 'YYYY-MM-DD', 'HH:MM']. */
export function parseTixhubPerformances(html: string): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = []
  for (const m of html.matchAll(/<option[^>]*value="(\d+)"[^>]*>([\s\S]*?)<\/option>/gi)) {
    const text = clean(m[2]!)
    const d = /(?:[A-Za-z]+,\s*)?([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)/i.exec(text)
    if (!d) continue
    const month = MONTHS.indexOf(d[1]!.toLowerCase())
    const time = clock12(d[4]!)
    if (month < 0 || !time) continue
    out.push([m[1]!, `${d[3]}-${pad(month + 1)}-${pad(d[2]!)}`, time])
  }
  return out
}

const toRaw = (tenant: string, row: TixhubRow, performanceId: string, date: string, time: string | null): RawEvent => ({
  externalId: performanceId,
  title: row.title,
  localStart: `${date}T${time ?? '00:00'}`,
  allDay: !time,
  timePrecision: time ? 'exact' : 'date-only',
  venueName: row.venue || undefined,
  municipalityHint: row.venue || undefined,
  isFree: false,
  categories: [],
  url: tixhubPublicUrl(tenant, performanceId, row.eventId),
  raw: row,
})

export async function fetchTixhub(source: Source, window: SyncWindow): Promise<RawEvent[]> {
  const config = source.config
  if (config.platform !== 'tixhub') throw new Error(`Source ${source.slug} is not a tixhub source`)
  const rows = parseTixhubIndex(await request(tixhubIndexUrl(config.tenant)))
  if (rows.length === 0) throw new Error(`TIXHUB ${config.tenant}: no shows in the listing (template changed?)`)

  const events: RawEvent[] = []
  const inWindow = (date: string) => date >= window.from && date <= window.to
  for (const row of rows) {
    if (!row.multiple) {
      if (row.date && inWindow(row.date)) events.push(toRaw(config.tenant, row, row.performanceId, row.date, row.time))
      continue
    }
    const html = await request(tixhubEventContentUrl(config.tenant, row.performanceId, row.eventId))
    for (const [performanceId, date, time] of parseTixhubPerformances(html)) {
      if (inWindow(date)) events.push(toRaw(config.tenant, row, performanceId, date, time))
    }
  }
  return events
}
