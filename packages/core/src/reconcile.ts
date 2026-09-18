import type { Category, EventStatus, Listing } from './types.ts'

/**
 * Sync reconciliation.
 *
 * Compares what a source returns now against what it returned before and produces a plan:
 * inserts, updates, and REMOVALS — listings that have stopped appearing. A removal only
 * flips `active`; it says nothing about cancellation. On half of our platforms the
 * listing id encodes the date, time or title, so an organiser fixing a typo retires one
 * id and creates another, and the honest reading of "no longer listed" is exactly that.
 * `status` comes from the source's own text (analyzeTitle) or, on platforms with stable
 * ids, from a moved start time.
 *
 * Deliberately pure, with no database or clock access, so all of it can be tested
 * exhaustively from plain objects.
 */

/** The subset of a stored row this logic needs. */
export interface StoredListing {
  id: string
  externalId: string
  contentHash: string
  startsAtUtc: string
  status: EventStatus
  active: boolean
  /** What normalization made of it last time. Absent in callers that do not track it. */
  category?: Category
  municipalitySlug?: string | null
}

/** A listing whose source text is unchanged but whose derived fields now come out differently. */
export interface Reclassification {
  id: string
  category: Category
  municipalitySlug: string | null
}

export interface ReconcilePlan {
  /** False means something looked wrong enough that we must not write anything. */
  ok: boolean
  abortReason?: string
  inserts: Listing[]
  updates: Array<{ event: Listing; previous: StoredListing; changes: string[] }>
  /** Ids of listings to mark inactive. Never deleted — a shared link should still resolve. */
  removals: string[]
  /**
   * Unchanged at the source, but classified differently because the rules changed. Written
   * as those two columns alone: a full update would overwrite the description, price and
   * poster the enrichment pass filled in after normalization, and since the content hash is
   * unchanged nothing would ever read the event page again to restore them.
   */
  reclassified: Reclassification[]
  unchanged: number
}

const EMPTY_PLAN = (abortReason: string): ReconcilePlan => ({
  ok: false,
  abortReason,
  inserts: [],
  updates: [],
  removals: [],
  reclassified: [],
  unchanged: 0,
})

export function reconcile(incoming: Listing[], existing: StoredListing[]): ReconcilePlan {
  /*
   * The guard that matters.
   *
   * An empty response is indistinguishable from "this calendar has nothing on it", and
   * the former is far more likely: a transient 5xx, a WAF block, a template change that
   * broke the parser. Refusing to reconcile costs us one stale sync; getting it wrong
   * hides a whole town's events until someone notices.
   */
  const liveExisting = existing.filter((e) => e.active)
  if (incoming.length === 0 && liveExisting.length > 0) {
    return EMPTY_PLAN(
      `Source returned 0 listings but ${liveExisting.length} are on record; refusing to remove them. ` +
        `Likely a fetch failure or a template change.`,
    )
  }

  const byExternalId = new Map(existing.map((e) => [e.externalId, e]))
  const seen = new Set<string>()
  const plan: ReconcilePlan = { ok: true, inserts: [], updates: [], removals: [], reclassified: [], unchanged: 0 }

  for (const event of incoming) {
    seen.add(event.externalId)
    const previous = byExternalId.get(event.externalId)
    if (!previous) {
      plan.inserts.push(event)
      continue
    }

    const changes: string[] = []
    if (previous.startsAtUtc !== event.startsAtUtc) changes.push('startsAtUtc')
    if (previous.contentHash !== event.contentHash) changes.push('content')
    if (!previous.active) changes.push('reactivated')
    if (previous.status !== event.status && !changes.includes('content')) changes.push('status')

    if (changes.length === 0) {
      const tracked = previous.category !== undefined
      if (tracked && (previous.category !== event.category || (previous.municipalitySlug ?? null) !== event.municipalitySlug)) {
        plan.reclassified.push({ id: previous.id, category: event.category, municipalitySlug: event.municipalitySlug })
      } else {
        plan.unchanged++
      }
      continue
    }
    plan.updates.push({ event: { ...event, status: nextStatus(previous, event, changes), active: true }, previous, changes })
  }

  for (const previous of existing) {
    // Already inactive rows stay inactive without being rewritten every run.
    if (!seen.has(previous.externalId) && previous.active) plan.removals.push(previous.id)
  }
  return plan
}

function nextStatus(previous: StoredListing, event: Listing, changes: string[]): EventStatus {
  // The source saying so outright beats anything we could infer.
  if (event.status === 'cancelled') return 'cancelled'
  // Same id, moved start: a genuine reschedule on a platform with stable ids.
  if (changes.includes('startsAtUtc')) return 'rescheduled'
  // A previously rescheduled listing whose time is now stable stays flagged until the
  // source itself changes its text; the flag is information for a reader who saw the old time.
  if (previous.status === 'rescheduled' && event.status === 'scheduled') return 'rescheduled'
  return event.status
}
