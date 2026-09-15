import { describe, expect, it } from 'vitest'
import { applyOverrides, parseOverrides, TIME_FIELDS, type Event } from '../src/index.ts'

const event: Event = {
  id: 'tay:1',
  shortCode: 'abc1234',
  representativeId: 'tay:1',
  listingIds: ['tay:1'],
  sourceSlugs: ['tay'],
  municipalitySlug: 'tay',
  title: 'Fall fair',
  description: 'Rides and pie.',
  category: 'community',
  startsAtUtc: '2026-10-03T14:00:00.000Z',
  endsAtUtc: null,
  localDate: '2026-10-03',
  localTime: '10:00',
  timezone: 'America/Toronto',
  timePrecision: 'exact',
  allDay: false,
  venueName: 'Memorial Park',
  address: null,
  cost: 'unknown',
  costText: null,
  organizer: null,
  imageUrl: 'http://calendar.tay.ca/poster.jpg',
  url: 'https://tay.ca/fair',
  status: 'scheduled',
  active: true,
}

describe('applyOverrides', () => {
  it('replaces only the fields that were edited', () => {
    const out = applyOverrides(event, { title: 'Waubaushene Fall Fair', cost: 'free' })
    expect(out.title).toBe('Waubaushene Fall Fair')
    expect(out.cost).toBe('free')
    expect(out.venueName).toBe('Memorial Park')
  })

  it('can clear a field, which is different from not editing it', () => {
    expect(applyOverrides(event, { imageUrl: null }).imageUrl).toBeNull()
    expect(applyOverrides(event, {}).imageUrl).toBe(event.imageUrl)
  })

  it('hides an event the sources keep publishing', () => {
    expect(applyOverrides(event, { active: false }).active).toBe(false)
  })

  it('never touches the identity of an event, whatever a stored override claims', () => {
    const out = applyOverrides(event, { id: 'other', shortCode: 'zzz', listingIds: [] } as any)
    expect([out.id, out.shortCode, out.listingIds]).toEqual(['tay:1', 'abc1234', ['tay:1']])
  })

  it('applies the time only as a whole, so a source can never move half of it', () => {
    const partial = applyOverrides(event, { localTime: '11:00', startsAtUtc: '2026-10-03T15:00:00.000Z' })
    expect([partial.localTime, partial.startsAtUtc]).toEqual(['10:00', '2026-10-03T14:00:00.000Z'])
    const whole = Object.fromEntries(TIME_FIELDS.map((k) => [k, event[k]]))
    const moved = applyOverrides(event, { ...whole, localTime: '11:00', startsAtUtc: '2026-10-03T15:00:00.000Z' })
    expect([moved.localTime, moved.startsAtUtc]).toEqual(['11:00', '2026-10-03T15:00:00.000Z'])
  })
})

describe('parseOverrides', () => {
  it('keeps only known fields and forgives a broken row', () => {
    expect(parseOverrides('{"title":"X","id":"no","nonsense":1}')).toEqual({ title: 'X' })
    expect(parseOverrides('not json')).toEqual({})
    expect(parseOverrides('[1,2]')).toEqual({})
    expect(parseOverrides(null)).toEqual({})
  })
})
