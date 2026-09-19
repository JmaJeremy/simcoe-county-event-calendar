import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeEvent, sourceBySlug } from '@scec/core'
import { mapFilmNights, parseFilmNights } from '../src/mat-film-nights.ts'

// The season section of the Wix page, captured 2026-09-18.
const html = readFileSync(new URL('./fixtures/mat-film-nights.html', import.meta.url), 'utf8')
const source = sourceBySlug('mat-film-nights')!
const config = source.config as Extract<typeof source.config, { platform: 'mat-film-nights' }>
const WINDOW = { from: '2026-09-01', to: '2027-03-01' }

describe('MAT Film Nights', () => {
  const films = parseFilmNights(html)
  const events = mapFilmNights(films, config, WINDOW)

  it('reads the fall season from the page’s prose', () => {
    expect(films.map((f) => f.film)).toEqual([
      'Tuner', 'Once Upon a Time in Cinema', 'Nika & Madison', "Margaret's Museum (1995)", 'The Christophers', 'I Swear', 'TBA',
    ])
    expect(films[0]).toMatchObject({ date: '2026-09-09', times: ['16:00', '19:00'] })
    expect(films[0]!.synopsis).toMatch(/^A talented piano tuner/)
  })

  it('makes one event per screening, two a film', () => {
    expect(events).toHaveLength(14)
    expect(events.filter((e) => e.title === 'MAT Film Night: Tuner').map((e) => e.localStart)).toEqual([
      '2026-09-09T16:00',
      '2026-09-09T19:00',
    ])
    expect(new Set(events.map((e) => e.externalId)).size).toBe(14)
  })

  it('keeps a screening whose film is still to be chosen', () => {
    expect(events.filter((e) => e.title === 'MAT Film Night (film to be announced)')).toHaveLength(2)
  })

  it('places it at the cinema in Orillia, priced at the door', () => {
    const listing = normalizeEvent(source, events[0]!)
    expect(listing.municipalitySlug).toBe('orillia')
    expect(listing.venueName).toBe('Galaxy Cinemas Orillia')
    expect(listing.cost).toBe('paid')
  })
})
