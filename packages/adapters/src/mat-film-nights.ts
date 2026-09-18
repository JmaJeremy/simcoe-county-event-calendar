import { stripTags } from './html.ts'
import { request } from './http.ts'
import type { RawEvent, Source, SyncWindow } from '@scec/core'

/**
 * MAT Film Nights: Mariposa Arts Theatre's film series, TIFF Film Circuit titles screened
 * at Galaxy Cinemas in Orillia since 1996. Listed nowhere else we read.
 *
 * The season is published only as prose on a Wix page, one film per block:
 *
 *   Tuner | Wednesday, September 9, 2026 (4pm, 7pm) | A talented piano tuner who…
 *
 * so this reads the page's text for that shape and makes one event per screening. It is a
 * reader of one page's wording, the most fragile kind of source here, so it throws when it
 * finds no films at all rather than let reconcile() see an empty season. A film still to be
 * chosen is listed as "TBA"; the screening is real, so it is kept, titled as such.
 */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const pad = (n: number | string) => String(n).padStart(2, '0')

export interface FilmNight {
  film: string
  date: string
  /** 'HH:MM' for each screening that day. */
  times: string[]
  synopsis: string
}

/** '4pm' → '16:00', '7:30 pm' → '19:30'. */
const clock = (text: string): string | null => {
  const m = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m/i.exec(text)
  return m ? `${pad((Number(m[1]) % 12) + (m[3]!.toLowerCase() === 'p' ? 12 : 0))}:${m[2] ?? '00'}` : null
}

export function parseFilmNights(html: string): FilmNight[] {
  // Every tag becomes a separator, so Wix's one-element-per-line blocks stay apart; what
  // is left is plain text, which stripTags then only has to decode.
  const text = stripTags(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' | '))
    .replace(/\s+/g, ' ')
    .replace(/(\|\s*)+/g, '| ')
  const block =
    /\|\s*([^|]{2,120}?)\s*\|\s*(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s*\(([^)]*)\)\s*\|\s*([^|]*)/g
  const films: FilmNight[] = []
  for (const m of text.matchAll(block)) {
    const month = MONTHS.indexOf(m[2]!.toLowerCase())
    const times = m[5]!.split(',').map(clock).filter((t): t is string => t !== null)
    if (month < 0 || times.length === 0) continue
    films.push({ film: m[1]!.trim(), date: `${m[4]}-${pad(month + 1)}-${pad(m[3]!)}`, times, synopsis: m[6]!.trim() })
  }
  return films
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export function mapFilmNights(
  films: FilmNight[],
  config: { url: string; venue: string; address: string; admission: string },
  window: SyncWindow,
): RawEvent[] {
  const events: RawEvent[] = []
  for (const f of films) {
    if (f.date < window.from || f.date > window.to) continue
    const tba = /^tba$/i.test(f.film)
    for (const time of f.times) {
      events.push({
        externalId: `${f.date}-${time.replace(':', '')}-${tba ? 'tba' : slug(f.film)}`,
        title: tba ? 'MAT Film Night (film to be announced)' : `MAT Film Night: ${f.film}`,
        description: tba ? undefined : f.synopsis || undefined,
        localStart: `${f.date}T${time}`,
        allDay: false,
        timePrecision: 'exact',
        venueName: config.venue,
        address: config.address,
        costText: config.admission,
        categories: ['Film'],
        organizer: 'Mariposa Arts Theatre',
        url: config.url,
        raw: f,
      })
    }
  }
  return events
}

export async function fetchFilmNights(source: Source, window: SyncWindow): Promise<RawEvent[]> {
  const config = source.config
  if (config.platform !== 'mat-film-nights') throw new Error(`Source ${source.slug} is not the MAT Film Nights page`)
  const films = parseFilmNights(await request(config.url))
  if (films.length === 0) throw new Error(`MAT Film Nights: no films found on ${config.url} (page changed?)`)
  return mapFilmNights(films, config, window)
}
