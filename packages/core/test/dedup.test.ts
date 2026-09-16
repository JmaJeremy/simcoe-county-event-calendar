import { describe, expect, it } from 'vitest'
import {
  DISTINCT_THRESHOLD,
  MERGE_THRESHOLD,
  buildClusters,
  candidatePairs,
  datesSpanned,
  eventFromCluster,
  normalizeTitle,
  placeSimilarity,
  scorePair,
  timeAgreement,
  titleSimilarity,
  verdictByRules,
} from '../src/dedup.ts'
import type { Listing } from '../src/types.ts'

const listing = (over: Partial<Listing> & { id: string; sourceSlug: string }): Listing => ({
  sourceKind: 'municipal',
  externalId: over.id,
  municipalitySlug: 'severn',
  title: 'Coldwater Fall Fair',
  description: null,
  category: 'community',
  sourceCategories: [],
  startsAtUtc: '2026-09-26T14:00:00.000Z',
  endsAtUtc: null,
  localDate: '2026-09-26',
  localTime: '10:00',
  timezone: 'America/Toronto',
  timePrecision: 'exact',
  allDay: false,
  venueName: null,
  address: null,
  cost: 'unknown',
  costText: null,
  organizer: null,
  imageUrl: null,
  url: `https://example.invalid/${over.id}`,
  status: 'scheduled',
  active: true,
  contentHash: 'h',
  ...over,
})

const priority = (slug: string): number =>
  ({ severn: 10, ramara: 10, 'simcoe-county': 20, 'orillia-library': 30, orilliamatters: 50 })[slug] ?? 50

describe('normalizeTitle and titleSimilarity', () => {
  it('strips place names, ordinals, years and filler', () => {
    expect(normalizeTitle('27th Annual Thornton Corn Roast')).toEqual(['corn', 'roast'])
    expect(normalizeTitle('Wasaga Beach Fall Fair 2026')).toEqual(['fall', 'fair'])
    expect(normalizeTitle('The Township of Severn presents: Coldwater Fall Fair')).toEqual(['fall', 'fair'])
  })

  it('scores real cross-source wordings as the same', () => {
    expect(titleSimilarity('Ride Ramara - Explore Ramara Trails', 'Ride Ramara: Explore Ramara Trails!')).toBeGreaterThan(0.95)
    expect(titleSimilarity('Coldwater Fall Fair', 'Coldwater Fall Fair 2026 - Severn Township')).toBeGreaterThan(0.85)
    expect(titleSimilarity('Victoria Habour Legion - Sing for your Supper (Karaoke)', 'Victoria Harbour Legion Sing for Your Supper Karaoke')).toBeGreaterThan(0.75)
    expect(titleSimilarity('Simcoe County Quilt, Rug and Artisan Fair', 'Simcoe County Museum Quilt, Rug & Artisan Fair')).toBeGreaterThan(0.75)
  })

  it('scores different events as different', () => {
    expect(titleSimilarity('Coldwater Fall Fair', 'Coldwater Farmers Market')).toBeLessThan(0.5)
    expect(titleSimilarity('Genealogy Club', 'Ramara Quilting Club')).toBeLessThan(0.5)
    expect(titleSimilarity('Drop In Pickleball', 'Drop In Tennis')).toBeLessThan(0.7)
  })
})

describe('signals', () => {
  it('rewards start times within fifteen minutes and degrades beyond', () => {
    const a = listing({ id: 'a', sourceSlug: 'severn' })
    expect(timeAgreement(a, listing({ id: 'b', sourceSlug: 'x', startsAtUtc: '2026-09-26T14:10:00.000Z' }))).toBe(1)
    expect(timeAgreement(a, listing({ id: 'b', sourceSlug: 'x', startsAtUtc: '2026-09-26T15:00:00.000Z' }))).toBe(0.5)
    expect(timeAgreement(a, listing({ id: 'b', sourceSlug: 'x', startsAtUtc: '2026-09-26T20:00:00.000Z' }))).toBe(0)
    expect(timeAgreement(a, listing({ id: 'b', sourceSlug: 'x', allDay: true, timePrecision: 'date-only' }))).toBe(0.4)
  })

  it('compares street addresses when both have one, venue words otherwise, neutral when unknown', () => {
    const a = listing({ id: 'a', sourceSlug: 'severn', address: '2297 Highway 12, Brechin, ON L0K 1B0' })
    expect(placeSimilarity(a, listing({ id: 'b', sourceSlug: 'x', address: '2297 Hwy 12, Brechin' }))).toBe(1)
    expect(placeSimilarity(a, listing({ id: 'b', sourceSlug: 'x', address: '5482 Highway 12 S' }))).toBe(0)
    expect(
      placeSimilarity(
        listing({ id: 'a', sourceSlug: 'severn', venueName: 'Coldwater Arena' }),
        listing({ id: 'b', sourceSlug: 'x', venueName: 'Coldwater Community Arena' }),
      ),
    ).toBe(1)
    expect(placeSimilarity(listing({ id: 'a', sourceSlug: 'severn' }), listing({ id: 'b', sourceSlug: 'x' }))).toBe(0.5)
  })

  it('spans every date of a multi-day listing', () => {
    expect(datesSpanned(listing({ id: 'a', sourceSlug: 'x', endsAtUtc: '2026-09-28T20:00:00.000Z' }))).toEqual(['2026-09-26', '2026-09-27', '2026-09-28'])
    expect(datesSpanned(listing({ id: 'a', sourceSlug: 'x' }))).toEqual(['2026-09-26'])
  })
})

describe('candidatePairs', () => {
  it('pairs two listings from one source when the place and the time both agree', () => {
    // A source duplicating itself: BarrieToday carried one concert under both
    // "arts-culture" and "live-music", and nothing merged them because same-source pairs
    // were never scored at all.
    const pairs = candidatePairs([listing({ id: 'a', sourceSlug: 'severn' }), listing({ id: 'b', sourceSlug: 'severn' })])
    expect(pairs).toHaveLength(1)
  })

  it('never pairs one source\u2019s listings at different branches, however alike they read', () => {
    // Barrie Public Library runs "Kindergarten School Skills" at 10:00 at three branches
    // on one morning. Scored, they merge \u2014 the shared word "Branch" is enough to lift
    // them to 0.94 \u2014 so the gate has to stop them before scoring.
    const atBranch = (id: string, venueName: string) =>
      listing({ id, sourceSlug: 'barrie-library', municipalitySlug: 'barrie', title: 'Kindergarten School Skills', venueName })
    const branches = [atBranch('a', 'Downtown Branch'), atBranch('b', 'Painswick Branch'), atBranch('c', 'Holly Branch')]
    expect(candidatePairs(branches)).toHaveLength(0)
    // The score they would have got, had they been allowed through.
    expect(scorePair(branches[0]!, branches[1]!).score).toBeGreaterThan(MERGE_THRESHOLD)

    const newTecumseth = [
      listing({ id: 'd', sourceSlug: 'new-tecumseth-library', title: 'Let\u2019s Play: Chess', venueName: 'Pam Kirkpatrick Branch (Tottenham)' }),
      listing({ id: 'e', sourceSlug: 'new-tecumseth-library', title: 'Let\u2019s Play: Chess', venueName: 'D A Jones Branch (Beeton)' }),
    ]
    expect(candidatePairs(newTecumseth)).toHaveLength(0)
  })

  it('never pairs one source\u2019s listings at different times', () => {
    // Two showings of "Friday Flicks" at one branch, and 40-minute tech-help slots.
    const flicks = (id: string, localTime: string, startsAtUtc: string) =>
      listing({ id, sourceSlug: 'barrie-library', title: 'Friday Flicks', venueName: 'Painswick Branch', localTime, startsAtUtc })
    expect(candidatePairs([flicks('a', '14:30', '2026-09-26T18:30:00.000Z'), flicks('b', '18:30', '2026-09-26T22:30:00.000Z')])).toHaveLength(0)
    expect(candidatePairs([flicks('c', '15:00', '2026-09-26T19:00:00.000Z'), flicks('d', '15:40', '2026-09-26T19:40:00.000Z')])).toHaveLength(0)
  })

  it('pairs one source\u2019s all-day listings, and treats a silent venue as no disagreement', () => {
    const allDay = (id: string) => listing({ id, sourceSlug: 'orilliamatters', allDay: true, timePrecision: 'date-only' })
    expect(candidatePairs([allDay('a'), allDay('b')])).toHaveLength(1)
    // One side names a venue, the other says nothing: unknown, not different.
    expect(candidatePairs([listing({ id: 'c', sourceSlug: 'tay', venueName: 'Victoria Harbour Legion' }), listing({ id: 'd', sourceSlug: 'tay' })])).toHaveLength(1)
  })

  it('never pairs listings placed in different municipalities, even with identical titles and times', () => {
    // The civi-times lesson: two townships' Committee of Adjustment at the same hour are two meetings.
    const pairs = candidatePairs([
      listing({ id: 'a', sourceSlug: 'ramara', municipalitySlug: 'ramara', title: 'Farmers Market' }),
      listing({ id: 'b', sourceSlug: 'severn', municipalitySlug: 'severn', title: 'Farmers Market' }),
    ])
    expect(pairs).toHaveLength(0)
  })

  it('pairs across dates a multi-day listing spans, and treats an unplaced listing as compatible', () => {
    const market = listing({
      id: 'a',
      sourceSlug: 'barrietoday',
      municipalitySlug: null,
      localDate: '2026-09-12',
      startsAtUtc: '2026-09-12T13:30:00.000Z',
      endsAtUtc: '2026-09-13T21:00:00.000Z',
    })
    const dayTwo = listing({ id: 'b', sourceSlug: 'barrie', municipalitySlug: 'barrie', localDate: '2026-09-13', startsAtUtc: '2026-09-13T15:00:00.000Z' })
    expect(candidatePairs([market, dayTwo])).toHaveLength(1)
  })

  it('ignores inactive listings', () => {
    expect(candidatePairs([listing({ id: 'a', sourceSlug: 'x', active: false }), listing({ id: 'b', sourceSlug: 'y' })])).toHaveLength(0)
  })
})

describe('scorePair and verdicts', () => {
  it('merges a township listing with the county and news copies of the same fair', () => {
    const township = listing({ id: 'severn:1', sourceSlug: 'severn', title: 'Coldwater Fall Fair', address: '2 Coldwater Rd, Coldwater' })
    const county = listing({
      id: 'simcoe-county:2',
      sourceSlug: 'simcoe-county',
      sourceKind: 'county',
      title: 'Coldwater Fall Fair 2026',
      venueName: 'Coldwater Fairgrounds',
    })
    const news = listing({
      id: 'orilliamatters:3',
      sourceSlug: 'orilliamatters',
      sourceKind: 'media',
      municipalitySlug: null,
      title: 'Coldwater Fall Fair - all weekend!',
      timePrecision: 'date-only',
      allDay: true,
    })
    expect(verdictByRules(scorePair(township, county))).toBe('same')
    expect(scorePair(township, news).score).toBeGreaterThan(DISTINCT_THRESHOLD)
  })

  it('reaches at least the judge for the same concert posted twice by one news site', () => {
    // The real pair, verbatim: BarrieToday 69807 and 69808, one titled with the address
    // appended. Both venue and address are null, as user-submitted SPACES listings are.
    const spaces = (id: string, title: string, url: string) =>
      listing({ id: `barrietoday:${id}@2026-09-16`, sourceSlug: 'barrietoday', sourceKind: 'media', municipalitySlug: 'barrie', title, url,
        localDate: '2026-09-16', localTime: '12:00', startsAtUtc: '2026-09-16T16:00:00.000Z', endsAtUtc: '2026-09-16T17:00:00.000Z' })
    const a = spaces('69807', 'Barrie Sax Quartet\u2019s "Merry Go Round of Life" at Bethel Community Church',
      'https://barrie.spaces.ca/arts-culture/barrie-sax-quartets-merry-go-round-of-life-at-bethel-community-church-69807')
    const b = spaces('69808', 'Barrie Sax Quartet\u2019s "Merry Go Round of Life" at Bethel Community Church, 128 St. Vincent St, Barrie',
      'https://barrie.spaces.ca/live-music/barrie-sax-quartets-merry-go-round-of-life-at-bethel-community-church-128-st-vincent-st-barrie-69808')
    expect(candidatePairs([a, b])).toHaveLength(1)
    // The appended address costs it enough title similarity to land short of an automatic
    // merge, which is what the judge is for. What matters is that it is no longer distinct.
    expect(verdictByRules(scorePair(a, b))).not.toBe('distinct')
  })

  it('keeps different events on the same day apart', () => {
    const a = listing({ id: 'a', sourceSlug: 'severn', title: 'Coldwater Fall Fair' })
    const b = listing({ id: 'b', sourceSlug: 'orilliamatters', title: 'Steampunk Festival', municipalitySlug: null })
    expect(verdictByRules(scorePair(a, b))).toBe('distinct')
  })

  it('treats a shared link as near-proof', () => {
    const a = listing({ id: 'a', sourceSlug: 'severn', title: 'Fall Fair', url: 'https://coldwaterfair.ca/2026/' })
    const b = listing({
      id: 'b',
      sourceSlug: 'orilliamatters',
      municipalitySlug: null,
      title: 'Coldwater Agricultural Society Fair',
      url: 'http://www.coldwaterfair.ca/2026?utm=x',
    })
    expect(scorePair(a, b).url).toBe(1)
    expect(verdictByRules(scorePair(a, b))).toBe('same')
  })

  it('ignores weekday and month words, which are dates rather than identity', () => {
    expect(titleSimilarity('Women Connect - September', 'Women Connect - Sep 2026')).toBeGreaterThan(0.95)
    expect(verdictByRules(scorePair(
      listing({ id: 'a', sourceSlug: 'bradford-west-gwillimbury', municipalitySlug: 'bradford-west-gwillimbury', title: 'Wildcard Wednesday' }),
      listing({ id: 'b', sourceSlug: 'orilliamatters', municipalitySlug: null, title: 'Boots and Boards: Wednesday Line Dancing at Sainte-Marie' }),
    ))).toBe('distinct')
  })

  it('never auto-merges listings that start on different dates, even inside a span', () => {
    const run = listing({ id: 'a', sourceSlug: 'collingwoodtoday', municipalitySlug: null, title: 'Tuesdays With Morrie', localDate: '2026-09-22', startsAtUtc: '2026-09-22T23:30:00.000Z', endsAtUtc: '2026-09-26T23:30:00.000Z' })
    const night = listing({ id: 'b', sourceSlug: 'collingwood', municipalitySlug: 'collingwood', title: 'Theatre Collingwood presents Tuesdays With Morrie', localDate: '2026-09-24', startsAtUtc: '2026-09-24T23:30:00.000Z' })
    expect(verdictByRules(scorePair(run, night))).not.toBe('same')
  })

  it('leaves a partial title match at a matching time for the judge', () => {
    const a = listing({ id: 'a', sourceSlug: 'severn', title: 'Harvest Supper' })
    const b = listing({ id: 'b', sourceSlug: 'orilliamatters', municipalitySlug: null, title: 'Coldwater United Church Harvest Supper and Silent Auction' })
    expect(verdictByRules(scorePair(a, b))).toBe('ambiguous')
  })
})

describe('buildClusters', () => {
  const township = listing({ id: 'severn:1', sourceSlug: 'severn', title: 'Coldwater Fall Fair', address: '2 Coldwater Rd' })
  const county = listing({
    id: 'simcoe-county:2',
    sourceSlug: 'simcoe-county',
    sourceKind: 'county',
    title: 'Coldwater Fall Fair 2026',
    description: 'Midway, livestock, pie contest.',
    costText: '$10',
    cost: 'paid',
  })
  const other = listing({ id: 'orilliamatters:9', sourceSlug: 'orilliamatters', sourceKind: 'media', municipalitySlug: null, title: 'Steampunk Festival' })

  it('merges same-edges into one event led by the highest-priority source and fills gaps from members', () => {
    const { events, assignments } = buildClusters({
      listings: [township, county, other],
      sameEdges: [['severn:1', 'simcoe-county:2']],
      existingClusters: [],
      priorityOf: priority,
    })
    expect(events).toHaveLength(2)
    const fair = events.find((e) => e.id === 'severn:1')!
    expect(fair.representativeId).toBe('severn:1')
    expect(fair.title).toBe('Coldwater Fall Fair')
    expect(fair.listingIds).toEqual(['severn:1', 'simcoe-county:2'])
    expect(fair.sourceSlugs).toEqual(['severn', 'simcoe-county'])
    expect(fair.description).toBe('Midway, livestock, pie contest.')
    expect(fair.cost).toBe('paid')
    expect(fair.address).toBe('2 Coldwater Rd')
    expect(assignments).toContainEqual({ listingId: 'simcoe-county:2', clusterId: 'severn:1' })
  })

  it('keeps the existing cluster id when members are re-clustered, and closes orphaned clusters', () => {
    const withCluster = { ...county, clusterId: 'old-cluster' }
    const { events, closed } = buildClusters({
      listings: [township, withCluster],
      sameEdges: [['severn:1', 'simcoe-county:2']],
      existingClusters: [
        { id: 'old-cluster', createdAt: '2026-09-01T00:00:00Z' },
        { id: 'gone', createdAt: '2026-09-02T00:00:00Z' },
      ],
      priorityOf: priority,
    })
    expect(events[0]!.id).toBe('old-cluster')
    expect(events[0]!.representativeId).toBe('severn:1')
    expect(closed).toEqual(['gone'])
  })

  it('never chains two placed municipalities together through an unplaced copy', () => {
    const barrie = listing({ id: 'barrie:1', sourceSlug: 'barrie', municipalitySlug: 'barrie', title: 'Sunrise Ceremony' })
    const penetang = listing({ id: 'penetanguishene:1', sourceSlug: 'penetanguishene', municipalitySlug: 'penetanguishene', title: 'National Day for Truth and Reconciliation' })
    const copy = listing({ id: 'barrietoday:1', sourceSlug: 'barrietoday', municipalitySlug: null, title: 'National Day for Truth and Reconciliation' })
    const { events } = buildClusters({
      listings: [barrie, penetang, copy],
      sameEdges: [['barrietoday:1', 'penetanguishene:1', 0.93], ['barrie:1', 'barrietoday:1', 0.81]],
      existingClusters: [],
      priorityOf: priority,
    })
    expect(events).toHaveLength(2)
    const merged = events.find((e) => e.listingIds.includes('barrietoday:1'))!
    expect(merged.listingIds).toEqual(['barrietoday:1', 'penetanguishene:1'])
    expect(merged.municipalitySlug).toBe('penetanguishene')
  })

  it('marks a cluster inactive when all its listings are, and cancelled when any active member says so', () => {
    const gone = { ...township, active: false }
    const { events } = buildClusters({ listings: [gone], sameEdges: [], existingClusters: [], priorityOf: priority })
    expect(events[0]!.active).toBe(false)
    const cancelledCopy = { ...county, status: 'cancelled' as const }
    const { events: e2 } = buildClusters({
      listings: [township, cancelledCopy],
      sameEdges: [['severn:1', 'simcoe-county:2']],
      existingClusters: [],
      priorityOf: priority,
    })
    expect(e2[0]!.status).toBe('cancelled')
  })
})

describe('eventFromCluster', () => {
  /* The console rebuilds one event after an edit with this; it must be exactly what the
     next ingest run would write, or an edit would flicker between two versions. */
  it('builds the event buildClusters does for the same members', () => {
    const a = listing({ id: 'severn:1', sourceSlug: 'severn', venueName: 'Coldwater Hall' })
    const b = listing({ id: 'orilliamatters:9', sourceSlug: 'orilliamatters', description: 'Pie tent.', cost: 'free' })
    const { events } = buildClusters({ listings: [a, b], sameEdges: [[a.id, b.id]], existingClusters: [], priorityOf: priority })
    expect(events).toHaveLength(1)
    expect(eventFromCluster(events[0]!.id, [b, a], priority)).toEqual(events[0])
  })
})
