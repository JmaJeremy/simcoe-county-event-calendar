import { describe, expect, it } from 'vitest'
import {
  chooseSlate,
  detectSeries,
  postKeyOf,
  rankCandidates,
  scoreCandidate,
  seriesKeyOf,
  type SocialCandidate,
} from '../src/social-select.ts'

/**
 * Selection is the part of the social bot a reader would notice going wrong: the same
 * storytime every Tuesday, five posts from Barrie, or a day of ticketed concerts on a
 * site whose default view is the free things. None of that is the model's to get right —
 * every rule here is applied to whatever it answers — so it is all tested deterministically.
 */

const candidate = (over: Partial<SocialCandidate> & { id: string }): SocialCandidate => ({
  shortCode: over.id.slice(0, 7),
  municipalitySlug: 'tay',
  municipalityName: 'Township of Tay',
  title: 'Waubaushene Fall Fair',
  description: 'x'.repeat(300),
  category: 'community',
  startsAtUtc: '2026-10-03T14:00:00.000Z',
  localDate: '2026-10-03',
  localTime: '10:00',
  allDay: false,
  timePrecision: 'exact',
  venueName: 'Memorial Park',
  address: '12 Pine Street',
  cost: 'free',
  costText: null,
  organizer: 'Tay Recreation',
  url: 'https://example.invalid/fair',
  listingCount: 1,
  ...over,
})

const POST_DATE = '2026-10-03'
const slateOf = (candidates: SocialCandidate[], options = {}) =>
  chooseSlate(rankCandidates(candidates, { postDate: POST_DATE }), { postDate: POST_DATE, ...options })
const ids = (slate: ReturnType<typeof slateOf>) => slate.chosen.map((c) => c.candidate.id)

describe('identity keys', () => {
  /*
   * The whole reason a post is not keyed on the event id: on govStack, Drupal rows and
   * SPACES a reschedule mints a new cluster, and the replacement has to be recognised.
   */
  it('keys an event on its place, its title and its date, not on its cluster id', () => {
    const monday = candidate({ id: 'govstack:2026-10-03-fall-fair' })
    const moved = candidate({ id: 'govstack:2026-10-04-fall-fair', localDate: '2026-10-04' })
    // "Waubaushene" is a hamlet in the gazetteer, so the title tokens keep only what the
    // event is rather than where it is — the place is already in the key's first field.
    expect(postKeyOf(monday)).toBe('tay|fall fair|2026-10-03')
    expect(postKeyOf(monday)).not.toBe(postKeyOf(moved))
    // Same series either way, so the cooldown still sees one thing.
    expect(seriesKeyOf(monday)).toBe(seriesKeyOf(moved))
  })

  it('gives an unplaced event a bucket of its own rather than sharing one town', () => {
    expect(seriesKeyOf(candidate({ id: 'a', municipalitySlug: null }))).toMatch(/^unplaced\|/)
  })
})

describe('detectSeries', () => {
  /*
   * normalizeTitle's stopword list already eats weekday and month names, which is what
   * makes a weekly programme collapse without any date handling here.
   */
  it('collapses a weekly programme whose title carries the date', () => {
    const sizes = detectSeries([
      { municipalitySlug: 'barrie', title: 'Storytime — October 7' },
      { municipalitySlug: 'barrie', title: 'Storytime — October 14' },
      { municipalitySlug: 'barrie', title: 'Storytime — October 21' },
    ])
    expect([...sizes.values()]).toEqual([3])
  })

  it('keeps two townships\' markets apart', () => {
    const sizes = detectSeries([
      { municipalitySlug: 'tay', title: "Farmers' Market" },
      { municipalitySlug: 'essa', title: "Farmers' Market" },
    ])
    expect(sizes.size).toBe(2)
  })
})

describe('scoreCandidate', () => {
  it('rewards corroboration across sources above everything else', () => {
    const one = scoreCandidate(candidate({ id: 'a' }), { seriesSize: 1, postDate: POST_DATE })
    const three = scoreCandidate(candidate({ id: 'b', listingCount: 3 }), { seriesSize: 1, postDate: POST_DATE })
    expect(three.score - one.score).toBe(3)
    expect(three.signals).toContain('+3 three or more sources')
  })

  it('pushes a weekly programme down and a one-off up', () => {
    const one = scoreCandidate(candidate({ id: 'a' }), { seriesSize: 1, postDate: POST_DATE })
    const weekly = scoreCandidate(candidate({ id: 'a' }), { seriesSize: 8, postDate: POST_DATE })
    expect(one.score).toBeGreaterThan(weekly.score)
    expect(weekly.signals).toContain('-4 one of 8 in a series')
  })

  it('marks down an event no town could be resolved for, which a post cannot place', () => {
    const placed = scoreCandidate(candidate({ id: 'a' }), { seriesSize: 1, postDate: POST_DATE })
    const unplaced = scoreCandidate(candidate({ id: 'a', municipalitySlug: null }), { seriesSize: 1, postDate: POST_DATE })
    expect(placed.score - unplaced.score).toBe(2)
  })

  it('marks down a title with nothing in it once the filler is stripped', () => {
    const vague = scoreCandidate(candidate({ id: 'a', title: 'Community Event' }), { seriesSize: 1, postDate: POST_DATE })
    expect(vague.signals).toContain('-1.5 a title with nothing in it')
  })

  it('marks down a listing with barely any description to write from', () => {
    const thin = scoreCandidate(candidate({ id: 'a', description: 'Come along.' }), { seriesSize: 1, postDate: POST_DATE })
    expect(thin.signals).toContain('-2 barely described')
  })
})

describe('chooseSlate', () => {
  const CATEGORIES = ['music', 'arts', 'family', 'outdoors', 'markets', 'sports'] as const

  /** Distinct town, category and title each, so a test only meets the quota it is about. */
  const many = (n: number, over: (i: number) => Partial<SocialCandidate> = () => ({})) =>
    Array.from({ length: n }, (_, i) =>
      candidate({
        id: `e${i}`,
        title: `Something ${'x'.repeat(i + 1)}`,
        municipalitySlug: `town-${i}`,
        category: CATEGORIES[i % CATEGORIES.length]!,
        ...over(i),
      }),
    )

  it('takes at most five', () => {
    expect(slateOf(many(9)).chosen).toHaveLength(5)
  })

  it('says so when there are not enough eligible events to fill a day', () => {
    const slate = slateOf(many(2))
    expect(slate.short).toBe(true)
    expect(slate.chosen).toHaveLength(2)
  })

  /*
   * The user's rule: mostly free, one or two paid. Enforced after the model answers, so
   * a model that liked five concerts cannot spend the day on them.
   */
  it('never lets paid events outnumber the free ones', () => {
    const mixed = [
      ...many(3),
      ...many(4, (i) => ({ cost: 'paid' as const, listingCount: 3 })).map((c, i) => ({
        ...c,
        id: `p${i}`,
        municipalitySlug: `paid-town-${i}`,
        title: `Concert ${'y'.repeat(i + 1)}`,
      })),
    ]
    const slate = slateOf(mixed)
    const paid = slate.chosen.filter((c) => c.candidate.cost === 'paid')
    expect(slate.chosen).toHaveLength(5)
    expect(paid).toHaveLength(2)
    expect(paid.length * 2).toBeLessThanOrEqual(slate.chosen.length)
  })

  /*
   * Caught against the live database: filling with free events first and giving paid
   * whatever is left means a normal day — which offers more than five good free events —
   * never posts a paid one at all, and the county's biggest concert goes unmentioned. The
   * first pass leaves the paid allowance empty for exactly this reason.
   */
  it('still posts a paid event on a day with plenty of free ones', () => {
    const plenty = [
      ...many(9),
      ...many(2, () => ({ cost: 'paid' as const })).map((c, i) => ({
        ...c,
        id: `p${i}`,
        municipalitySlug: `paid-town-${i}`,
        title: `Concert ${'y'.repeat(i + 1)}`,
      })),
    ]
    const slate = slateOf(plenty)
    expect(slate.chosen).toHaveLength(5)
    expect(slate.chosen.filter((c) => c.candidate.cost === 'paid')).toHaveLength(2)
  })

  it('gives the held-back slots back to the free events when no paid one qualifies', () => {
    const slate = slateOf(many(9))
    expect(slate.chosen).toHaveLength(5)
    expect(slate.chosen.every((c) => c.candidate.cost === 'free')).toBe(true)
  })

  /*
   * The case the quota is really for: a thin day. Left to itself the ranking would fill
   * the empty slots with ticketed concerts, which is not what the site is for — so a
   * short slate stays short rather than becoming a paid one.
   */
  it('leaves a thin day short rather than filling it with paid events', () => {
    const thin = [
      ...many(1),
      ...many(3, () => ({ cost: 'paid' as const, listingCount: 3 })).map((c, i) => ({
        ...c,
        id: `p${i}`,
        municipalitySlug: `paid-town-${i}`,
        title: `Concert ${'y'.repeat(i + 1)}`,
      })),
    ]
    const slate = slateOf(thin)
    expect(slate.chosen.filter((c) => c.candidate.cost === 'paid')).toHaveLength(1)
    expect(slate.chosen).toHaveLength(2)
    expect(slate.short).toBe(true)
    expect(slate.rejected.some((r) => r.reason === 'paid-quota')).toBe(true)
  })

  it('posts at most one event whose cost is not listed, and never calls it free', () => {
    const slate = slateOf(many(5, () => ({ cost: 'unknown' as const })))
    expect(slate.chosen.filter((c) => c.candidate.cost === 'unknown')).toHaveLength(1)
    expect(slate.rejected.some((r) => r.reason === 'unknown-quota')).toBe(true)
  })

  it('spreads across the county rather than filling the day with Barrie', () => {
    const slate = slateOf(many(6, () => ({ municipalitySlug: 'barrie' })))
    expect(slate.chosen).toHaveLength(2)
    expect(slate.rejected.some((r) => r.reason === 'municipality-full')).toBe(true)
  })

  it('spreads across categories too', () => {
    const slate = slateOf(many(6, () => ({ category: 'music' as const })))
    expect(slate.chosen).toHaveLength(2)
    expect(slate.rejected.some((r) => r.reason === 'category-full')).toBe(true)
  })

  it('takes one showing of a run, not four', () => {
    const run = Array.from({ length: 4 }, (_, i) =>
      candidate({ id: `run${i}`, title: 'The Maids', localDate: `2026-10-0${i + 3}` }),
    )
    expect(slateOf(run).chosen).toHaveLength(1)
  })

  /*
   * Storytime every Tuesday for ever is the failure this exists to stop. Only live or
   * sent rows feed the cooldown, so an unapproved draft never holds a series out.
   */
  it('holds a series back for the cooldown after it has been posted', () => {
    const recent = new Map([[seriesKeyOf(candidate({ id: 'a' })), '2026-09-20']])
    const slate = slateOf([candidate({ id: 'a' })], { recentSeries: recent })
    expect(slate.chosen).toHaveLength(0)
    expect(slate.rejected[0]?.reason).toBe('cooldown')
  })

  it('lets a series back in once the cooldown has passed', () => {
    const recent = new Map([[seriesKeyOf(candidate({ id: 'a' })), '2026-08-01']])
    expect(slateOf([candidate({ id: 'a' })], { recentSeries: recent }).chosen).toHaveLength(1)
  })

  describe("the model's picks", () => {
    const pool = () => many(6)

    it('honours them where the quotas allow', () => {
      const scored = rankCandidates(pool(), { postDate: POST_DATE })
      const last = scored.length - 1
      const slate = chooseSlate(scored, { postDate: POST_DATE, picks: [last] })
      expect(ids(slate)).toContain(scored[last]!.candidate.id)
    })

    it('drops an index it invented rather than resolving it to whatever sits there', () => {
      const scored = rankCandidates(pool(), { postDate: POST_DATE })
      const slate = chooseSlate(scored, { postDate: POST_DATE, picks: [99, -1, 1.5, 0] })
      expect(slate.chosen.length).toBeGreaterThan(0)
      expect(ids(slate)).toContain(scored[0]!.candidate.id)
    })

    it('cannot use them to break a quota', () => {
      const barrie = many(4, () => ({ municipalitySlug: 'barrie' }))
      const scored = rankCandidates(barrie, { postDate: POST_DATE })
      const slate = chooseSlate(scored, { postDate: POST_DATE, picks: [0, 1, 2, 3] })
      expect(slate.chosen).toHaveLength(2)
    })
  })

  it('chooses the same slate twice over the same data', () => {
    const pool = many(7)
    expect(ids(slateOf(pool))).toEqual(ids(slateOf([...pool].reverse())))
  })
})
