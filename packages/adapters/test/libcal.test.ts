import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeEvent, sourceBySlug } from '@scec/core'
import { mapIcsEvents } from '../src/ics.ts'
import { libcalIcalUrl } from '../src/libcal.ts'

const springwater = readFileSync(new URL('./fixtures/libcal-springwater-children.ics', import.meta.url), 'utf8')
const clearview = readFileSync(new URL('./fixtures/libcal-clearview.ics', import.meta.url), 'utf8')
const window = { from: '2026-07-01', to: '2027-03-15' }
const source = sourceBySlug('springwater-library')!

describe('libcal adapter', () => {
  const { events } = mapIcsEvents(springwater, window, 'America/Toronto')

  it('asks for the public subscribe feed of one calendar', () => {
    expect(libcalIcalUrl('springwater-ca.libcal.com', 8312)).toBe('https://springwater-ca.libcal.com/ical_subscribe.php?src=p&cid=8312')
  })

  it('turns the feed’s UTC instants into Simcoe County wall time, once', () => {
    const lego = events.find((e) => e.title.startsWith('Lego Challenge'))!
    // 14:30 UTC on an August day is 10:30 in Toronto.
    expect(lego.localStart).toBe('2026-08-17T10:30')
    expect(lego.localEnd).toBe('2026-08-17T11:30')
    expect(lego.allDay).toBe(false)
    expect(lego.externalId).toMatch(/^LibCal-8312-\d+$/)
    expect(lego.url).toBe('https://springwater-ca.libcal.com/event/4024558')
    expect(lego.venueName).toBe('Elmvale and Midhurst Branch')
    expect(normalizeEvent(source, lego).startsAtUtc).toBe('2026-08-17T14:30:00.000Z')
  })

  it('ends an all-day event on its last day, not the morning after', () => {
    const { events: allDay } = mapIcsEvents(clearview, window, 'America/Toronto')
    const passport = allDay.find((e) => e.allDay)!
    expect(passport.localStart.endsWith('T00:00')).toBe(true)
    expect(passport.timePrecision).toBe('date-only')
    // DTEND is exclusive in the feed: 20260801 for an event that runs through 31 July.
    expect(passport.localEnd).toBe(`${passport.localStart.slice(0, 10)}T23:59`)
  })

  it('keeps only what falls inside the window', () => {
    const narrow = mapIcsEvents(springwater, { from: '2026-10-01', to: '2026-10-31' }, 'America/Toronto')
    expect(narrow.skippedOutsideWindow).toBeGreaterThan(0)
    for (const e of narrow.events) expect(e.localStart.slice(0, 7)).toBe('2026-10')
  })

  it('carries the feed’s own categories through to classification', () => {
    const withCategory = events.find((e) => e.categories.length)!
    expect(withCategory.categories).toContain('Childrens Programming')
    expect(normalizeEvent(source, withCategory).category).toBeTruthy()
  })
})
