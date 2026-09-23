import { describe, expect, it } from 'vitest'
import { resolveMunicipality } from '../src/municipalities.ts'
import { assessCost, classifyCategory, classifyCost, normalizeAll, normalizeEvent } from '../src/normalize.ts'
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

describe('classifyCost: a negation says the opposite in the same words', () => {
  it('does not price an event that says no ticket is required', () => {
    // Bradford Greenhouses' holiday market ends "No Ticket Required!", and reading that as
    // ticketed put a free market behind the "Paid only" filter.
    expect(classifyCost({ description: 'Immerse yourself in the magic of the season. No Ticket Required!' })).not.toBe('paid')
    expect(classifyCost({ description: 'No tickets required for this one.' })).not.toBe('paid')
  })

  it('still prices one that says a ticket IS required', () => {
    expect(classifyCost({ description: 'Tickets required.' })).toBe('paid')
    expect(classifyCost({ description: 'Tickets are required for entry.' })).toBe('paid')
    expect(classifyCost({ description: 'Purchase tickets at the door.' })).toBe('paid')
    expect(classifyCost({ description: 'An admission fee applies.' })).toBe('paid')
  })
})

describe('assessCost: what is strong evidence and what is a guess', () => {
  it('will not read a fundraising total as an admission price', () => {
    // The event that exposed this: a giving circle whose page says the chapter expects to
    // hand a charity "$20,000". Nothing there is the price of getting in.
    const verdict = assessCost({
      title: '100 Women Who Care kickoff',
      description: 'Members vote to select one charity, which receives an expected collective donation of more than $20,000.',
    })
    expect(verdict.cost).toBe('unknown')
    expect(verdict.confidence).toBe('low')
  })

  it.each([
    ['Adults: $50.00 | Seniors: $45.00', 'Million Dollar Quartet'],
    ['Tickets $25 at the door', 'Concert'],
    ['$7 per child', 'Skate'],
    ['Admission: $5', 'Dance'],
  ])('reads %s beside a price word as paid, and keeps the words', (description, title) => {
    const verdict = assessCost({ title, description })
    expect(verdict.cost).toBe('paid')
    expect(verdict.confidence).toBe('high')
    expect(verdict.evidence).toBeTruthy()
  })

  it('believes a plain statement about admission', () => {
    const verdict = assessCost({ description: 'This is a free program, just bring your water and indoor shoes!' })
    expect(verdict).toMatchObject({ cost: 'free', confidence: 'high' })
  })

  it('treats a stray "free" in a long description as a guess, not an answer', () => {
    const verdict = assessCost({
      title: 'Fall Concert',
      description: 'Doors at 7. There is free parking behind the hall, and the bar is open. Free snacks for members.',
    })
    expect(verdict.confidence).toBe('low')
  })

  it('trusts a field the source labelled Cost, however short', () => {
    expect(assessCost({ costText: 'Free' })).toMatchObject({ cost: 'free', confidence: 'high' })
    expect(assessCost({ costText: '$20 in advance' })).toMatchObject({ cost: 'paid', confidence: 'high' })
  })

  it('says nothing rather than guessing when the text says nothing', () => {
    expect(assessCost({ title: 'Council Meeting', description: 'Agenda to follow.' })).toEqual({
      cost: 'unknown',
      confidence: 'low',
    })
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

  it('skips a department name, which says who runs it, not what it is', () => {
    // Severn files every programme under this, and "Parks" made 227 of them outdoors.
    const severn = ['Recreation, Parks, and Facilities events']
    expect(classifyCategory('Yoga for Resilient Aging', severn)).toBe('sports')
    expect(classifyCategory('Bead Crazy!', severn)).toBe('arts')
    expect(classifyCategory('Introduction to Free Weights', severn)).toBe('sports')
    expect(classifyCategory('Zumba Dance Fitness', severn)).toBe('sports')
  })

  it('reads the title without place names', () => {
    // "Wasaga Beach" is a town, not a beach.
    expect(classifyCategory('Wasaga Beach Chess Club', ['Gaming', 'Hobbies & Special Interest'])).toBe('community')
    expect(classifyCategory('Balm Beach Cleanup', [])).toBe('other')
  })

  it('consults audience and catch-all labels only after the title', () => {
    expect(classifyCategory('Chair Yoga', ['Seniors'])).toBe('sports')
    expect(classifyCategory('Knitting Circle', ['Adults', 'Drop-in'])).toBe('arts')
    expect(classifyCategory('Coffee Hour', ['Seniors'])).toBe('community')
    expect(classifyCategory('Township of Tiny Charity Pickleball Tournament', ['External Community Event'])).toBe('sports')
    expect(classifyCategory('Orillia Pirate Party', ['Community Event'])).toBe('community')
  })

  it('keeps a child audience decisive, since family is the kids\u2019 category', () => {
    expect(classifyCategory('Storytime', ['Children', 'Early Literacy'])).toBe('family')
  })

  it('does not take a jewellery sale or a tree lighting for a craft class or a hike', () => {
    expect(classifyCategory('Bradford Jewellery & Coins Buying Event', [])).not.toBe('arts')
    expect(classifyCategory('Tree Lighting Ceremony', [])).toBe('community')
    expect(classifyCategory('We Walk The Line - Tribute to Johnny Cash', [])).toBe('music')
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
  it('reads a place name followed by a street word as the street, not the place', () => {
    // Longer names are tried first, so "Bradford" used to beat "Barrie" on the same line.
    expect(resolveMunicipality('Barrie By The Bay Commercial Complex, 80 Bradford Street')).toBe('barrie')
    expect(resolveMunicipality('268 Bradford Street, Barrie, ON L4N 3B7')).toBe('barrie')
    expect(resolveMunicipality('300 Coldwater Road West, Orillia, ON L3V 6X5')).toBe('orillia')
    expect(resolveMunicipality('737 Horseshoe Valley Rd W, Coldwater, ON L0K 1E0')).toBe('severn')
    expect(resolveMunicipality('Anten Mills Park (3985 Horseshoe Valley Road West)')).toBe('springwater')
    // The place itself still counts wherever it is not naming a street.
    expect(resolveMunicipality('Bradford Leisure Centre')).toBe('bradford-west-gwillimbury')
    expect(resolveMunicipality('Coldwater Legion')).toBe('severn')
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

  it('drops a library announcing its own hours, and keeps events that only use the words', () => {
    const notices = [
      'CLOSED',
      'CLOSED - All Branches',
      'CLOSED for Staff Training All Branches',
      'Christmas Closure',
      'National Truth and Reconciliation Day All Branches CLOSED',
      'Christmas Eve - OPEN Special Hours (9am - 12pm)',
      'Remembrance Day - OPEN (Regular Hours)',
    ]
    const events = [
      'Museum After Hours',
      'After Hours Election Service Centre',
      'Indigenous Medicine Garden Closing and Gathering',
      'Closed Captioned Movie Matinee',
    ]
    const { listings } = normalizeAll(
      severn,
      [...notices, ...events].map((title, i) => raw({ externalId: String(i), title })),
    )
    expect(listings.map((l) => l.title)).toEqual(events)
  })

  it('drops an observance that is only a date, and keeps the same words with a time', () => {
    const untimed = { allDay: true, timePrecision: 'date-only' as const, localStart: '2026-11-11T00:00' }
    const observances = [
      'Remembrance Day',
      'Hispanic Heritage Month',
      "International Men's Day",
      'National Day for Truth and Reconciliation',
      'PA Day - elementary only',
      'Chanukah begins',
    ].map((title, i) => raw({ externalId: `o${i}`, title, ...untimed }))
    const kept = [
      raw({ externalId: 'k1', title: 'PA Day: Rollercoaster Science', localStart: '2026-10-09T09:00' }),
      raw({ externalId: 'k2', title: 'Family Day', localStart: '2027-02-15T11:00' }),
      raw({ externalId: 'k3', title: 'Remembrance Day', localStart: '2026-11-11T10:45' }),
      // Untimed, but not an observance name: a studio tour runs all weekend.
      raw({ externalId: 'k4', title: 'Autumn Leaves Studio Tour 2026', ...untimed }),
    ]
    const { listings } = normalizeAll(severn, [...observances, ...kept])
    expect(listings.map((l) => l.externalId)).toEqual(['k1', 'k2', 'k3', 'k4'])
  })
})
