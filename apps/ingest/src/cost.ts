import { assessCost, containsMoney, enabledSources, looksLikeFundraising, type Cost } from '@scec/core'
import { DETAIL_FETCHERS } from '@scec/adapters'
import {
  costDecisionStatements,
  loadCostCandidates,
  runBatched,
  setListingCostStatements,
  type CostCandidate,
  type CostDecisionRow,
  type D1Like,
} from './repository.ts'
import type { CostJudge } from './cost-judge.ts'

export interface CostPassStats {
  /** Listings sent to the judge this run. */
  read: number
  /** Verdicts that survived the checks and changed a listing. */
  resolved: number
  free: number
  paid: number
  /** The model pointed at words that are not in the listing. */
  unquoted: number
  /** A quote that turned out not to be about the price of getting in. */
  inconclusive: number
  /** Unclear listings still waiting for a reading. */
  remaining: number
}

export interface CostPassOptions {
  /** Listings per run. Ten to a request, so this is the token bill's upper bound. */
  budget?: number
  now?: string
}

/** Whitespace and case are not what is being verified; the words are. */
const flatten = (text: string): string =>
  text.toLowerCase().replace(/\s+/g, ' ').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').trim()

/** Longer than this is a paragraph, not a price line, whatever it contains. */
const MAX_PRICE_LINE = 140

export type CostRejection = 'no-quote' | 'unquoted' | 'inconclusive'

export interface CostDecision {
  verdict: 'free' | 'paid' | 'unclear'
  quote: string | null
  /** Why an unclear verdict is unclear, which is what the run summary counts. */
  rejected?: CostRejection
}

/**
 * What a reading is allowed to change, and what stands between it and the listing.
 *
 * The quote must appear in the listing's own words, which disposes of anything invented.
 * Then the ordinary cost rules read the quote, so the model chooses the sentence and the
 * rules still decide what it means: a quote about a raffle prize or the arena's drop-in
 * rates reaches the rules and gets no further.
 */
export function decideCost(
  candidate: { title: string; description: string },
  reading: { quote: string | null } | null,
): CostDecision {
  const quote = reading?.quote?.trim()
  if (!quote) return { verdict: 'unclear', quote: null, rejected: 'no-quote' }

  const source = flatten(`${candidate.title}\n${candidate.description}`)
  if (!source.includes(flatten(quote))) return { verdict: 'unclear', quote, rejected: 'unquoted' }

  /*
   * Read as prose, not as a cost field. A field a source labelled "Cost" is an answer, so
   * any sum in it is the price; a sentence a model picked out of a description is not,
   * and "raised $20,000 for local charities" would sail through on that reading.
   *
   * And the bar is higher for paid than for free, deliberately. A free event wrongly
   * marked paid disappears from the view almost everyone uses; the reverse merely
   * mislabels something that is still on the page.
   */
  const verdict = assessCost({ description: quote })
  if (verdict.cost === 'free') return { verdict: 'free', quote }
  if (verdict.cost === 'paid' && verdict.confidence === 'high') return { verdict: 'paid', quote }

  /*
   * A sum in a sentence the model picked out as the cost line is different from a sum
   * somewhere in a page of prose: the proximity rule that protects whole descriptions is
   * too strict here, and throws away real price lists like
   * "AM or PM: $55 Full Day: $75".
   *
   * What still has to be excluded is money being counted rather than charged — a total
   * raised, a prize, a grant — and anything long enough to be a paragraph rather than a
   * price line.
   */
  if (containsMoney(quote) && !looksLikeFundraising(quote) && quote.length <= MAX_PRICE_LINE) {
    return { verdict: 'paid', quote }
  }
  return { verdict: 'unclear', quote, rejected: 'inconclusive' }
}

/**
 * Ask a model to find the sentence that states the price, for listings the rules and the
 * event's own page both left unclear — and that contain a sum of money.
 *
 * The money test is what makes this worth running. The judge can only return a sentence
 * that is already in the listing, and `decideCost` then requires that sentence to state a
 * price, so a listing with no sum in it has nothing to find. Measured over the first 1,463
 * readings: every one of the 66 that produced a price came from a listing containing
 * money, and the other 1,371 returned "unclear" without exception. Asking only about the
 * ones with a sum in them cuts the calls by about 95% and loses nothing.
 *
 * It self-heals: if a source later adds a price to the text, the content hash changes, the
 * listing now contains money and becomes a candidate. And a missed reading is cheap —
 * the listing stays "unknown", which the default view shows alongside free.
 *
 * Every reading is cached against the listing's content hash, so the same words are never
 * paid for twice and an edited listing is read again. Nothing here can overrule a price a
 * source actually stated: candidates are only ever listings still marked unknown.
 */
export async function judgeCosts(db: D1Like, judge: CostJudge, options: CostPassOptions = {}): Promise<CostPassStats> {
  const { budget = 200, now = new Date().toISOString() } = options
  const stats: CostPassStats = { read: 0, resolved: 0, free: 0, paid: 0, unquoted: 0, inconclusive: 0, remaining: 0 }
  if (judge.name === 'none') return stats

  const enrichable = enabledSources()
    .filter((source) => source.config.platform in DETAIL_FETCHERS)
    .map((source) => source.slug)

  const { candidates: screened, remaining } = await loadCostCandidates(db, enrichable, budget)
  stats.remaining = remaining
  // The SQL screen is a loose superset of MONEY; this is the pattern itself.
  const candidates = screened.filter((c) => containsMoney(`${c.title}\n${c.description}`))
  if (candidates.length === 0) return stats

  const readings = await judge.read(
    candidates.map((c) => ({ id: c.id, title: c.title, description: c.description, source: c.sourceName })),
  )
  stats.read = candidates.length

  const decisions: CostDecisionRow[] = []
  const updates: Array<{ id: string; cost: Cost; costText: string }> = []

  candidates.forEach((candidate, i) => {
    const decision = decideCost(candidate, readings[i] ?? null)
    decisions.push({
      listingId: candidate.id,
      contentHash: candidate.contentHash,
      verdict: decision.verdict,
      quote: decision.quote,
    })

    if (decision.rejected === 'unquoted') stats.unquoted++
    if (decision.rejected === 'inconclusive') stats.inconclusive++
    if (decision.verdict === 'unclear') return

    stats.resolved++
    if (decision.verdict === 'free') stats.free++
    else stats.paid++
    updates.push({ id: candidate.id, cost: decision.verdict, costText: decision.quote!.slice(0, 120) })
  })

  await runBatched(db, [
    ...costDecisionStatements(db, decisions, judge.name, now),
    ...setListingCostStatements(db, updates),
  ])

  // Every candidate asked about is recorded, whatever the verdict, so all of them drop out
  // of the next run's count — not just the ones that resolved. The few the SQL screen let
  // through and the money test dropped stay in it, and stay cheap: they cost a row in a
  // query, never a call.
  stats.remaining = Math.max(0, remaining - candidates.length)
  return stats
}

export type { CostCandidate }
