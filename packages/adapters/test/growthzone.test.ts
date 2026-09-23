import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeEvent, sourceBySlug } from '@scec/core'
import { mapGrowthZoneEvents } from '../src/growthzone.ts'

const xml = readFileSync(new URL('./fixtures/growthzone-barrie-chamber.xml', import.meta.url), 'utf8')
const ORIGIN = 'https://business.barriechamber.com'
const source = sourceBySlug('barrie-chamber')!
const events = mapGrowthZoneEvents(ORIGIN, xml)
const byTitle = (text: string) => events.find((e) => e.title.includes(text))!

describe('growthzone adapter', () => {
  it('keeps only the approved events, which are the ones a person curated', () => {
    // The fixture carries two PENDING rows: occurrences of a weekly networking night that
    // the platform generates years ahead, with no description, location or admission.
    expect(events).toHaveLength(12)
    expect(events.some((e) => e.title.includes('Mix and Mingle'))).toBe(false)
  })

  it('is keyed on the event id, and links to the event, not the organiser’s own site', () => {
    const parade = byTitle('Santa Claus Parade')
    expect(parade.externalId).toBe('8490')
    expect(parade.url).toBe(`${ORIGIN}/events/details/2026-barrie-santa-claus-parade-8490`)
  })

  it('reads the wall clock as given, since the feed states no zone', () => {
    const parade = byTitle('Santa Claus Parade')
    expect(parade.localStart).toBe('2026-11-21T17:00')
    expect(parade.localEnd).toBe('2026-11-21T22:00')
    expect(normalizeEvent(source, parade).localTime).toBe('17:00')
  })

  it('takes the mapped address over the pasted HTML, and places each event itself', () => {
    expect(source.municipalitySlug).toBeNull()
    const pumpkin = byTitle('Pumpkin Painting')
    expect(pumpkin.address).toBe('4346 Hwy 90, Springwater')
    // Half the chamber's own events are at a greenhouse a township away.
    expect(normalizeEvent(source, pumpkin).municipalitySlug).toBe('springwater')
  })

  it('places the parade from its title, the only thing that says where it is', () => {
    const parade = byTitle('Santa Claus Parade')
    expect(parade.address).toBeUndefined()
    expect(normalizeEvent(source, parade).municipalitySlug).toBe('barrie')
  })

  it('never prices a parade by what a float costs to enter', () => {
    // "FLOAT ENTRIES are: $250 Non-Member" is the fee to be in the parade. Watching is
    // free, and reading it as admission would hide the event from the default view.
    const parade = byTitle('Santa Claus Parade')
    expect(parade.costText).toBeUndefined()
    expect(normalizeEvent(source, parade).cost).toBe('unknown')
  })

  it('passes a real admission through to the cost rules', () => {
    expect(normalizeEvent(source, byTitle('Pumpkin Painting')).cost).toBe('free')
    expect(byTitle("Women's Show").costText).toBe('$7')
    expect(normalizeEvent(source, byTitle("Women's Show")).cost).toBe('paid')
    // "N/A" says nothing, and neither does free-for-members-only.
    expect(byTitle('Holiday Market').costText).toBeUndefined()
    expect(byTitle('Bytes & Burnout').costText).toBeUndefined()
  })

  it('carries no contact email, which the feed does hold', () => {
    expect(xml).toContain('ContactEmail')
    expect(JSON.stringify(events)).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i)
  })

  it('refuses a document that is not the feed it expects', () => {
    expect(() => mapGrowthZoneEvents(ORIGIN, '<html>Not found</html>')).toThrow(/ArrayOfEventDisplay/)
  })
})
