import { describe, expect, it } from 'vitest'
import { buildIcal } from '../src/ical.ts'
import type { Event } from '../src/types.ts'

const event = (over: Partial<Event> = {}): Event => ({
  id: 'barrie:node-1@2026-09-22T19:00',
  shortCode: 'a1b2c3d',
  representativeId: 'barrie:node-1@2026-09-22T19:00',
  listingIds: ['barrie:node-1@2026-09-22T19:00'],
  sourceSlugs: ['barrie'],
  municipalitySlug: 'barrie',
  title: 'Culture Days Kick-off',
  description: 'Music, food and art at the waterfront.',
  category: 'arts',
  startsAtUtc: '2026-09-22T23:00:00.000Z',
  endsAtUtc: null,
  localDate: '2026-09-22',
  localTime: '19:00',
  timezone: 'America/Toronto',
  timePrecision: 'exact',
  allDay: false,
  venueName: 'Meridian Place',
  address: '55 Dunlop St E, Barrie',
  cost: 'free',
  costText: 'Free',
  organizer: null,
  imageUrl: null,
  url: 'https://example.invalid/event',
  status: 'scheduled',
  active: true,
  ...over,
})

/** Unfold per RFC 5545 §3.1 so assertions can look at logical lines. */
const unfold = (ics: string): string[] => ics.replace(/\r\n /g, '').split('\r\n')

describe('buildIcal', () => {
  it('produces a well-formed calendar', () => {
    const lines = unfold(buildIcal([event()]))
    expect(lines[0]).toBe('BEGIN:VCALENDAR')
    expect(lines).toContain('VERSION:2.0')
    expect(lines).toContain('BEGIN:VEVENT')
    expect(lines).toContain('END:VEVENT')
    expect(lines.at(-2)).toBe('END:VCALENDAR')
    expect(lines.at(-1)).toBe('')
  })

  it('uses the sticky cluster id as the UID so changes update rather than duplicate', () => {
    const lines = unfold(buildIcal([event()]))
    expect(lines).toContain('UID:barrie:node-1@2026-09-22T19:00@events.simcoe')
  })

  it('emits UTC instants and assumes two hours when no end is published', () => {
    const lines = unfold(buildIcal([event()]))
    expect(lines).toContain('DTSTART:20260922T230000Z')
    expect(lines).toContain('DTEND:20260923T010000Z')
  })

  it('emits all-day entries for date-only listings instead of pinning midnight', () => {
    const lines = unfold(buildIcal([event({ timePrecision: 'date-only', localTime: '00:00', startsAtUtc: '2026-09-22T04:00:00.000Z' })]))
    expect(lines).toContain('DTSTART;VALUE=DATE:20260922')
    expect(lines).toContain('DTEND;VALUE=DATE:20260923')
    expect(lines.find((l) => l.startsWith('DESCRIPTION:'))).toContain('Start time not published')
  })

  it('spans multi-day all-day events through their last day', () => {
    const lines = unfold(buildIcal([event({ allDay: true, endsAtUtc: '2026-09-24T21:00:00.000Z' })]))
    expect(lines).toContain('DTSTART;VALUE=DATE:20260922')
    expect(lines).toContain('DTEND;VALUE=DATE:20260925')
  })

  it('marks cancelled events in both STATUS and SUMMARY', () => {
    const lines = unfold(buildIcal([event({ status: 'cancelled' })]))
    expect(lines).toContain('STATUS:CANCELLED')
    expect(lines).toContain('SUMMARY:CANCELLED: Culture Days Kick-off')
  })

  it('builds the location from venue, address and municipality without repeating the town', () => {
    const lines = unfold(buildIcal([event()], { municipalityNames: { barrie: 'Barrie' } }))
    expect(lines).toContain('LOCATION:Meridian Place\\, 55 Dunlop St E\\, Barrie')
  })

  it('escapes commas and semicolons per RFC 5545', () => {
    const lines = unfold(buildIcal([event({ title: 'Soup; Bread, Jam', venueName: null, address: null })]))
    expect(lines).toContain('SUMMARY:Soup\; Bread\\, Jam')
  })

  it('prefers a permalink on our own site when a base URL is given', () => {
    const lines = unfold(buildIcal([event()], { baseUrl: 'https://example.test/' }))
    expect(lines).toContain('URL:https://example.test/e/a1b2c3d')
  })

  it('folds long lines at 75 octets without splitting multi-byte characters', () => {
    const long = event({ description: 'é'.repeat(200) })
    const raw = buildIcal([long])
    for (const line of raw.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
    }
    expect(unfold(raw).find((l) => l.startsWith('DESCRIPTION:'))).toContain('é'.repeat(200))
  })
})
