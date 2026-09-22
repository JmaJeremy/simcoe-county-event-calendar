import { assessCost, enabledSources, sourceBySlug, type Cost, type EventDetail } from '@scec/core'
import { DETAIL_FETCHERS, mapLimit } from '@scec/adapters'
import {
  countEnrichmentBacklog,
  enrichListingStatements,
  loadEnrichmentCandidates,
  recordDetailFailureStatements,
  runBatched,
  type D1Like,
  type EnrichedListing,
  type EnrichmentCandidate,
} from './repository.ts'

export interface EnrichStats {
  /** Detail pages actually fetched this run. */
  fetched: number
  /** Listings whose cost moved off "not listed". */
  costResolved: number
  /** Listings that gained a poster. */
  images: number
  /** Listings whose description grew beyond the list view's truncation. */
  fuller: number
  failed: number
  /** Still waiting for a detail page after this run. */
  remaining: number
}

export interface EnrichOptions {
  /** How many detail pages one run may fetch. The subrequest budget is the real limit. */
  budget?: number
  /** Detail pages are small, and these are small municipal servers. */
  concurrency?: number
  now?: string
}

/**
 * Read the event's own page for listings whose list row was only a summary.
 *
 * govStack and Drupal both publish a truncated description in their list views and keep
 * the price, the poster and the full text on the event page. That is where "Adults:
 * $50.00" lives, and why 1,262 of 1,483 govStack listings arrived with no price at all.
 *
 * One page per listing per run is far beyond the subrequest budget, so this is a queue
 * rather than a sweep: each run takes the next `budget` listings that have never been
 * read, or whose list row changed since they were, soonest first. A few runs clear the
 * backlog; after that only new and edited events come through.
 */
export async function enrich(db: D1Like, options: EnrichOptions = {}): Promise<EnrichStats> {
  // 300 detail pages sit alongside ~320 list requests, far inside a paid Worker's 10,000
  // subrequests (1,000 until 2026-02-11), and clear a full backlog in a handful of runs.
  // The ceiling is not what this budget is for: the token bill and the wall clock are.
  // Note a D1 call is a subrequest too, so the real total is well above the HTTP count.
  const { budget = 300, concurrency = 5, now = new Date().toISOString() } = options
  const stats: EnrichStats = { fetched: 0, costResolved: 0, images: 0, fuller: 0, failed: 0, remaining: 0 }

  const slugs = enabledSources()
    .filter((source) => source.config.platform in DETAIL_FETCHERS)
    .map((source) => source.slug)
  if (slugs.length === 0) return stats

  const candidates = await loadEnrichmentCandidates(db, slugs, budget)
  if (candidates.length === 0) {
    stats.remaining = await countEnrichmentBacklog(db, slugs)
    return stats
  }

  const updates: EnrichedListing[] = []
  const failures: string[] = []

  await mapLimit(candidates, concurrency, async (candidate) => {
    const source = sourceBySlug(candidate.sourceSlug)
    const fetchDetail = source && DETAIL_FETCHERS[source.config.platform]
    if (!source || !fetchDetail) return

    try {
      const detail = await fetchDetail(source, candidate.url)
      const merged = merge(candidate, detail)
      stats.fetched++
      if (merged.cost !== 'unknown' && candidate.cost === 'unknown') stats.costResolved++
      if (merged.imageUrl && !candidate.imageUrl) stats.images++
      if ((merged.description?.length ?? 0) > (candidate.description?.length ?? 0)) stats.fuller++
      updates.push(merged)
    } catch {
      // A single unreachable page must not cost the other listings their turn, and must
      // not sit at the head of the queue forever: the attempt is counted instead.
      stats.failed++
      failures.push(candidate.id)
    }
  })

  await runBatched(db, [
    ...enrichListingStatements(db, updates, now),
    ...recordDetailFailureStatements(db, failures, now),
  ])

  stats.remaining = await countEnrichmentBacklog(db, slugs)
  return stats
}

/**
 * What the detail page changes about a listing.
 *
 * The page may add but not erase. A detail page that returns nothing leaves the list
 * row's description, cost and image as they were, and a cost the list row already stated
 * is only overruled by a confident answer from the page — which is what `assessCost`
 * returning anything other than 'unknown' means.
 */
export function merge(candidate: EnrichmentCandidate, detail: EventDetail): EnrichedListing {
  const description = detail.description?.trim() || candidate.description || null
  /*
   * Only the page's own cost field counts as a stated price here. What is already stored
   * is usually a phrase an earlier reading of this same page pulled out of the text, and
   * feeding that back in would make every re-read agree with itself forever — including
   * when the earlier reading grabbed a clumsy fragment.
   */
  const verdict = assessCost({
    costText: detail.costText ?? null,
    title: candidate.title,
    description,
  })

  const cost: Cost = verdict.cost === 'unknown' ? candidate.cost : verdict.cost
  /*
   * A field the source labelled "Cost" is the best answer. Next best is the phrase this
   * reading found, which is what the event page shows instead of a bare "Paid" — and it
   * has to outrank what is already stored, because on these two platforms the stored
   * value is usually a phrase an earlier reading found, and re-reading a page is how a
   * worse phrase gets replaced by a better one.
   */
  const costText =
    detail.costText?.trim() || (verdict.cost === 'paid' ? verdict.evidence ?? null : null) || candidate.costText

  return {
    id: candidate.id,
    // Long enough for any real description, short enough that one runaway page cannot
    // bloat every row that quotes it.
    description: description ? description.slice(0, 4000) : null,
    cost,
    costText,
    imageUrl: detail.imageUrl ?? candidate.imageUrl ?? null,
  }
}
