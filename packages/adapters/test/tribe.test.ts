import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { RawEvent } from '@scec/core'
import { dropRunawaySeries, mapTribeEvents, tribeUrl, type TribePage } from '../src/tribe.ts'

const page: TribePage = JSON.parse(readFileSync(new URL('./fixtures/tribe-new-tecumseth.json', import.meta.url), 'utf8'))

describe('tribe adapter', () => {
  const events = mapTribeEvents(page.events)

  it('builds the REST URL with the window and paging', () => {
    expect(tribeUrl('https://www.newtecumseth.ca/', { from: '2026-09-01', to: '2026-12-31' }, 2)).toBe(
      'https://www.newtecumseth.ca/wp-json/tribe/events/v1/events?start_date=2026-09-01&end_date=2026-12-31&per_page=50&page=2&status=publish',
    )
  })

  it('maps every published event with local times, venue and decoded title', () => {
    expect(events.length).toBe(page.events.length)
    const flag = events.find((e) => e.externalId === '9286')!
    expect(flag.title).toBe('Flag Raising – Childhood Cancer Awareness Month')
    expect(flag.localStart).toBe('2026-09-01 12:30:00')
    expect(flag.localEnd).toBe('2026-09-01 13:00:00')
    expect(flag.venueName).toBe('Town Hall')
    expect(flag.municipalityHint).toBeTruthy()
    expect(flag.url).toBe('https://www.newtecumseth.ca/event/childhoodcancermonth/')
    expect(flag.imageUrl).toMatch(/^https:\/\/www\.newtecumseth\.ca\/wp-content/)
  })

  it('passes the cost string through for classification', () => {
    const paid = events.find((e) => e.costText === '$7')
    expect(paid).toBeDefined()
    expect(events.find((e) => e.externalId === '9286')!.costText).toBeUndefined()
  })

  it('strips HTML from descriptions', () => {
    for (const e of events) {
      if (e.description) expect(e.description).not.toMatch(/<[a-z]/i)
    }
  })
})

describe('tribe adapter on the Barrie Film Festival', () => {
  const festival: TribePage = JSON.parse(readFileSync(new URL('./fixtures/tribe-barrie-film-festival.json', import.meta.url), 'utf8'))
  const events = mapTribeEvents(festival.events)

  it('keeps a screening with no published time as all day, not midnight', () => {
    const tuner = events.find((e) => e.title.startsWith('TUNER'))!
    expect(tuner.title).toBe('TUNER – Galaxy Cinemas')
    expect(tuner).toMatchObject({ allDay: true, timePrecision: 'date-only', costText: '$12' })
    expect(tuner.localStart.slice(0, 10)).toBe('2026-09-09')
  })

  it('keeps the outdoor screenings’ real start times, and their free price', () => {
    const outdoor = events.find((e) => /Outdoor Screening/.test(e.title))!
    expect(outdoor).toMatchObject({ allDay: false, timePrecision: 'exact', costText: 'Free' })
    expect(outdoor.venueName).toBe('Meridian Place')
  })
})

describe('tribe adapter on a library calendar', () => {
  const library: TribePage = JSON.parse(readFileSync(new URL('./fixtures/tribe-new-tecumseth-library.json', import.meta.url), 'utf8'))
  const events = mapTribeEvents(library.events)

  it('keeps the branch as the venue, since a library runs several', () => {
    const branch = events.find((e) => e.venueName && e.venueName !== 'All Branches')!
    expect(branch.venueName).toMatch(/Branch|Centre/)
    expect(branch.municipalityHint).toBeTruthy()
  })

  it('carries the price these calendars actually state', () => {
    // New Tecumseth's library is the one that says so outright, unlike Midland's.
    expect(events.some((e) => e.costText === 'Free')).toBe(true)
  })

  it('maps every published event with a local start time', () => {
    expect(events.length).toBeGreaterThan(5)
    for (const e of events) expect(e.localStart).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })
})


describe('runaway daily series', () => {
  const at = (title: string, date: string, venueName = 'Grounds'): RawEvent => ({
    externalId: `${title}@${date}`, title, localStart: `${date} 00:00:00`, venueName, categories: [], url: 'https://example.invalid', raw: null,
  })
  const days = (start: string, n: number) =>
    Array.from({ length: n }, (_, i) => new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10))

  it('drops a series entered as daily for months — Barrie 360’s three-day festival, 195 times', () => {
    const festival = days('2026-09-04', 195).map((d) => at('Gussapolooza Music Festival', d))
    const { kept, dropped } = dropRunawaySeries([...festival, at('Harvest Supper', '2026-09-20')])
    expect(kept.map((e) => e.title)).toEqual(['Harvest Supper'])
    expect(dropped).toEqual(['Gussapolooza Music Festival'])
  })

  it('keeps a genuine daily run, the longest on record being 37 days', () => {
    const pickleball = days('2026-07-01', 37).map((d) => at('Drop In Pickleball', d))
    expect(dropRunawaySeries(pickleball).kept).toHaveLength(37)
  })

  it('keeps a long weekly series, which is not daily however many dates it has', () => {
    const weekly = Array.from({ length: 120 }, (_, i) => at('Museum After Hours', days('2026-09-08', 1 + i * 7).at(-1)!))
    expect(dropRunawaySeries(weekly).kept).toHaveLength(120)
  })
})
