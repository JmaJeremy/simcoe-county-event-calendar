import type { EventStatus, Listing } from './types.ts'

/**
 * Sync reconciliation.
 *
 * Sources never tell us that an event was cancelled — it simply stops appearing in the
 * calendar. So cancellation is something we infer by comparing what a source returns now
 * against what it returned before, which makes this the most safety-critical logic in the
 * project: a naive implementation would read one failed HTTP request as "every event in
 * this source was cancelled".
 *
 * Deliberately pure, with no database or clock access, so all of that can be tested
 * exhaustively from plain objects.
 */

/** The subset of a stored row this logic needs. */
export interface StoredListing {
  id: string
  externalId: string
  contentHash: string
  startsAtUtc: string
  status: EventStatus
}

export interface ReconcilePlan {
  /** False means something looked wrong enough that we must not write anything. */
  ok: boolean
  abortReason?: string
  inserts: Listing[]
  updates: Array<{ event: Listing; previous: StoredListing; changes: string[] }>
  /** Ids of events to mark cancelled. Never deleted — a cancellation is information. */
  cancellations: string[]
  unchanged: number
}

const EMPTY_PLAN = (abortReason: string): ReconcilePlan => ({
  ok: false,
  abortReason,
  inserts: [],
  updates: [],
  cancellations: [],
  unchanged: 0,
})

export function reconcile(incoming: Listing[], existing: StoredListing[]): ReconcilePlan {
  /*
   * The guard that matters.
   *
   * An empty response is indistinguishable from "this municipality cancelled everything",
   * and the former is far more likely: a transient 5xx, a WAF block, or a tenant migrating
   * to a new platform (which is exactly how Penetanguishene's move showed up — its old
   * host kept answering 200 with an empty array). Refusing to reconcile costs us one stale
   * sync; getting it wrong wipes out a whole council's calendar.
   */
  if (incoming.length === 0 && existing.length > 0) {
    return EMPTY_PLAN(
      `Source returned 0 events but ${existing.length} are on record; refusing to cancel them. ` +
        `Likely a fetch failure or a platform migration.`,
    )
  }

  const byExternalId = new Map(existing.map((e) => [e.externalId, e]))
  const seen = new Set<string>()

  const plan: ReconcilePlan = {
    ok: true,
    inserts: [],
    updates: [],
    cancellations: [],
    unchanged: 0,
  }

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
    // A listing we had marked cancelled that is listed again as active is reinstated.
    if (previous.status === 'cancelled' && event.status !== 'cancelled') changes.push('reinstated')

    if (changes.length === 0) {
      plan.unchanged++
      continue
    }

    plan.updates.push({
      event: { ...event, status: nextStatus(previous, event, changes) },
      previous,
      changes,
    })
  }

  for (const previous of existing) {
    // Already cancelled rows stay cancelled without being rewritten every run.
    if (!seen.has(previous.externalId) && previous.status !== 'cancelled') {
      plan.cancellations.push(previous.id)
    }
  }

  return plan
}

function nextStatus(
  previous: StoredListing,
  event: Listing,
  changes: string[],
): EventStatus {
  // The source saying so outright beats anything we could infer. Checked first so an
  // in-band 'CANCELLED' is not overwritten by a same-run time change.
  if (event.status === 'cancelled') return 'cancelled'
  // A moved start time is the one change people most need flagged.
  if (changes.includes('startsAtUtc')) return 'rescheduled'
  // Reinstated after a cancellation, with its time intact: back to normal.
  if (previous.status === 'cancelled') return 'scheduled'
  // Any other edit (venue, agenda posted) leaves the status alone.
  return previous.status === 'rescheduled' ? 'rescheduled' : event.status
}
