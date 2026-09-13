import { MUNICIPALITIES, enabledSources, type Source } from '@scec/core'
import { noJudge, runDedup, type DedupStats, type Judge } from './dedup.ts'
import { claudeJudge } from './judge.ts'
import { defaultWindow, syncSource } from './pipeline.ts'
import {
  loadExisting,
  recordRun,
  removeListingStatements,
  runBatched,
  upsertListingStatements,
  upsertRegistry,
  type D1Like,
} from './repository.ts'

export interface Env {
  DB: D1Like
  /** Shared secret for the manual /run trigger. */
  INGEST_TOKEN?: string
  /** Claude API key for the de-duplication judge. Without it, ambiguous pairs stay apart. */
  ANTHROPIC_API_KEY?: string
}

export interface SourceOutcome {
  slug: string
  ok: boolean
  listings: number
  inserted: number
  updated: number
  removed: number
  requests: number
  error?: string
}

async function ingestOne(env: Env, source: Source): Promise<SourceOutcome> {
  const window = defaultWindow()
  const startedAt = new Date().toISOString()
  const existing = await loadExisting(env.DB, source.slug, window.from, window.to)
  const result = await syncSource(source, window, existing)
  const plan = result.plan

  let inserted = 0
  let updated = 0
  let removed = 0
  // A plan that aborted (the empty-response guard) writes nothing at all.
  if (result.ok && plan?.ok) {
    const now = new Date().toISOString()
    await runBatched(env.DB, [
      ...upsertListingStatements(env.DB, plan.inserts, now),
      ...upsertListingStatements(env.DB, plan.updates.map((u) => u.event), now),
      ...removeListingStatements(env.DB, plan.removals, now),
    ])
    inserted = plan.inserts.length
    updated = plan.updates.length
    removed = plan.removals.length
  }

  await recordRun(env.DB, {
    sourceSlug: source.slug,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: result.ok,
    fetched: result.fetched,
    listingCount: result.listings.length,
    inserted,
    updated,
    removed,
    requests: result.requests,
    error: result.error,
  })
  return { slug: source.slug, ok: result.ok, listings: result.listings.length, inserted, updated, removed, requests: result.requests, error: result.error }
}

export interface IngestReport {
  sources: SourceOutcome[]
  dedup?: DedupStats
  dedupError?: string
}

export function judgeFor(env: Env): Judge {
  return env.ANTHROPIC_API_KEY ? claudeJudge(env.ANTHROPIC_API_KEY) : noJudge
}

export async function ingestAll(env: Env, options: { sources?: Source[]; dedup?: boolean } = {}): Promise<IngestReport> {
  await upsertRegistry(env.DB, MUNICIPALITIES, enabledSources())
  const outcomes: SourceOutcome[] = []
  // Sequential on purpose: these are small municipal servers and nothing here is urgent.
  for (const source of options.sources ?? enabledSources()) {
    try {
      outcomes.push(await ingestOne(env, source))
    } catch (err) {
      // One site failing must never stop the other twenty-four.
      outcomes.push({
        slug: source.slug,
        ok: false,
        listings: 0,
        inserted: 0,
        updated: 0,
        removed: 0,
        requests: 0,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  const report: IngestReport = { sources: outcomes }
  if (options.dedup ?? true) {
    try {
      report.dedup = await runDedup(env.DB, defaultWindow(), judgeFor(env))
    } catch (err) {
      report.dedupError = err instanceof Error ? err.message : String(err)
    }
  }
  return report
}

export function summarize(report: IngestReport): string {
  const failed = report.sources.filter((o) => !o.ok)
  const listings = report.sources.reduce((n, o) => n + o.listings, 0)
  const d = report.dedup
  return (
    `ingest complete: ${report.sources.length - failed.length}/${report.sources.length} sources, ${listings} listings` +
    (d
      ? `; dedup: ${d.listings} listings into ${d.clusters} events (${d.pairs} pairs, ${d.ruleSame} rule merges, ${d.llmSame}/${d.llmCalls} llm merges, ${d.cached} cached, ${d.unresolved} unresolved)`
      : '') +
    (report.dedupError ? `; dedup FAILED: ${report.dedupError}` : '')
  )
}

export default {
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(
      ingestAll(env).then((report) => {
        console.log(summarize(report))
        for (const f of report.sources.filter((o) => !o.ok)) console.error(`  FAILED ${f.slug}: ${f.error}`)
      }),
    )
  },

  /** Manual trigger, so a deploy can be verified without waiting for the cron. */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== '/run') {
      return new Response('Simcoe County events ingest worker. POST /run with the ingest token.', { status: 404 })
    }
    if (!env.INGEST_TOKEN || url.searchParams.get('token') !== env.INGEST_TOKEN) {
      return new Response('Unauthorized', { status: 401 })
    }
    const only = url.searchParams.get('source')
    const sources = only ? enabledSources().filter((s) => s.slug === only) : undefined
    const report = await ingestAll(env, { sources, dedup: url.searchParams.get('dedup') !== '0' })
    return Response.json({ summary: summarize(report), ...report })
  },
}
