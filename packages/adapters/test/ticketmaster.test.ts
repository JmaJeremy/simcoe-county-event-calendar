import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeEvent, sourceBySlug } from '@scec/core'
import { fetchTicketmaster, mapTicketmasterEvents, redactKey, ticketmasterUrl, type TicketmasterPage } from '../src/ticketmaster.ts'

const page: TicketmasterPage = JSON.parse(readFileSync(new URL('./fixtures/ticketmaster-simcoe-venues.json', import.meta.url), 'utf8'))
const rows = page._embedded!.events!
const window = { from: '2026-09-01', to: '2027-03-31' }
const source = sourceBySlug('ticketmaster')!
const KEY = 'k3yK3yk3yK3yk3yK3yk3yK3yk3yK3yk3'

afterEach(() => vi.unstubAllGlobals())

describe('ticketmaster adapter', () => {
  const { events, outsideCounty } = mapTicketmasterEvents(rows)

  it('asks by venue within the window, local times sorted by date', () => {
    expect(ticketmasterUrl(KEY, ['KovZpZAFlv7A', 'KovZpZAdEEkA'], window, 1)).toBe(
      `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${KEY}&venueId=KovZpZAFlv7A,KovZpZAdEEkA` +
        '&startDateTime=2026-09-01T00:00:00Z&endDateTime=2027-03-31T23:59:59Z&size=200&page=1&sort=date,asc&locale=*',
    )
  })

  it('carries every venue the gazetteer placed in the county', () => {
    const config = source.config
    expect(config.platform).toBe('ticketmaster')
    if (config.platform !== 'ticketmaster') return
    expect(config.venueIds).toContain('KovZpZAFlv7A') // Sadlon Arena, which radius search missed
    expect(config.venueIds).toContain('KovZpZAdEEkA') // Casino Rama
    expect(new Set(config.venueIds).size).toBe(config.venueIds.length)
  })

  it('maps a Colts game: local time, the arena, Barrie, and paid', () => {
    const game = events.find((e) => e.title.startsWith('Barrie Colts vs.'))!
    expect(game.localStart).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    expect(game.venueName).toBe('Sadlon Arena')
    // The event's embedded venue, which is not word for word the venue record's address.
    expect(game.address).toMatch(/^555 Bayview Dr\.?, Barrie/)
    expect(game.categories).toContain('Sports')
    const listing = normalizeEvent(source, game)
    expect([listing.municipalitySlug, listing.cost, listing.timePrecision]).toEqual(['barrie', 'paid', 'exact'])
    expect(outsideCounty).toBe(0)
  })

  it('places Casino Rama in Ramara and picks a wide image', () => {
    const show = events.find((e) => e.venueName === 'Casino Rama Resort')!
    expect(normalizeEvent(source, show).municipalitySlug).toBe('ramara')
    expect(show.imageUrl).toMatch(/^https:\/\//)
  })

  it('turns Ticketmaster’s cancelled and rescheduled into the event’s status', () => {
    const cancelled = rows.find((r) => r.dates.status?.code === 'cancelled')!
    const moved = rows.find((r) => r.dates.status?.code === 'rescheduled')!
    const byId = new Map(events.map((e) => [e.externalId, e]))
    expect(normalizeEvent(source, byId.get(cancelled.id)!)).toMatchObject({ status: 'cancelled', title: cancelled.name.trim() })
    expect(normalizeEvent(source, byId.get(moved.id)!).status).toBe('rescheduled')
  })

  it('skips test listings and undated events, and keeps a date without a time as all day', () => {
    const base = rows[0]!
    const { events: mapped } = mapTicketmasterEvents([
      { ...base, id: 'test', test: true },
      { ...base, id: 'tba', dates: { ...base.dates, start: { ...base.dates.start, dateTBA: true } } },
      { ...base, id: 'no-time', dates: { ...base.dates, start: { localDate: '2026-12-01', timeTBA: true } } },
    ])
    expect(mapped.map((e) => e.externalId)).toEqual(['no-time'])
    expect(mapped[0]).toMatchObject({ allDay: true, timePrecision: 'date-only', localStart: '2026-12-01T00:00' })
  })

  it('never lets the key out in an error', async () => {
    expect(redactKey(`HTTP 401 from https://x/events.json?apikey=${KEY}&size=1`, KEY)).toBe('HTTP 401 from https://x/events.json?apikey=REDACTED&size=1')
    vi.stubGlobal('fetch', async () => new Response(`{"fault":"Invalid ApiKey ${KEY}"}`, { status: 401 }))
    const error = await fetchTicketmaster(source, window, { secrets: { TICKETMASTER_CONSUMER_KEY: KEY } }).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('apikey=REDACTED')
    expect((error as Error).message).not.toContain(KEY)
  })

  it('fails loudly without a key', async () => {
    await expect(fetchTicketmaster(source, window, { secrets: {} })).rejects.toThrow(/TICKETMASTER_CONSUMER_KEY/)
  })
})
