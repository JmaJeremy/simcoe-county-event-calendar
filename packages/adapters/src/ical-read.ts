/**
 * Reading iCalendar (RFC 5545), enough of it for a published events feed.
 *
 * Libraries and venues hand out .ics far more readily than JSON: LibCal gives one feed per
 * calendar, and the events in it are already expanded, with a stable UID each. This parses
 * what such a feed contains and nothing more — no VTODO, no VALARM, no RRULE expansion.
 * A feed that does carry RRULE would need that added; today none of ours does.
 */

export interface IcsEvent {
  uid: string
  summary?: string
  description?: string
  location?: string
  url?: string
  categories: string[]
  /** As published: a UTC instant, a floating wall time, or a date for an all-day event. */
  start: IcsMoment
  end?: IcsMoment
  /** X- properties, which is where feeds put what the standard has no room for. */
  extra: Record<string, string>
}

export interface IcsMoment {
  /** 'YYYY-MM-DD' for a date, 'YYYY-MM-DDTHH:mm' for a time. */
  value: string
  kind: 'date' | 'utc' | 'floating'
  /** The TZID parameter, when the feed named one. */
  timeZone?: string
}

/**
 * Long properties are folded onto continuation lines beginning with a space or tab, and a
 * feed may use either line ending. Unfolding first is what makes everything else simple.
 */
const unfold = (text: string): string[] => text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n')

/** \\n, \\, \; and \, are escapes inside a text value; the rest of the character is literal. */
const unescapeText = (value: string): string =>
  value.replace(/\\([nN\;,])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c))

function parseMoment(raw: string, params: Record<string, string>): IcsMoment | null {
  const value = raw.trim()
  if (params.VALUE === 'DATE' || /^\d{8}$/.test(value)) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value)
    return m ? { value: `${m[1]}-${m[2]}-${m[3]}`, kind: 'date' } : null
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value)
  if (!m) return null
  const wall = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`
  if (m[7]) return { value: wall, kind: 'utc' }
  return { value: wall, kind: 'floating', ...(params.TZID ? { timeZone: params.TZID } : {}) }
}

export function parseIcs(text: string): IcsEvent[] {
  const events: IcsEvent[] = []
  let current: (Partial<IcsEvent> & { categories?: string[]; extra?: Record<string, string> }) | null = null

  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') {
      current = { categories: [], extra: {} }
      continue
    }
    if (line === 'END:VEVENT') {
      if (current?.uid && current.start) events.push({ ...(current as IcsEvent), categories: current.categories ?? [], extra: current.extra ?? {} })
      current = null
      continue
    }
    if (!current) continue

    const split = line.indexOf(':')
    if (split < 0) continue
    const [name, ...paramParts] = line.slice(0, split).split(';')
    const value = line.slice(split + 1)
    const params: Record<string, string> = {}
    for (const part of paramParts) {
      const eq = part.indexOf('=')
      if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '')
    }

    switch (name!.toUpperCase()) {
      case 'UID':
        current.uid = value.trim()
        break
      case 'SUMMARY':
        current.summary = unescapeText(value).trim()
        break
      case 'DESCRIPTION':
        current.description = unescapeText(value).trim()
        break
      case 'LOCATION':
        current.location = unescapeText(value).trim()
        break
      case 'URL':
        current.url = value.trim()
        break
      case 'CATEGORIES':
        current.categories = unescapeText(value)
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean)
        break
      case 'DTSTART': {
        const moment = parseMoment(value, params)
        if (moment) current.start = moment
        break
      }
      case 'DTEND': {
        const moment = parseMoment(value, params)
        if (moment) current.end = moment
        break
      }
      default:
        if (name!.toUpperCase().startsWith('X-')) current.extra![name!.toUpperCase()] = unescapeText(value).trim()
    }
  }
  return events
}
