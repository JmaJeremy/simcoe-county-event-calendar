/**
 * Just enough HTML handling for server-rendered calendars. Workers have no DOM, and the
 * pages we read are regular enough that regexes over known class names are more robust
 * than a parser that has to cope with the whole document.
 */

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', eacute: 'é',
  egrave: 'è', agrave: 'à', ccedil: 'ç', ocirc: 'ô', icirc: 'î', ecirc: 'ê', trade: '™', reg: '®',
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED[name.toLowerCase()] ?? m)
}

/** Tags out, block boundaries to newlines, entities decoded, whitespace collapsed per line. */
export function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line, i, all) => line.length > 0 || (i > 0 && all[i - 1]!.length > 0))
    .join('\n')
    .trim()
}

/** Single-line text: tags stripped, all whitespace collapsed. */
export function textOf(html: string): string {
  return stripTags(html).replace(/\s+/g, ' ').trim()
}

/** First capture group of `re` against `html`, decoded and trimmed, or undefined. */
export function pick(html: string, re: RegExp): string | undefined {
  const m = re.exec(html)
  return m?.[1] === undefined ? undefined : decodeEntities(m[1]).trim()
}

/** Resolve a possibly-relative href against an origin. */
export function absolute(origin: string, href: string): string {
  try {
    return new URL(decodeEntities(href), origin).toString()
  } catch {
    return href
  }
}

/** Cut a description down to a sane size at a sentence or word boundary. */
export function truncate(text: string, max = 1000): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const at = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'), cut.lastIndexOf(' '))
  return `${cut.slice(0, at > max / 2 ? at + (cut[at] === '.' ? 1 : 0) : max).trim()}…`
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

export function monthNumber(name: string): number | undefined {
  return MONTHS[name.trim().toLowerCase().slice(0, 4)] ?? MONTHS[name.trim().toLowerCase().slice(0, 3)]
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** '9:30 AM' / '12 pm' / '19:00' → 'HH:mm', or undefined when it is not a clock time. */
export function parseClock(text: string): string | undefined {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\.?\s*$/i.exec(text) ?? /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text)
  if (!m) return undefined
  let hour = Number(m[1])
  const minute = Number(m[2] ?? 0)
  const meridiem = m[3]?.toLowerCase()
  if (meridiem === 'p' && hour < 12) hour += 12
  if (meridiem === 'a' && hour === 12) hour = 0
  if (hour > 23 || minute > 59) return undefined
  return `${pad(hour)}:${pad(minute)}`
}

/** 'YYYY-MM-DD' from year/month/day numbers. */
export const isoDate = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`

/** A URL-safe slug for synthesised ids. */
export const slugify = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
