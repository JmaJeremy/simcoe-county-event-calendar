import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeEvent, sourceBySlug } from '@scec/core'
import { communicoUrl, daysInWindow, mapCommunicoEvents, type CommunicoEvent } from '../src/communico.ts'

const rows: CommunicoEvent[] = JSON.parse(readFileSync(new URL('./fixtures/communico-barrie.json', import.meta.url), 'utf8'))
const HOST = 'barrielibrary.libnet.info'
const source = sourceBySlug('barrie-library')!

describe('communico adapter', () => {
  const { events, online } = mapCommunicoEvents(HOST, rows)

  it('asks for the whole window in one request, as the library’s own page does', () => {
    const window = { from: '2026-09-02', to: '2027-03-15' }
    expect(daysInWindow(window)).toBe(195)
    const url = communicoUrl(HOST, window)
    expect(url.startsWith(`https://${HOST}/eeventcaldata?event_type=0&req=`)).toBe(true)
    expect(JSON.parse(decodeURIComponent(url.split('req=')[1]!))).toEqual({
      private: false, date: '2026-09-02', days: 195, locations: [], ages: [], types: [], tags: [], isFeatured: false,
    })
  })

  it('drops the online events, which happen nowhere in particular', () => {
    expect(online).toBeGreaterThan(0)
    expect(events.some((e) => e.venueName === 'Online')).toBe(false)
    expect(events.length + online).toBe(rows.length)
  })

  it('reads local times, the branch and the event’s own page', () => {
    const inBranch = events.find((e) => e.venueName?.includes('Branch'))!
    expect(inBranch.venueName).toMatch(/^[A-Za-z]+ Branch$/)
    expect(inBranch.localStart).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(inBranch.url).toMatch(new RegExp(`^https://${HOST}/event/\\d+$`))
    const listing = normalizeEvent(source, inBranch)
    expect(listing.municipalitySlug).toBe('barrie')
    expect(listing.timePrecision).toBe('exact')
  })

  /* The Downtown branch has an Angus Ross Room, and Angus is a hamlet in Essa. Passing the
     room to the gazetteer moved those events to another township. */
  it('never lets a room name move an event to another town', () => {
    const roomNamedAfterATown = rows.find((r) => /Angus/i.test(r.venues ?? ''))
    expect(roomNamedAfterATown, 'the fixture should keep an event in the Angus Ross Room').toBeTruthy()
    for (const e of events) {
      expect(e.venueName ?? '').not.toMatch(/Angus/)
      expect(normalizeEvent(source, e).municipalitySlug).toBe('barrie')
    }
  })

  it('names the outside venue when the library runs something elsewhere', () => {
    const external = rows.find((r) => (r.venue_name ?? '').trim())
    if (!external) return
    const mapped = events.find((e) => e.externalId === String(external.id))!
    expect(mapped.venueName).toBe(external.venue_name!.trim())
  })

  it('takes the platform at its word that a programme is free', () => {
    const free = events[0]!
    expect([free.isFree, free.costText]).toEqual([true, 'Free'])
    expect(normalizeEvent(source, free).cost).toBe('free')
  })

  it('builds the image address from the bare filename the feed gives', () => {
    const withImage = events.find((e) => e.imageUrl)!
    expect(withImage.imageUrl).toMatch(new RegExp(`^https://${HOST}/images/events/barrielibrary/.+`))
  })
})
