import {
  buildClusters,
  candidatePairs,
  scorePair,
  sourceBySlug,
  verdictByRules,
  type ClusterableListing,
  type Listing,
  type PairScore,
} from '@scec/core'
import {
  assignClusterStatements,
  deactivateEventStatements,
  decisionStatements,
  loadDecisions,
  loadExistingClusters,
  loadListingsForDedup,
  recordDedupRun,
  rowToListing,
  runBatched,
  upsertEventStatements,
  type D1Like,
  type DecisionRow,
} from './repository.ts'

/**
 * The de-duplication pass: everything the pure core cannot do because it needs the
 * database or a model. Runs once per ingest, after every source has been reconciled.
 *
 *   1. load the window's listings and every verdict already cached for them
 *   2. block + score candidate pairs; rules settle the clear ones
 *   3. ambiguous, uncached pairs go to the Judge (an LLM, or nothing)
 *   4. cache every new verdict, cluster over the "same" edges, write events
 */

export interface JudgeInput {
  a: Listing
  b: Listing
  score: PairScore
}

export interface JudgeVerdict {
  same: boolean
  confidence: number
  reason: string
}

export interface Judge {
  name: string
  /** One verdict per input, in order; null when the judge could not decide. */
  judge(pairs: JudgeInput[]): Promise<Array<JudgeVerdict | null>>
}

/** Ambiguous pairs stay unmerged. The honest default when no model is configured. */
export const noJudge: Judge = {
  name: 'none',
  async judge(pairs) {
    return pairs.map(() => null)
  },
}

export interface DedupStats {
  listings: number
  pairs: number
  ruleSame: number
  ruleDistinct: number
  cached: number
  llmCalls: number
  llmSame: number
  unresolved: number
  clusters: number
  closed: number
}

const decisionKey = (a: string, b: string): string => `${a} ${b}`

export async function runDedup(db: D1Like, window: { from: string; to: string }, judge: Judge = noJudge): Promise<DedupStats> {
  const startedAt = new Date().toISOString()
  const stats: DedupStats = {
    listings: 0,
    pairs: 0,
    ruleSame: 0,
    ruleDistinct: 0,
    cached: 0,
    llmCalls: 0,
    llmSame: 0,
    unresolved: 0,
    clusters: 0,
    closed: 0,
  }

  try {
    const rows = await loadListingsForDedup(db, window.from, window.to)
    const listings: ClusterableListing[] = rows.map((r) => rowToListing(r, sourceBySlug(r.source_slug)?.kind ?? 'media'))
    stats.listings = listings.length

    const pairs = candidatePairs(listings)
    stats.pairs = pairs.length
    const cached = new Map<string, DecisionRow>()
    for (const d of await loadDecisions(db, [...new Set(pairs.map(([a]) => a.id))])) {
      cached.set(decisionKey(d.listing_a, d.listing_b), d)
    }

    const sameEdges: Array<[string, string]> = []
    const newDecisions: DecisionRow[] = []
    const toJudge: JudgeInput[] = []

    for (const [a, b] of pairs) {
      const prior = cached.get(decisionKey(a.id, b.id))
      // A cached verdict holds as long as neither side's content changed.
      if (prior && prior.hash_a === a.contentHash && prior.hash_b === b.contentHash) {
        stats.cached++
        if (prior.verdict === 'same') sameEdges.push([a.id, b.id])
        continue
      }
      const score = scorePair(a, b)
      const verdict = verdictByRules(score)
      if (verdict === 'ambiguous') {
        toJudge.push({ a, b, score })
        continue
      }
      if (verdict === 'same') {
        stats.ruleSame++
        sameEdges.push([a.id, b.id])
      } else {
        stats.ruleDistinct++
      }
      newDecisions.push({
        listing_a: a.id,
        listing_b: b.id,
        hash_a: a.contentHash,
        hash_b: b.contentHash,
        verdict,
        method: 'rule',
        score: score.score,
        confidence: null,
        reasoning: null,
      })
    }

    if (toJudge.length) {
      const verdicts = await judge.judge(toJudge)
      stats.llmCalls = judge.name === 'none' ? 0 : toJudge.length
      toJudge.forEach(({ a, b, score }, i) => {
        const v = verdicts[i]
        if (!v) {
          stats.unresolved++
          return
        }
        if (v.same) {
          stats.llmSame++
          sameEdges.push([a.id, b.id])
        }
        newDecisions.push({
          listing_a: a.id,
          listing_b: b.id,
          hash_a: a.contentHash,
          hash_b: b.contentHash,
          verdict: v.same ? 'same' : 'distinct',
          method: judge.name,
          score: score.score,
          confidence: v.confidence,
          reasoning: v.reason.slice(0, 500),
        })
      })
    }

    const existingClusters = (await loadExistingClusters(db, window.from, window.to)).map((c) => ({ id: c.id, createdAt: c.created_at }))
    const { events, assignments, closed } = buildClusters({
      listings,
      sameEdges,
      existingClusters,
      priorityOf: (slug) => sourceBySlug(slug)?.priority ?? 50,
    })
    stats.clusters = events.length
    stats.closed = closed.length

    const currentCluster = new Map(listings.map((l) => [l.id, l.clusterId ?? null]))
    const now = new Date().toISOString()
    await runBatched(db, [
      ...decisionStatements(db, newDecisions, now),
      ...upsertEventStatements(db, events, now),
      ...assignClusterStatements(db, assignments.filter((a) => currentCluster.get(a.listingId) !== a.clusterId)),
      ...deactivateEventStatements(db, closed, now),
    ])
    await recordDedupRun(db, { startedAt, finishedAt: now, ...stats })
    return stats
  } catch (err) {
    await recordDedupRun(db, {
      startedAt,
      finishedAt: new Date().toISOString(),
      ...stats,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}
