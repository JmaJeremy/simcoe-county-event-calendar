import { MUNICIPALITIES, SOURCES, enabledSources, type Source } from '@scec/core'
import { handleConsole } from './console.ts'
import { noJudge, runDedup, type DedupStats, type Judge } from './dedup.ts'
import { enrich, type EnrichStats } from './enrich.ts'
import { judgeCosts, type CostPassStats } from './cost.ts'
import { measureImageSizes, type ImageSizeStats } from './image-sizes.ts'
import { claudeCostJudge, noCostJudge, type CostJudge } from './cost-judge.ts'
import { claudeJudge } from './judge.ts'
import { adapterContextFrom, defaultWindow, syncSource } from './pipeline.ts'
import {
  loadExisting,
  recordRun,
  reclassifyListingStatements,
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
  /** Credentials for the eventbrite and ticketmaster sources; each fails without its own. */
  EVENTBRITE_TOKEN?: string
  TICKETMASTER_CONSUMER_KEY?: string
  /** The Canadian fetch proxy (Lambda, ca-central-1), for calendars that refuse the rest of the world. */
  FETCH_PROXY_FUNCTION?: string
  FETCH_PROXY_REGION?: string
  FETCH_PROXY_ACCESS_KEY_ID?: string
  FETCH_PROXY_SECRET_ACCESS_KEY?: string
  /** Claude API key for the de-duplication judge. Without it, ambiguous pairs stay apart. */
  ANTHROPIC_API_KEY?: string
  /** The admin console's hostname; requests to it are the console and nothing else. */
  CONSOLE_HOST?: string
  /** Cloudflare Access team domain and application AUD tag, for verifying console tokens. */
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUD?: string
  /** The public site, for the console's links to event pages. */
  PUBLIC_ORIGIN?: string
  /** Email Service, for the console's acceptance emails. */
  EMAIL?: import('./console.ts').ConsoleEnv['EMAIL']
  /** Posters uploaded with suggestions, which the console shows. */
  POSTERS?: { get(key: string): Promise<{ body: ReadableStream } | null> }
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
  const result = await syncSource(source, window, existing, adapterContextFrom(env as unknown as Record<string, unknown>))
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
      ...reclassifyListingStatements(env.DB, plan.reclassified),
    ])
    inserted = plan.inserts.length
    // Reclassified rows are updates too, of two columns.
    updated = plan.updates.length + plan.reclassified.length
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
  detail?: EnrichStats
  detailError?: string
  cost?: CostPassStats
  costError?: string
  dedup?: DedupStats
  dedupError?: string
  images?: ImageSizeStats
  imagesError?: string
}

export function judgeFor(env: Env): Judge {
  return env.ANTHROPIC_API_KEY ? claudeJudge(env.ANTHROPIC_API_KEY) : noJudge
}

export function costJudgeFor(env: Env): CostJudge {
  return env.ANTHROPIC_API_KEY ? claudeCostJudge(env.ANTHROPIC_API_KEY) : noCostJudge
}

export async function ingestAll(
  env: Env,
  options: { sources?: Source[]; dedup?: boolean; detail?: boolean; cost?: boolean; images?: boolean } = {},
): Promise<IngestReport> {
  // Every source, not just the enabled ones: the disabled `manual` source must still exist
  // in D1, because hand-entered listings reference it.
  await upsertRegistry(env.DB, MUNICIPALITIES, SOURCES)
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

  // Before dedup, not after: dedup rewrites every event from its representative listing,
  // so anything learned here reaches the site in the same run. After it, the new price
  // would sit in `listings` for two hours with the event still saying "cost not listed".
  if (options.detail ?? true) {
    try {
      report.detail = await enrich(env.DB)
    } catch (err) {
      report.detailError = err instanceof Error ? err.message : String(err)
    }
  }

  // After the detail pages, because that is where a stated price usually turns up, and
  // before dedup for the same reason enrichment is: so the events table sees it today.
  if (options.cost ?? true) {
    try {
      report.cost = await judgeCosts(env.DB, costJudgeFor(env))
    } catch (err) {
      report.costError = err instanceof Error ? err.message : String(err)
    }
  }

  if (options.dedup ?? true) {
    try {
      report.dedup = await runDedup(env.DB, defaultWindow(), judgeFor(env))
    } catch (err) {
      report.dedupError = err instanceof Error ? err.message : String(err)
    }
  }

  // After dedup, not before: it reads `events`, which dedup has just rewritten, so a
  // poster that arrived this run is measured this run. Nothing downstream waits on it —
  // the event page reads the size when it renders — so a failure here costs a share card,
  // never the run.
  if (options.images ?? true) {
    try {
      report.images = await measureImageSizes(env.DB)
    } catch (err) {
      report.imagesError = err instanceof Error ? err.message : String(err)
    }
  }
  return report
}

export function summarize(report: IngestReport): string {
  const failed = report.sources.filter((o) => !o.ok)
  const listings = report.sources.reduce((n, o) => n + o.listings, 0)
  const d = report.dedup
  const e = report.detail
  const c = report.cost
  return (
    `ingest complete: ${report.sources.length - failed.length}/${report.sources.length} sources, ${listings} listings` +
    (e
      ? `; detail: ${e.fetched} pages (${e.costResolved} priced, ${e.images} posters, ${e.fuller} fuller, ${e.failed} failed, ${e.remaining} queued)`
      : '') +
    (report.detailError ? `; detail FAILED: ${report.detailError}` : '') +
    (c && (c.read || c.remaining)
      ? `; cost: read ${c.read} (${c.free} free, ${c.paid} paid, ${c.inconclusive} unclear, ${c.unquoted} unquoted, ${c.remaining} queued)`
      : '') +
    (report.costError ? `; cost FAILED: ${report.costError}` : '') +
    (d
      ? `; dedup: ${d.listings} listings into ${d.clusters} events (${d.pairs} pairs, ${d.ruleSame} rule merges, ${d.llmSame}/${d.llmCalls} llm merges, ${d.cached} cached, ${d.unresolved} unresolved)`
      : '') +
    (report.dedupError ? `; dedup FAILED: ${report.dedupError}` : '')
  )
}

/**
 * Where this invocation is running, for the log.
 *
 * Cron triggers run wherever Cloudflare has capacity, which need not be Canada, while a
 * manual /run executes near whoever called it. Eight govStack calendars refuse the first
 * and serve the second, so the data centre is the missing half of that comparison. One
 * subrequest, and a failure here never touches the run.
 */
async function logWhereWeAre(trigger: 'scheduled' | 'manual'): Promise<void> {
  try {
    const res = await fetch('https://cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(5_000) })
    const trace = Object.fromEntries(
      (await res.text())
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('=') as [string, string]),
    )
    console.log(`run location: trigger=${trigger} colo=${trace.colo} loc=${trace.loc} ip=${trace.ip} ts=${new Date().toISOString()}`)
  } catch (err) {
    console.warn('run location: could not read the trace', err instanceof Error ? err.message : String(err))
  }
}

export default {
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(
      logWhereWeAre('scheduled').then(() => ingestAll(env)).then((report) => {
        console.log(summarize(report))
        for (const f of report.sources.filter((o) => !o.ok)) console.error(`  FAILED ${f.slug}: ${f.error}`)
      }),
    )
  },

  /** Manual trigger, so a deploy can be verified without waiting for the cron; and the console. */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    // The admin console lives on its own hostname, where Cloudflare Access stands in front
    // of it, and handleConsole verifies the Access token regardless. It is never served on
    // workers.dev, and /run is never served on the console host.
    if (env.CONSOLE_HOST && url.hostname === env.CONSOLE_HOST) return handleConsole(request, env)
    if (url.pathname !== '/run') {
      return new Response('Simcoe County events ingest worker. POST /run with the ingest token.', { status: 404 })
    }
    if (!env.INGEST_TOKEN || url.searchParams.get('token') !== env.INGEST_TOKEN) {
      return new Response('Unauthorized', { status: 401 })
    }
    await logWhereWeAre('manual')
    const only = url.searchParams.get('source')
    const sources = only ? enabledSources().filter((s) => s.slug === only) : undefined
    const report = await ingestAll(env, {
      sources,
      dedup: url.searchParams.get('dedup') !== '0',
      detail: url.searchParams.get('detail') !== '0',
      cost: url.searchParams.get('cost') !== '0',
    })
    return Response.json({ summary: summarize(report), ...report })
  },
}
