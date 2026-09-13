import { describe, expect, it } from 'vitest'
import { resolveMunicipality } from '../src/municipalities.ts'
import { classifyCategory, classifyCost, normalizeAll, normalizeEvent } from '../src/normalize.ts'
import { sourceBySlug } from '../src/sources.ts'
import type { RawEvent } from '../src/types.ts'

const raw = (over: Partial<RawEvent> = {}): RawEvent => ({
  externalId: '2026-09-22-0930-Ride-Ramara',
  title: 'Ride Ramara - Explore Ramara Trails',
  localStart: '2026-09-22T09:30',
  categories: ['Community Events'],
  url: 'https://calendar.ramara.ca/default/Detail/2026-09-22-0930-Ride-Ramara',
  raw: {},
  ...over,
})

describe('classifyCost', () => {
  it('trusts a structured free flag over everything', () => {
    expect(classifyCost({ isFree: true, costText: '$10' })).toBe('free')
  })
  it.each([
    'Free',
    'FREE!',
    'Free admission',
    'No charge',
    'PWYC',
    'By donation',
    'Free — donations welcome ($5 suggested)',
    '$0',
  ])('reads %s as free', (costText) => {
    expect(classifyCost({ costText })).toBe('free')
  })
  it.each(['$60 +HST', '$7 per child', 'Tickets $25', 'Admission: $5', '$ 12.50', '10 dollars', 'Registration fee applies'])(
    'reads %s as paid',
    (costText) => {
      expect(classifyCost({ costText })).toBe('paid')
    },
  )
  it('falls back to the title and description', () => {
    expect(classifyCost({ title: 'Free Family Skate', description: null })).toBe('free')
    expect(classifyCost({ title: 'Roast Beef Dinner', description: 'Adults $20, children $10.' })).toBe('paid')
    expect(classifyCost({ title: 'Genealogy Club', description: 'Drop in and use our databases.' })).toBe('unknown')
  })
  it('does not mistake scent-free or free parking for a free event', () => {
    expect(classifyCost({ title: 'Gala Dinner', description: 'Scent-free venue. Free parking. Tickets $75.' })).toBe('paid')
  })
  it('takes a structured paid flag when the text says nothing', () => {
    expect(classifyCost({ isFree: false, title: 'Concert' })).toBe('paid')
  })
})

describe('classifyCategory', () => {
  it('maps source categories first, then the title', () => {
    expect(classifyCategory('Genealogy Club', ['Library Happenings'])).toBe('education')
    expect(classifyCategory('Bradford Farmers Market', ['Community Events'])).toBe('markets')
    expect(classifyCategory('Million Dollar Quartet', ['Arts & Culture'])).toBe('arts')
    expect(classifyCategory('Babble Buddies Circle Time 0-12 months', [])).toBe('family')
    expect(classifyCategory('Cornhole for Hospice', [])).toBe('sports')
    expect(classifyCategory('Township of Ramara Council Meeting', ['Public Meeting'])).toBe('civic-meeting')
    expect(classifyCategory('Something Unusual', [])).toBe('other')
  })
})

describe('resolveMunicipality', () => {
  it('finds a community name in an address', () => {
    expect(resolveMunicipality('2297 Highway 12, Brechin, ON L0K 1B0')).toBe('ramara')
    expect(resolveMunicipality(null, 'Angus Recreation Centre')).toBe('essa')
    expect(resolveMunicipality('Alliston Memorial Arena, 49 Nelson St W')).toBe('new-tecumseth')
  })
  it('prefers the longest match so Wasaga Beach and Port Severn resolve correctly', () => {
    expect(resolveMunicipality('Wasaga Beach Recplex')).toBe('wasaga-beach')
    expect(resolveMunicipality('Port Severn Community Centre')).toBe('severn')
  })
  it('only returns the county when nothing more specific matches', () => {
    expect(resolveMunicipality('Simcoe County Museum, 1151 Hwy 26, Minesing')).toBe('springwater')
    expect(resolveMunicipality('County of Simcoe Administration Centre')).toBe('simcoe-county')
  })
  it('returns null rather than guessing', () => {
    expect(resolveMunicipality('123 Main Street')).toBeNull()
    expect(resolveMunicipality('Gravenhurst Opera House')).toBeNull()
    expect(resolveMunicipality()).toBeNull()
  })
  it('does not match inside other words', () => {
    // "Oro" inside "Toronto", "Ivy" inside "Ivylea".
    expect(resolveMunicipality('Toronto')).toBeNull()
    expect(resolveMunicipality('Ivylea Court')).toBeNull()
  })
})

describe('normalizeEvent', () => {
  const ramara = sourceBySlug('ramara')!
  const simcoe = sourceBySlug('simcoe-county')!

  it('resolves wall time to a DST-correct instant and keeps the local fields', () => {
    const listing = normalizeEvent(ramara, raw())
    expect(listing.id).toBe('ramara:2026-09-22-0930-Ride-Ramara')
    expect(listing.startsAtUtc).toBe('2026-09-22T13:30:00.000Z')
    expect(listing.localDate).toBe('2026-09-22')
    expect(listing.localTime).toBe('09:30')
    expect(listing.municipalitySlug).toBe('ramara')
    expect(listing.category).toBe('outdoors')
    expect(listing.cost).toBe('unknown')
  })

  it('resolves the municipality from the address for county-wide sources', () => {
    const listing = normalizeEvent(simcoe, raw({ address: '450 Park St, Victoria Harbour, ON L0K 2A0' }))
    expect(listing.municipalitySlug).toBe('tay')
  })

  it('lets an address in a neighbouring town override the listing calendar', () => {
    // Tay's calendar carries Tiny's charity tournament; it is in Tiny.
    const tay = sourceBySlug('tay')!
    const listing = normalizeEvent(tay, raw({ title: 'Township of Tiny Charity Pickleball Tournament', address: '32 Oliver Dr, Tiny ON L0L 2J0' }))
    expect(listing.municipalitySlug).toBe('tiny')
  })

  it('falls back to the description for sources with no home municipality', () => {
    const media = { ...simcoe, municipalitySlug: null }
    const listing = normalizeEvent(media, raw({ title: 'Curated Collective Market', description: 'Welcome to the market at Georgian Mall, Barrie.' }))
    expect(listing.municipalitySlug).toBe('barrie')
  })

  it('does not let a title override a municipal calendar', () => {
    // "Meet Hospice Orillia" at the Ramara library is in Ramara.
    const listing = normalizeEvent(ramara, raw({ title: 'Meet Hospice Orillia', address: '5482 Highway 12 S' }))
    expect(listing.municipalitySlug).toBe('ramara')
  })

  it('drops an end that precedes the start', () => {
    const listing = normalizeEvent(ramara, raw({ localEnd: '2026-09-22T08:00' }))
    expect(listing.endsAtUtc).toBeNull()
  })

  it('reads in-band cancellations', () => {
    const listing = normalizeEvent(ramara, raw({ title: 'CANCELLED - Ride Ramara' }))
    expect(listing.status).toBe('cancelled')
    expect(listing.title).toBe('Ride Ramara')
    expect(listing.active).toBe(true)
  })
})

describe('normalizeAll', () => {
  const severn = sourceBySlug('severn')!
  it('skips non-events and duplicates with a reason, keeps the rest', () => {
    const { listings, skipped } = normalizeAll(severn, [
      raw({ externalId: 'a', title: 'Garbage Cart and Organics Cart Pick-up by the County' }),
      raw({ externalId: 'b', title: 'Stitch and Weave at the Severn Township Public Library' }),
      raw({ externalId: 'b', title: 'Stitch and Weave at the Severn Township Public Library' }),
      raw({ externalId: 'c', title: 'Broken', localStart: 'not a time' }),
      raw({ externalId: 'd', title: 'Proclamation: World Sepsis Day' }),
      raw({ externalId: 'e', title: 'Clock Tower Illuminated BLUE - National Coaches Week' }),
    ])
    expect(listings.map((l) => l.externalId)).toEqual(['b'])
    expect(skipped.map((s) => s.reason)).toEqual([
      'not a public event',
      'duplicate external id in batch',
      expect.stringContaining('Unrecognized date/time format'),
      'not a public event',
      'not a public event',
    ])
  })
})
