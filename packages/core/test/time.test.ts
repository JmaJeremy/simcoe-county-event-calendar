import { describe, expect, it } from 'vitest'
import { shiftDate, toWallClock, toWallString, wallTimeToUtc } from '../src/time.ts'

/**
 * Timezone handling is the quietest source of wrong answers in this project: a bug here
 * shows the right-looking time on the wrong hour and nothing throws. The previous version
 * stored naive datetimes, so these cases were all silently wrong half the year.
 */
describe('wallTimeToUtc', () => {
  const TZ = 'America/Toronto'

  it('resolves a summer (EDT, UTC-4) wall time', () => {
    expect(wallTimeToUtc('2026-09-22T09:00', TZ).toISOString()).toBe('2026-09-22T13:00:00.000Z')
  })

  it('resolves a winter (EST, UTC-5) wall time', () => {
    expect(wallTimeToUtc('2026-01-14T09:00', TZ).toISOString()).toBe('2026-01-14T14:00:00.000Z')
  })

  it('gives the same clock time a different UTC instant either side of a DST change', () => {
    // DST ends 1 Nov 2026, so a 9am meeting that day sits an extra hour later in absolute
    // terms than the 9am meeting the day before: 25 hours apart, not 24. This is exactly
    // the drift a naive datetime introduces.
    const beforeChange = wallTimeToUtc('2026-10-31T09:00', TZ)
    const afterChange = wallTimeToUtc('2026-11-01T09:00', TZ)
    expect(beforeChange.toISOString()).toBe('2026-10-31T13:00:00.000Z')
    expect(afterChange.toISOString()).toBe('2026-11-01T14:00:00.000Z')
    expect(afterChange.getTime() - beforeChange.getTime()).toBe(25 * 60 * 60 * 1000)
  })

  it('handles the evening of the spring-forward day', () => {
    expect(wallTimeToUtc('2026-03-08T19:00', TZ).toISOString()).toBe('2026-03-08T23:00:00.000Z')
  })

  it('rejects unparseable input rather than inventing a date', () => {
    expect(() => wallTimeToUtc('sometime next Tuesday', TZ)).toThrow()
  })
})

describe('toWallString', () => {
  it('accepts the CivicWeb shape', () => {
    expect(toWallString('2026-09-22 09:00')).toBe('2026-09-22T09:00')
  })

  it('accepts the eSCRIBE shape and drops its meaningless seconds', () => {
    // eSCRIBE stores an incrementing counter in the seconds field, not a real second.
    expect(toWallString('2026/10/05 14:00:24')).toBe('2026-10-05T14:00')
  })
})

describe('shiftDate', () => {
  it('moves across a month boundary', () => {
    expect(shiftDate('2026-09-06', -90)).toBe('2026-06-08')
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('toWallClock', () => {
  it('renders an instant as the local wall clock, DST-aware', () => {
    expect(toWallClock(new Date('2026-09-17T21:30:00Z'), 'America/Toronto')).toBe('2026-09-17T17:30')
    expect(toWallClock(new Date('2026-01-17T22:30:00Z'), 'America/Toronto')).toBe('2026-01-17T17:30')
    expect(toWallClock(1789662600 * 1000, 'America/Toronto')).toBe('2026-09-17T12:30')
  })
  it('round-trips with wallTimeToUtc', () => {
    const wall = '2026-11-01T01:30'
    expect(toWallClock(wallTimeToUtc(wall, 'America/Toronto'), 'America/Toronto')).toBe(wall)
  })
})
