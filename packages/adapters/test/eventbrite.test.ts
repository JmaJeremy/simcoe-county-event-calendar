import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeEvent, sourceBySlug } from '@scec/core'
import { eventbriteBody, fetchEventbrite, mapEventbriteEvents, type EventbriteSearchResponse } from '../src/eventbrite.ts'

const body: EventbriteSearchResponse = JSON.parse(readFileSync(new URL('./fixtures/eventbrite-simcoe.json', import.meta.url), 'utf8'))
const rows = body.events!.results!
const window = { from: '2026-09-01', to: '2027-03-31' }
const source = sourceBySlug('eventbrite')!

describe('eventbrite adapter', () => {
  const { events, outsideCounty } = mapEventbriteEvents(rows, window)

  it('asks for the county box, upcoming, 50 at a time, following the continuation', () => {
    expect(eventbriteBody('-80.45,43.95,-79.1,44.95')).toMatchObject({
      event_search: { bbox: '-80.45,43.95,-79.1,44.95', dates: 'current_future', page_size: 50, online_events_only: false },
    })
    expect(eventbriteBody('b').event_search).not.toHaveProperty('continuation')
    expect(eventbriteBody('b', 'eyJwYWdlIjoyfQ').event_search).toMatchObject({ continuation: 'eyJwYWdlIjoyfQ' })
  })

  it('keeps what the gazetteer places in the county and drops the rest of the box', () => {
    expect(rows.some((r) => r.primary_venue?.address?.city === 'East Gwillimbury')).toBe(true)
    expect(events.some((e) => e.municipalityHint === 'East Gwillimbury')).toBe(false)
    expect(outsideCounty).toBeGreaterThan(0)
    expect(events.length).toBeGreaterThan(0)
    expect(events.length + outsideCounty).toBe(rows.length)
  })

  it('maps local times, the venue and the ticket price', () => {
    const concert = events.find((e) => e.externalId === '1996793580351')!
    expect(concert.localStart).toBe('2026-10-30T20:00')
    expect(concert.localEnd).toBe('2026-10-30T21:00')
    expect(concert.timePrecision).toBe('exact')
    expect(concert.venueName).toMatch(/Collier Street/)
    expect(concert.address).toBe('112 Collier Street, Barrie, ON L4M 1H3')
    expect(concert.municipalityHint).toBe('Barrie')
    expect(concert.costText).toBe('$30–$80')
    expect(concert.isFree).toBe(false)
    expect(concert.categories).toContain('Music')
    expect(concert.url).toMatch(/^https:\/\/www\.eventbrite\.(com|ca)\/e\//)

    const listing = normalizeEvent(source, concert)
    expect([listing.municipalitySlug, listing.cost, listing.startsAtUtc]).toEqual(['barrie', 'paid', '2026-10-31T00:00:00.000Z'])
  })

  it('takes Eventbrite at its word when an event is free', () => {
    const base = rows.find((r) => r.id === '1996793580351')!
    const free = mapEventbriteEvents([{ ...base, ticket_availability: { is_free: true, minimum_ticket_price: null } }], window).events[0]!
    expect(free.costText).toBe('Free')
    expect(normalizeEvent(source, free).cost).toBe('free')
  })

  it('drops online events and anything past the window, and carries a cancellation in the title', () => {
    const base = rows.find((r) => r.id === '1996793580351')!
    const { events: mapped } = mapEventbriteEvents(
      [
        { ...base, id: 'online', is_online_event: true },
        { ...base, id: 'later', start_date: '2027-06-01', end_date: '2027-06-01' },
        { ...base, id: 'off', is_cancelled: true },
        { ...base, id: 'undated', start_time: null, end_date: '2026-11-01', end_time: null },
      ],
      window,
    )
    expect(mapped.map((e) => e.externalId)).toEqual(['off', 'undated'])
    expect(normalizeEvent(source, mapped[0]!).status).toBe('cancelled')
    expect(mapped[1]).toMatchObject({ allDay: true, timePrecision: 'date-only', localStart: '2026-10-30T00:00', localEnd: '2026-11-01T23:59' })
  })

  it('fails loudly without a token, rather than reporting an empty calendar', async () => {
    await expect(fetchEventbrite(source, window, { secrets: {} })).rejects.toThrow(/EVENTBRITE_TOKEN/)
    await expect(fetchEventbrite(source, window)).rejects.toThrow(/EVENTBRITE_TOKEN/)
  })
})
