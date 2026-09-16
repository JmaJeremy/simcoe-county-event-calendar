import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeEvent, sourceBySlug } from '@scec/core'
import { mapIcsEvents } from '../src/ics.ts'

/**
 * A published feed from a platform that is not LibCal, to keep the mapping honest about
 * what varies: Tockify names no location, puts its image in an X- property, and writes
 * every time as a UTC instant.
 */

const tockify = readFileSync(new URL('./fixtures/ics-tockify-bradford.ics', import.meta.url), 'utf8')
const window = { from: '2026-08-01', to: '2027-03-15' }
const source = sourceBySlug('bradford-library')!

describe('a Tockify feed as an ics source', () => {
  const { events } = mapIcsEvents(tockify, window, 'America/Toronto')

  it('reads the feed the board publishes', () => {
    expect(events.length).toBeGreaterThan(5)
    for (const e of events) {
      expect(e.externalId).toMatch(/^TKF\//)
      expect(e.url).toMatch(/^https:\/\/tockify\.com\/bwgplcc\/detail\//)
    }
  })

  it('converts the UTC instants to local wall time, once', () => {
    const timed = events.find((e) => !e.allDay)!
    expect(timed.localStart).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    const listing = normalizeEvent(source, timed)
    // The wall time converts back to the instant the feed published.
    expect(new Date(listing.startsAtUtc).toISOString()).toBe(listing.startsAtUtc)
    expect(listing.municipalitySlug).toBe('bradford-west-gwillimbury')
  })

  it('takes the image out of the X- property the platform uses for it', () => {
    const withImage = events.find((e) => e.imageUrl)
    expect(withImage?.imageUrl).toMatch(/^https:\/\//)
  })

  it('splits a room from the street address behind it, and keeps both', () => {
    const withAddress = events.find((e) => e.address)!
    expect(withAddress.venueName).toBe('Zima Room')
    expect(withAddress.address).toMatch(/425 Holland St W, Bradford/)
    // A location with no street number is a place name, not an address.
    const roomOnly = events.find((e) => e.venueName === 'Pascal Room')!
    expect(roomOnly.address).toBeUndefined()
  })

  it('leaves the venue empty when the feed names no location, so the source’s town stands', () => {
    const noLocation = events.find((e) => !e.venueName)!
    expect(noLocation.address).toBeUndefined()
    expect(normalizeEvent(source, noLocation).municipalitySlug).toBe('bradford-west-gwillimbury')
  })

  it('keeps the categories the board tags its events with', () => {
    const tagged = events.find((e) => e.categories.length)!
    expect(tagged.categories.length).toBeGreaterThan(0)
  })
})
