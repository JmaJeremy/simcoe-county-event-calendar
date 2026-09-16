import { HttpError, adapterFor, httpStats, resetHttpStats } from '@scec/adapters'
import {
  normalizeAll,
  reconcile,
  shiftDate,
  type AdapterContext,
  type Listing,
  type ReconcilePlan,
  type Source,
  type StoredListing,
  type SyncWindow,
} from '@scec/core'

/**
 * How far either side of today we keep in sync. Community calendars rarely publish more
 * than a few months ahead, and a past event is only worth keeping for a short while so a
 * shared link does not 404 the day after.
 */
export const DEFAULT_LOOKBACK_DAYS = 14
export const DEFAULT_LOOKAHEAD_DAYS = 180

export function defaultWindow(today = new Date()): SyncWindow {
  const iso = today.toISOString().slice(0, 10)
  return { from: shiftDate(iso, -DEFAULT_LOOKBACK_DAYS), to: shiftDate(iso, DEFAULT_LOOKAHEAD_DAYS) }
}

/** Credentials for the adapters that need them, from the worker's env or process.env. */
export function adapterContextFrom(env: Record<string, unknown>): AdapterContext {
  const secret = (name: string): string | undefined => (typeof env[name] === 'string' && env[name] ? (env[name] as string) : undefined)
  return { secrets: { EVENTBRITE_TOKEN: secret('EVENTBRITE_TOKEN'), TICKETMASTER_CONSUMER_KEY: secret('TICKETMASTER_CONSUMER_KEY') } }
}

export interface SourceResult {
  source: Source
  ok: boolean
  error?: string
  fetched: number
  listings: Listing[]
  skipped: Array<{ externalId: string; reason: string }>
  plan?: ReconcilePlan
  durationMs: number
  requests: number
}

/**
 * Fetch and normalize one source, and — when existing rows are supplied — work out what
 * would change. Returns a result rather than throwing so that one broken site never takes
 * down the run for the other twenty-four.
 */
export async function syncSource(
  source: Source,
  window: SyncWindow,
  existing?: StoredListing[],
  context?: AdapterContext,
): Promise<SourceResult> {
  const startedAt = Date.now()
  resetHttpStats()
  const base = { source, fetched: 0, listings: [], skipped: [], durationMs: 0, requests: 0 }

  try {
    const raw = await adapterFor(source.platform)(source, window, context)
    const { listings, skipped } = normalizeAll(source, raw)
    const plan = existing ? reconcile(listings, existing) : undefined
    return {
      ...base,
      ok: plan ? plan.ok : true,
      error: plan?.abortReason,
      fetched: raw.length,
      listings,
      skipped,
      plan,
      durationMs: Date.now() - startedAt,
      requests: httpStats.requests,
    }
  } catch (err) {
    /*
     * A refusal is worth more than its status line. Eight govStack calendars answer 403 to
     * the scheduled run and 200 to every manual one, so what the block page says — and
     * which WAF rule `x-azure-ref` names — is the evidence for why. `sync_runs.error` keeps
     * only the message; this puts the rest in the Worker log beside it.
     */
    if (err instanceof HttpError) {
      console.error(
        `source ${source.slug}: HTTP ${err.status} from ${err.url}` +
          ` headers=${JSON.stringify(err.headers)} body=${JSON.stringify(err.body.replace(/\s+/g, ' ').slice(0, 300))}`,
      )
    }
    return { ...base, ok: false, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - startedAt, requests: httpStats.requests }
  }
}
