import { normalizeTitle, type Category, type Cost, type TimePrecision } from '@scec/core'

/**
 * Which of the county's events are worth a post today, decided deterministically.
 *
 * Pure on purpose: no database, no clock, no model. The judge that follows picks from a
 * shortlist this module ranks, and every quota here is re-applied to whatever it answers,
 * so nothing a model says can put a paid event in a free slot, post a weekly programme
 * for the fifth week running, or fill a day with Barrie.
 *
 * The scoring weights are a starting point to tune against real drafts, not a result.
 */

/** One event, as much of it as selection needs. Mirrors the columns loadSocialCandidates reads. */
export interface SocialCandidate {
  id: string
  shortCode: string
  municipalitySlug: string | null
  municipalityName: string | null
  title: string
  description: string | null
  category: Category
  startsAtUtc: string
  localDate: string
  localTime: string
  allDay: boolean
  timePrecision: TimePrecision
  venueName: string | null
  address: string | null
  cost: Cost
  costText: string | null
  organizer: string | null
  url: string
  listingCount: number
}

export interface ScoredCandidate {
  candidate: SocialCandidate
  score: number
  /** What the score is made of, for the dry run and the console. Never shown to readers. */
  signals: string[]
  postKey: string
  seriesKey: string
  seriesSize: number
}

/** Why a candidate the ranking offered did not make the slate. */
export type SlateRejection =
  | 'cooldown'
  | 'series-in-slate'
  | 'municipality-full'
  | 'category-full'
  | 'paid-quota'
  | 'unknown-quota'
  | 'slate-full'

export interface SlateOptions {
  /** The America/Toronto date the slate is for. */
  postDate: string
  min?: number
  max?: number
  maxPaid?: number
  maxUnknownCost?: number
  perMunicipality?: number
  perCategory?: number
  cooldownDays?: number
  /** seriesKey -> the most recent post_date for it. Only live or sent rows belong here. */
  recentSeries?: ReadonlyMap<string, string>
  /**
   * Indexes into the scored list, in the model's own order of preference. Honoured where
   * the quotas allow; anything out of range is dropped rather than trusted.
   */
  picks?: readonly number[]
}

export interface Slate {
  chosen: ScoredCandidate[]
  rejected: { candidate: SocialCandidate; reason: SlateRejection }[]
  /** True when there were not enough eligible events to reach `min`. */
  short: boolean
}

const DEFAULTS = {
  min: 3,
  max: 5,
  maxPaid: 2,
  maxUnknownCost: 1,
  perMunicipality: 2,
  perCategory: 2,
  cooldownDays: 45,
} as const

/** Events with no municipality still need a bucket, for the spread and the cooldown alike. */
const UNPLACED = 'unplaced'

/**
 * Dedup's title tokens, with a bare day number dropped as well.
 *
 * `normalizeTitle` takes month and weekday names out — "Women Connect — September" and
 * "Women Connect — October" are one thing to it — but leaves a plain number standing, so
 * "Storytime — October 7" and "Storytime — October 14" come back as `storytime 7` and
 * `storytime 14`. Dedup does not care, because it scores similarity rather than comparing
 * keys; the cooldown does, because those are exactly the weekly programmes it exists to
 * post once. One or two digits only, so a "5K" or a "Rocky III" keeps its identity.
 */
const titleKey = (title: string): string =>
  normalizeTitle(title).filter((token) => !/^\d{1,2}$/.test(token)).join(' ')

/**
 * What the event IS, rather than which cluster it happens to be in.
 *
 * On govStack, Drupal rows and SPACES the platform's id encodes the date, so a
 * rescheduled event arrives as a new cluster with a new id and short code. Keyed on the
 * id, "have we posted this?" would answer no and it would go out twice.
 */
export const postKeyOf = (event: { municipalitySlug: string | null; title: string; localDate: string }): string =>
  `${event.municipalitySlug ?? UNPLACED}|${titleKey(event.title)}|${event.localDate}`

/** The same without the date: one storytime and next Tuesday's storytime share it. */
export const seriesKeyOf = (event: { municipalitySlug: string | null; title: string }): string =>
  `${event.municipalitySlug ?? UNPLACED}|${titleKey(event.title)}`

/**
 * How many events share each series key across the surrounding window.
 *
 * This is the difference between a fair nobody has seen before and the 40th tech-help
 * slot, and it is the single strongest signal the ranking has. It uses dedup's own
 * normalizeTitle, whose stopword list already eats weekday and month names, so
 * "Storytime — October 7" and "Storytime — October 14" collapse to one series.
 */
export function detectSeries(
  events: readonly { municipalitySlug: string | null; title: string }[],
): Map<string, number> {
  const sizes = new Map<string, number>()
  for (const event of events) {
    const key = seriesKeyOf(event)
    sizes.set(key, (sizes.get(key) ?? 0) + 1)
  }
  return sizes
}

const dayOfWeek = (localDate: string): number => {
  const [y, m, d] = localDate.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()
}

const daysBetween = (from: string, to: string): number => {
  const parse = (s: string) => {
    const [y, m, d] = s.split('-').map(Number)
    return Date.UTC(y!, m! - 1, d!)
  }
  return Math.round((parse(to) - parse(from)) / 86_400_000)
}

/** Categories that read as an outing rather than as an errand. */
const OUTING: ReadonlySet<Category> = new Set<Category>(['music', 'arts', 'markets', 'family', 'outdoors'])

/**
 * How interesting this event is, from columns alone.
 *
 * Every signal is something the database already knows. The strongest is corroboration:
 * dedup merging three sources onto one event is the closest thing here to an editor
 * saying it matters.
 */
export function scoreCandidate(
  candidate: SocialCandidate,
  context: { seriesSize: number; postDate: string },
): { score: number; signals: string[] } {
  const signals: string[] = []
  let score = 0
  const add = (points: number, why: string) => {
    score += points
    signals.push(`${points > 0 ? '+' : ''}${points} ${why}`)
  }

  if (candidate.listingCount >= 3) add(3, 'three or more sources')
  else if (candidate.listingCount >= 2) add(2, 'two sources')

  if (candidate.address) add(1, 'has an address')
  else if (candidate.venueName) add(0.5, 'has a venue')

  const described = candidate.description?.length ?? 0
  if (described >= 200 && described <= 2000) add(1.5, 'a real description')
  else if (described < 120) add(-2, 'barely described')

  // A one-off is the whole point; a weekly programme is what the cooldown exists for.
  if (context.seriesSize <= 1) add(2.5, 'a one-off')
  else if (context.seriesSize >= 5) add(-4, `one of ${context.seriesSize} in a series`)

  if (OUTING.has(candidate.category)) add(1.5, `category ${candidate.category}`)
  else if (candidate.category === 'sports') add(0.75, 'category sports')

  const weekday = dayOfWeek(candidate.localDate)
  const evening = !candidate.allDay && candidate.localTime >= '17:00'
  if (weekday === 0 || weekday === 6) add(0.75, 'at the weekend')
  else if (evening) add(0.75, 'in the evening')

  if (candidate.organizer) add(0.25, 'names an organizer')

  // A post that cannot say where is a post nobody can act on.
  if (!candidate.municipalitySlug) add(-2, 'no municipality')

  if (candidate.allDay || candidate.timePrecision === 'date-only') add(-0.5, 'no stated time')

  // "Community Event" says nothing, and there is no hook to be written from it.
  if (normalizeTitle(candidate.title).length < 2) add(-1.5, 'a title with nothing in it')

  if (candidate.localDate === context.postDate) add(1, 'on today')

  return { score, signals }
}

/**
 * Rank every candidate, cheapest signal first.
 *
 * Ties break on the event id so two runs over the same data choose the same slate: the
 * draft pass is idempotent only if this is.
 */
export function rankCandidates(
  candidates: readonly SocialCandidate[],
  options: { postDate: string; seriesSizes?: ReadonlyMap<string, number> },
): ScoredCandidate[] {
  const sizes = options.seriesSizes ?? detectSeries(candidates)
  return candidates
    .map((candidate) => {
      const seriesKey = seriesKeyOf(candidate)
      const seriesSize = sizes.get(seriesKey) ?? 1
      const { score, signals } = scoreCandidate(candidate, { seriesSize, postDate: options.postDate })
      return {
        candidate,
        score,
        signals,
        seriesSize,
        seriesKey,
        postKey: postKeyOf(candidate),
      }
    })
    .sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id))
}

/** Paid events allowed in a slate of this size. Majority free is structural, not a wish. */
const paidAllowance = (total: number, maxPaid: number): number => Math.min(maxPaid, Math.floor(total / 2))

/**
 * Choose the day's events from the ranking, applying every quota.
 *
 * Three passes, and the order is the whole design. Filling with free events first and
 * letting paid have what is left sounds right and is wrong: measured against the live
 * database, a normal day offers more than five good free events, so the slate filled
 * before a single paid one was considered and the county's biggest concert never got
 * posted. So the first pass leaves the paid allowance empty, the second offers it to the
 * paid events, and the third gives back whatever they did not take.
 *
 * A paid event is still only ever added while the slate can carry it without tipping past
 * half, which is why the model's preference for one can be honoured in position but never
 * in count: the reader who wants the free things is the one the site's default view is
 * built for.
 */
export function chooseSlate(scored: readonly ScoredCandidate[], options: SlateOptions): Slate {
  const {
    min, max, maxPaid, maxUnknownCost, perMunicipality, perCategory, cooldownDays,
  } = { ...DEFAULTS, ...options }
  const recentSeries = options.recentSeries ?? new Map<string, string>()

  // The model's picks lead, in its order, and the ranking supplies the rest. An index it
  // invented is dropped rather than resolved to whatever happens to sit there.
  const order: ScoredCandidate[] = []
  const seen = new Set<number>()
  for (const index of options.picks ?? []) {
    if (Number.isInteger(index) && index >= 0 && index < scored.length && !seen.has(index)) {
      seen.add(index)
      order.push(scored[index]!)
    }
  }
  for (let i = 0; i < scored.length; i++) if (!seen.has(i)) order.push(scored[i]!)

  const chosen: ScoredCandidate[] = []
  // Keyed by candidate and overwritten, not appended: an event passed over in the first
  // pass because its slot was being held for a paid event may well be taken in the third,
  // and a reader of the dry run should see the reason that stuck, once.
  const rejected = new Map<ScoredCandidate, SlateRejection>()
  const byMunicipality = new Map<string, number>()
  const byCategory = new Map<Category, number>()
  const seriesTaken = new Set<string>()
  let unknownCost = 0
  let paid = 0

  const consider = (item: ScoredCandidate, isPaidPass: boolean, ceiling = max): void => {
    if (chosen.length >= ceiling) {
      rejected.set(item, 'slate-full')
      return
    }
    const last = recentSeries.get(item.seriesKey)
    if (last && daysBetween(last, options.postDate) < cooldownDays) {
      rejected.set(item, 'cooldown')
      return
    }
    if (seriesTaken.has(item.seriesKey)) {
      rejected.set(item, 'series-in-slate')
      return
    }
    const place = item.candidate.municipalitySlug ?? UNPLACED
    if ((byMunicipality.get(place) ?? 0) >= perMunicipality) {
      rejected.set(item, 'municipality-full')
      return
    }
    if ((byCategory.get(item.candidate.category) ?? 0) >= perCategory) {
      rejected.set(item, 'category-full')
      return
    }
    // Eligible, and posted without a price: at most one a day, and the renderer says
    // nothing about cost for it. Excluding them would starve the pool, since most
    // community events never state a price; calling them free would be a claim.
    if (item.candidate.cost === 'unknown' && unknownCost >= maxUnknownCost) {
      rejected.set(item, 'unknown-quota')
      return
    }
    if (isPaidPass && paid + 1 > paidAllowance(chosen.length + 1, maxPaid)) {
      rejected.set(item, 'paid-quota')
      return
    }

    chosen.push(item)
    seriesTaken.add(item.seriesKey)
    byMunicipality.set(place, (byMunicipality.get(place) ?? 0) + 1)
    byCategory.set(item.candidate.category, (byCategory.get(item.candidate.category) ?? 0) + 1)
    if (item.candidate.cost === 'unknown') unknownCost++
    if (isPaidPass) paid++
  }

  // Slots held back from the first pass, so the paid events are considered while there is
  // still room for them. Nothing is held back if the day offers no paid event at all.
  const wanted = order.some((item) => item.candidate.cost === 'paid') ? paidAllowance(max, maxPaid) : 0
  const taken = new Set<ScoredCandidate>()
  const pass = (wantPaid: boolean, ceiling: number) => {
    for (const item of order) {
      if (taken.has(item) || (item.candidate.cost === 'paid') !== wantPaid) continue
      const before = chosen.length
      consider(item, wantPaid, ceiling)
      if (chosen.length > before) taken.add(item)
    }
  }
  pass(false, max - wanted)
  pass(true, max)
  // Whatever the paid events did not take goes back to the free ones.
  pass(false, max)

  // Back into the ranking's order, so the day reads best-first however it was assembled.
  chosen.sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id))
  return {
    chosen,
    rejected: [...rejected]
      .filter(([item]) => !taken.has(item))
      .map(([item, reason]) => ({ candidate: item.candidate, reason })),
    short: chosen.length < min,
  }
}
