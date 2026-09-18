import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { clock12, parseTixhubIndex, parseTixhubPerformances, tixhubPublicUrl } from '../src/tixhub.ts'

// Captured 2026-09-18: the Opera House's listing, and the content page of one run.
const index = readFileSync(new URL('./fixtures/tixhub-orillia-index.html', import.meta.url), 'utf8')
const run = readFileSync(new URL('./fixtures/tixhub-orillia-event.html', import.meta.url), 'utf8')

describe('tixhub adapter', () => {
  const rows = parseTixhubIndex(index)

  it('reads one row per show, with its ids, venue and time', () => {
    expect(rows).toHaveLength(34)
    const queen = rows.find((r) => r.title.startsWith('Simply Queen'))!
    expect(queen).toMatchObject({ performanceId: '6076', eventId: '2486', date: '2026-09-26', time: '19:30', venue: 'Orillia Opera House', multiple: false })
  })

  it('reads the date from the text, not the stale datetime attribute every row carries', () => {
    // Every row says datetime="2013-09-26"; none of these shows is in 2013.
    expect(index).toContain('datetime="2013-09-26"')
    expect(rows.every((r) => r.date === null || r.date.startsWith('2026') || r.date.startsWith('2027'))).toBe(true)
  })

  it('marks a run of performances for its own page, and sells the museum’s events too', () => {
    const quartet = rows.find((r) => r.title === 'Million Dollar Quartet')!
    expect(quartet.multiple).toBe(true)
    expect(quartet.date).toBeNull()
    expect(rows.some((r) => r.venue === 'Leacock Museum Historical Site')).toBe(true)
  })

  it('expands a run into one performance each, keyed on the performance id', () => {
    expect(parseTixhubPerformances(run)).toEqual([
      ['6070', '2026-09-18', '19:30'],
      ['6071', '2026-09-19', '14:00'],
      ['6072', '2026-09-19', '19:30'],
    ])
  })

  it('reads twelve-hour clocks and links the page a reader buys from', () => {
    expect(clock12('12:00 PM')).toBe('12:00')
    expect(clock12('12:30 AM')).toBe('00:30')
    expect(clock12('2:00 PM')).toBe('14:00')
    expect(tixhubPublicUrl('Orillia-OH', '6070', '2482')).toBe(
      'https://secure1.tixhub.com/orillia-oh/online/b_otix.asp?cboPerformances=6070&cboEvent=2482',
    )
  })
})
