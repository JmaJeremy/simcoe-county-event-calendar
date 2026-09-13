import { describe, expect, it } from 'vitest'
import { analyzeTitle, cleanTitle, isCivicMeeting } from '../src/title.ts'

/**
 * Every string below was taken verbatim from a live municipal calendar during
 * development. They are the actual formats clerks across the county use.
 */
describe('cleanTitle', () => {
  it('strips the trailing date CivicWeb glues onto every title', () => {
    expect(cleanTitle('Council - 22 Sep 2026')).toBe('Council')
    expect(cleanTitle('Council - Dec 16 2026')).toBe('Council')
    expect(cleanTitle('Joint Council and Committee of the Whole - 10 Nov 2026')).toBe(
      'Joint Council and Committee of the Whole',
    )
  })

  it('strips the leading date Tiny prefixes to every title', () => {
    expect(cleanTitle('09 08 2026 Parks and Recreation Advisory Committee')).toBe(
      'Parks and Recreation Advisory Committee',
    )
    expect(cleanTitle('08 10 2026 - Committee of Adjustment')).toBe('Committee of Adjustment')
  })

  it('keeps a trailing parenthetical while dropping the date before it', () => {
    // Midland: the parenthetical is real information about how the meeting is called.
    expect(cleanTitle('Regular Council - 12 Aug 2026 (At the Call of the Chair)')).toBe(
      'Regular Council (At the Call of the Chair)',
    )
  })

  it('strips a trailing date that has no separator before it', () => {
    expect(cleanTitle('Special Council - Closed Session 02 Sep 2026')).toBe(
      'Special Council - Closed Session',
    )
  })

  it('leaves years that are genuinely part of the title', () => {
    // Ramara cites a court file and a strategic-plan span; stripping these would be wrong.
    const legal = 'Special Council re Bertrand et al v. Township of Ramara et al 2026 ONSC 1662'
    expect(cleanTitle(legal)).toBe(legal)
    expect(cleanTitle('Special Council Meeting regarding 2023-2026 Strategic Plan Progress')).toBe(
      'Special Council Meeting regarding 2023-2026 Strategic Plan Progress',
    )
  })

  it('never returns an empty string, even when the title is only a marker', () => {
    expect(cleanTitle('CANCELLED')).toBe('CANCELLED')
  })
})

describe('analyzeTitle', () => {
  it.each([
    ['CANCELLED - Community Development and Event Committee', 'Community Development and Event Committee'],
    ['CANCELLED Council Meeting', 'Council Meeting'],
    ['09 08 2026 Youth Advisory Committee - CANCELLED', 'Youth Advisory Committee'],
    ['NO MEETING Regular Council - 12 Aug 2026', 'Regular Council'],
  ])('detects cancellation in %s', (raw, expected) => {
    const result = analyzeTitle(raw)
    expect(result.status).toBe('cancelled')
    expect(result.title).toBe(expected)
  })

  it('detects a rescheduling', () => {
    const result = analyzeTitle('RESCHEDULED Committee of Adjustment')
    expect(result.status).toBe('rescheduled')
    expect(result.title).toBe('Committee of Adjustment')
  })

  it('detects cancellation hidden in the location field', () => {
    // BWG and Clearview leave the title alone and write the marker into the venue.
    const result = analyzeTitle('Regular Council and Committee of the Whole', 'Meeting Cancelled')
    expect(result.status).toBe('cancelled')
    expect(result.locationIsMarker).toBe(true)
  })

  it('does not treat a real venue as a status marker', () => {
    const result = analyzeTitle('Council', 'Council Chambers')
    expect(result.status).toBeNull()
    expect(result.locationIsMarker).toBe(false)
  })

  it('reports no status when the source says nothing', () => {
    expect(analyzeTitle('Committee of the Whole').status).toBeNull()
  })
})

describe('isCivicMeeting', () => {
  it.each([
    'Township of Ramara Council Meeting',
    'Special Council Meeting',
    'Committee of Adjustment',
    'Council Meeting',
    'Statutory Public Meeting - Zoning By-law Amendment',
    'Budget Deliberations Session 2',
    'Professional Health Services Complex Ad Hoc Committee Meeting',
  ])('tags %s', (title) => {
    expect(isCivicMeeting(title)).toBe(true)
  })

  it('uses the source category when the title alone is ambiguous', () => {
    expect(isCivicMeeting('Committee of Adjustment', ['Public Meeting'])).toBe(true)
    expect(isCivicMeeting('Council', ['Council Meetings'])).toBe(true)
  })

  it.each([
    'Community Committee Fall Fair',
    'Library Board Book Sale',
    'Meet the Candidate Sessions',
    'Genealogy Club',
    '27th Annual Thornton Corn Roast',
    'Ride Ramara - Explore Ramara Trails',
    'Stitch and Weave at the Severn Township Public Library',
  ])('leaves %s alone', (title) => {
    expect(isCivicMeeting(title, ['Community Events'])).toBe(false)
  })
})
