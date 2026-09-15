import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mapTribeEvents, tribeUrl, type TribePage } from '../src/tribe.ts'

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

