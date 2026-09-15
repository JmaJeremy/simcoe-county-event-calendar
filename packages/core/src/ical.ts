import type { Event } from './types.ts'

/**
 * iCalendar (RFC 5545) output.
 *
 * None of the upstream calendars offer a subscribable feed (govStack has no iCal at all,
 * the Drupal sites only per-event downloads), so this is the one way to get community
 * events into a real calendar app.
 *
 * Correctness matters more than usual because calendar clients are unforgiving: a stable
 * UID is what lets a later change update the existing entry rather than add a duplicate.
 * UIDs use the cluster id, which is sticky across re-clustering.
 */

const PRODID = '-//outinsimcoe//Out in Simcoe community events//EN'
/*
 * The right half of every event's UID. RFC 5545 §3.8.4.7 wants a globally unique value
 * and the convention is to namespace it with a domain you control; uniqueness here really
 * comes from the left half, which already carries the source slug.
 *
 * Do not change this again. A calendar that has subscribed treats a changed UID as a
 * different event, so it deletes every entry and re-adds a copy. It was changed once,
 * from the placeholder `events.simcoe`, on the day the domain was registered and while
 * nobody had subscribed yet. That window is closed.
 */
const UID_DOMAIN = 'outinsimcoe.ca'

/** RFC 5545 §3.3.11: backslash, semicolon and comma are escaped; newlines become \n. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

/**
 * RFC 5545 §3.1: lines must not exceed 75 octets, continued with CRLF + one space.
 * Folding counts bytes, not characters, so a multi-byte character must not be split.
 */
function foldLine(line: string): string {
  const bytes = new TextEncoder().encode(line)
  if (bytes.length <= 75) return line

  const parts: string[] = []
  let current = ''
  let currentBytes = 0
  let limit = 75

  for (const char of line) {
    const size = new TextEncoder().encode(char).length
    if (currentBytes + size > limit) {
      parts.push(current)
      current = ''
      currentBytes = 0
      limit = 74
    }
    current += char
    currentBytes += size
  }
  if (current) parts.push(current)
  return parts.join('\r\n ')
}

/** 'YYYYMMDDTHHMMSSZ' */
function toIcsUtc(iso: string): string {
  return `${iso.replace(/[-:]/g, '').split('.')[0]}Z`.replace(/Z+$/, 'Z')
}

/** 'YYYYMMDD' for a wall date, and the day after it (DTEND for all-day events is exclusive). */
function dateValue(localDate: string, plusDays = 0): string {
  const d = new Date(`${localDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + plusDays)
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}

export interface IcalOptions {
  /** Shown as the calendar's name in most clients. */
  calendarName?: string
  /** Absolute base URL, used to build per-event permalinks. */
  baseUrl?: string
  /** Refresh hint for subscribing clients. */
  refreshIntervalHours?: number
  /** Municipality display names by slug, for the location line. */
  municipalityNames?: Record<string, string>
}

export function buildIcal(events: Event[], options: IcalOptions = {}): string {
  const {
    calendarName = 'Out in Simcoe — community events',
    baseUrl,
    refreshIntervalHours = 6,
    municipalityNames = {},
  } = options

  const stamp = toIcsUtc(new Date().toISOString())
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    'X-WR-TIMEZONE:America/Toronto',
    `REFRESH-INTERVAL;VALUE=DURATION:PT${refreshIntervalHours}H`,
    `X-PUBLISHED-TTL:PT${refreshIntervalHours}H`,
  ]

  for (const event of events) {
    // Many listings publish no end time; assume two hours so the entry renders as a block
    // rather than a zero-length sliver.
    const end =
      event.endsAtUtc ?? new Date(Date.parse(event.startsAtUtc) + 2 * 60 * 60 * 1000).toISOString()

    const description: string[] = []
    if (event.cost === 'free') description.push('Free.')
    else if (event.costText) description.push(`Cost: ${event.costText}`)
    if (event.description) description.push(event.description)
    if (event.organizer) description.push(`Organizer: ${event.organizer}`)
    if (event.status === 'rescheduled') description.push('This event has been rescheduled.')
    if (event.timePrecision === 'date-only') {
      description.push('Start time not published by the source — check the listing.')
    }
    // Events added by hand may have no page of their own to point at.
    if (event.url) description.push(`Source: ${event.url}`)

    lines.push('BEGIN:VEVENT', `UID:${event.id}@${UID_DOMAIN}`, `DTSTAMP:${stamp}`)

    if (event.allDay || event.timePrecision === 'date-only') {
      // No real start time: a floating all-day entry, not a midnight appointment.
      const endDate = event.endsAtUtc ? localDateOf(event.endsAtUtc, event.timezone) : event.localDate
      const lastDay = endDate < event.localDate ? event.localDate : endDate
      lines.push(`DTSTART;VALUE=DATE:${dateValue(event.localDate)}`, `DTEND;VALUE=DATE:${dateValue(lastDay, 1)}`)
    } else {
      lines.push(`DTSTART:${toIcsUtc(event.startsAtUtc)}`, `DTEND:${toIcsUtc(end)}`)
    }

    lines.push(
      `SUMMARY:${escapeText(summaryFor(event))}`,
      `STATUS:${event.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
      'TRANSP:TRANSPARENT',
    )

    const place = [event.venueName, event.address, event.municipalitySlug ? municipalityNames[event.municipalitySlug] : null]
      .filter((v): v is string => !!v)
      // The address usually already ends with the town; do not print it twice.
      .filter((v, i, all) => i === 0 || !all.slice(0, i).some((prev) => prev.toLowerCase().includes(v.toLowerCase())))
    if (place.length) lines.push(`LOCATION:${escapeText(place.join(', '))}`)
    if (description.length > 0) lines.push(`DESCRIPTION:${escapeText(description.join('\n'))}`)

    const permalink = baseUrl ? `${baseUrl.replace(/\/$/, '')}/e/${event.shortCode}` : event.url
    lines.push(`URL:${permalink}`, 'END:VEVENT')
  }

  lines.push('END:VCALENDAR')
  return lines.map(foldLine).join('\r\n') + '\r\n'
}

function summaryFor(event: Event): string {
  return `${event.status === 'cancelled' ? 'CANCELLED: ' : ''}${event.title}`
}

/** 'YYYY-MM-DD' of an instant in a zone. */
function localDateOf(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
}
