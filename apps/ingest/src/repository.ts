import type { Cost, Event, Listing, Municipality, Source, StoredListing } from '@scec/core'
import { parseOverrides, type EventOverrides } from '@scec/core'

/**
 * D1 access for the ingester. Kept separate from reconciliation and de-duplication so
 * that logic stays pure and exhaustively testable without a database.
 */

export interface D1Statement {
  bind(...values: unknown[]): D1Statement
  all<T = unknown>(): Promise<{ results: T[] }>
  run(): Promise<unknown>
  first<T = unknown>(): Promise<T | null>
}

export interface D1Like {
  prepare(query: string): D1Statement
  batch(statements: D1Statement[]): Promise<unknown>
}

/** D1 batches are capped; keep well under. */
const BATCH = 80

export async function runBatched(db: D1Like, statements: D1Statement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH) {
    await db.batch(statements.slice(i, i + BATCH))
  }
}

export async function upsertRegistry(db: D1Like, municipalities: Municipality[], sources: Source[]): Promise<void> {
  const statements = [
    ...municipalities.map((m) =>
      db
        .prepare(
          `INSERT INTO municipalities (slug, name, short_name, level, parent_slug) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(slug) DO UPDATE SET name = excluded.name, short_name = excluded.short_name,
             level = excluded.level, parent_slug = excluded.parent_slug`,
        )
        .bind(m.slug, m.name, m.shortName, m.level, m.parent),
    ),
    ...sources.map((s) =>
      db
        .prepare(
          `INSERT INTO sources (slug, name, kind, platform, municipality_slug, priority, homepage, enabled)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(slug) DO UPDATE SET name = excluded.name, kind = excluded.kind, platform = excluded.platform,
             municipality_slug = excluded.municipality_slug, priority = excluded.priority,
             homepage = excluded.homepage, enabled = excluded.enabled`,
        )
        .bind(s.slug, s.name, s.kind, s.platform, s.municipalitySlug, s.priority, s.homepage, s.enabled ? 1 : 0),
    ),
  ]
  await runBatched(db, statements)
}

interface StoredRow {
  id: string
  external_id: string
  content_hash: string
  starts_at_utc: string
  status: string
  active: number
}

/** Existing rows for one source inside the sync window, as reconciliation needs them. */
export async function loadExisting(db: D1Like, sourceSlug: string, from: string, to: string): Promise<StoredListing[]> {
  const { results } = await db
    .prepare(
      `SELECT id, external_id, content_hash, starts_at_utc, status, active
         FROM listings WHERE source_slug = ? AND local_date >= ? AND local_date <= ?`,
    )
    .bind(sourceSlug, from, to)
    .all<StoredRow>()
  return results.map((row) => ({
    id: row.id,
    externalId: row.external_id,
    contentHash: row.content_hash,
    startsAtUtc: row.starts_at_utc,
    status: row.status as StoredListing['status'],
    active: row.active === 1,
  }))
}

const LISTING_COLUMNS = `
  id, source_slug, external_id, municipality_slug, title, description, category, source_categories,
  starts_at_utc, ends_at_utc, local_date, local_time, timezone, time_precision, all_day,
  venue_name, address, cost, cost_text, organizer, image_url, url, status, active, removed_at,
  content_hash, first_seen_at, last_seen_at`

function bindListing(l: Listing, now: string): unknown[] {
  return [
    l.id, l.sourceSlug, l.externalId, l.municipalitySlug, l.title, l.description, l.category,
    JSON.stringify(l.sourceCategories), l.startsAtUtc, l.endsAtUtc, l.localDate, l.localTime,
    l.timezone, l.timePrecision, l.allDay ? 1 : 0, l.venueName, l.address, l.cost, l.costText,
    l.organizer, l.imageUrl, l.url, l.status, 1, null, l.contentHash, now, now,
  ]
}

/** Insert-or-update. `cluster_id` and `first_seen_at` are deliberately left alone on update. */
export function upsertListingStatements(db: D1Like, listings: Listing[], now: string): D1Statement[] {
  const placeholders = new Array(28).fill('?').join(', ')
  return listings.map((l) =>
    db
      .prepare(
        `INSERT INTO listings (${LISTING_COLUMNS}) VALUES (${placeholders})
         ON CONFLICT(id) DO UPDATE SET
           municipality_slug = excluded.municipality_slug, title = excluded.title,
           description = excluded.description, category = excluded.category,
           source_categories = excluded.source_categories, starts_at_utc = excluded.starts_at_utc,
           ends_at_utc = excluded.ends_at_utc, local_date = excluded.local_date,
           local_time = excluded.local_time, time_precision = excluded.time_precision,
           all_day = excluded.all_day, venue_name = excluded.venue_name, address = excluded.address,
           cost = excluded.cost, cost_text = excluded.cost_text, organizer = excluded.organizer,
           image_url = excluded.image_url, url = excluded.url, status = excluded.status,
           active = 1, removed_at = NULL, content_hash = excluded.content_hash,
           last_seen_at = excluded.last_seen_at`,
      )
      .bind(...bindListing(l, now)),
  )
}

/** A removal is an update, never a delete: a shared link should still resolve. */
export function removeListingStatements(db: D1Like, ids: string[], now: string): D1Statement[] {
  return ids.map((id) => db.prepare(`UPDATE listings SET active = 0, removed_at = ? WHERE id = ?`).bind(now, id))
}

export async function recordRun(
  db: D1Like,
  run: {
    sourceSlug: string
    startedAt: string
    finishedAt: string
    ok: boolean
    fetched: number
    listingCount: number
    inserted: number
    updated: number
    removed: number
    requests: number
    error?: string
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sync_runs (source_slug, started_at, finished_at, ok, fetched, listing_count, inserted, updated, removed, requests, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(run.sourceSlug, run.startedAt, run.finishedAt, run.ok ? 1 : 0, run.fetched, run.listingCount, run.inserted, run.updated, run.removed, run.requests, run.error ?? null)
    .run()
}

/* ---------- de-duplication ---------- */

export interface ListingRow {
  id: string
  source_slug: string
  external_id: string
  municipality_slug: string | null
  title: string
  description: string | null
  category: string
  source_categories: string
  starts_at_utc: string
  ends_at_utc: string | null
  local_date: string
  local_time: string
  timezone: string
  time_precision: string
  all_day: number
  venue_name: string | null
  address: string | null
  cost: string
  cost_text: string | null
  organizer: string | null
  image_url: string | null
  url: string
  status: string
  active: number
  content_hash: string
  cluster_id: string | null
}

export function rowToListing(row: ListingRow, sourceKind: Listing['sourceKind']): Listing & { clusterId: string | null } {
  return {
    id: row.id,
    sourceSlug: row.source_slug,
    sourceKind,
    externalId: row.external_id,
    municipalitySlug: row.municipality_slug,
    title: row.title,
    description: row.description,
    category: row.category as Listing['category'],
    sourceCategories: JSON.parse(row.source_categories || '[]') as string[],
    startsAtUtc: row.starts_at_utc,
    endsAtUtc: row.ends_at_utc,
    localDate: row.local_date,
    localTime: row.local_time,
    timezone: row.timezone,
    timePrecision: row.time_precision as Listing['timePrecision'],
    allDay: row.all_day === 1,
    venueName: row.venue_name,
    address: row.address,
    cost: row.cost as Listing['cost'],
    costText: row.cost_text,
    organizer: row.organizer,
    imageUrl: row.image_url,
    url: row.url,
    status: row.status as Listing['status'],
    active: row.active === 1,
    contentHash: row.content_hash,
    clusterId: row.cluster_id,
  }
}

/** Every listing in the window, active or not, so clusters can be closed as well as opened. */
export async function loadListingsForDedup(db: D1Like, from: string, to: string): Promise<ListingRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM listings WHERE local_date >= ? AND local_date <= ?`)
    .bind(from, to)
    .all<ListingRow>()
  return results
}

export interface DecisionRow {
  listing_a: string
  listing_b: string
  hash_a: string
  hash_b: string
  verdict: 'same' | 'distinct'
  method: string
  score: number
  confidence: number | null
  reasoning: string | null
}

export async function loadDecisions(db: D1Like, listingIds: string[]): Promise<DecisionRow[]> {
  // D1 binds at most ~100 parameters comfortably; chunk the IN list on listing_a.
  const out: DecisionRow[] = []
  for (let i = 0; i < listingIds.length; i += 90) {
    const chunk = listingIds.slice(i, i + 90)
    const { results } = await db
      .prepare(`SELECT * FROM dedup_decisions WHERE listing_a IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .all<DecisionRow>()
    out.push(...results)
  }
  return out
}

export function decisionStatements(db: D1Like, decisions: DecisionRow[], now: string): D1Statement[] {
  return decisions.map((d) =>
    db
      .prepare(
        `INSERT INTO dedup_decisions (listing_a, listing_b, hash_a, hash_b, verdict, method, score, confidence, reasoning, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(listing_a, listing_b) DO UPDATE SET hash_a = excluded.hash_a, hash_b = excluded.hash_b,
           verdict = excluded.verdict, method = excluded.method, score = excluded.score,
           confidence = excluded.confidence, reasoning = excluded.reasoning, decided_at = excluded.decided_at`,
      )
      .bind(d.listing_a, d.listing_b, d.hash_a, d.hash_b, d.verdict, d.method, d.score, d.confidence, d.reasoning, now),
  )
}

/** Every hand edit to an event, by event id; see applyOverrides. One row per edited event. */
export async function loadOverrides(db: D1Like): Promise<Map<string, EventOverrides>> {
  const { results } = await db.prepare('SELECT event_id, fields FROM event_overrides').all<{ event_id: string; fields: string }>()
  return new Map(results.map((r) => [r.event_id, parseOverrides(r.fields)]))
}

export async function loadExistingClusters(db: D1Like, from: string, to: string): Promise<Array<{ id: string; created_at: string }>> {
  const { results } = await db
    .prepare(`SELECT id, created_at FROM events WHERE local_date >= ? AND local_date <= ?`)
    .bind(from, to)
    .all<{ id: string; created_at: string }>()
  return results
}

const EVENT_COLUMNS = `
  id, short_code, representative_id, listing_ids, source_slugs, municipality_slug, title, description,
  category, starts_at_utc, ends_at_utc, local_date, local_time, timezone, time_precision, all_day,
  venue_name, address, cost, cost_text, organizer, image_url, url, status, active, listing_count,
  created_at, updated_at`

export function upsertEventStatements(db: D1Like, events: Event[], now: string): D1Statement[] {
  const placeholders = new Array(28).fill('?').join(', ')
  return events.map((e) =>
    db
      .prepare(
        `INSERT INTO events (${EVENT_COLUMNS}) VALUES (${placeholders})
         ON CONFLICT(id) DO UPDATE SET
           representative_id = excluded.representative_id, listing_ids = excluded.listing_ids,
           source_slugs = excluded.source_slugs, municipality_slug = excluded.municipality_slug,
           title = excluded.title, description = excluded.description, category = excluded.category,
           starts_at_utc = excluded.starts_at_utc, ends_at_utc = excluded.ends_at_utc,
           local_date = excluded.local_date, local_time = excluded.local_time, timezone = excluded.timezone,
           time_precision = excluded.time_precision, all_day = excluded.all_day, venue_name = excluded.venue_name,
           address = excluded.address, cost = excluded.cost, cost_text = excluded.cost_text,
           organizer = excluded.organizer, image_url = excluded.image_url, url = excluded.url,
           status = excluded.status, active = excluded.active, listing_count = excluded.listing_count,
           updated_at = excluded.updated_at`,
      )
      .bind(
        e.id, e.shortCode, e.representativeId, JSON.stringify(e.listingIds), JSON.stringify(e.sourceSlugs),
        e.municipalitySlug, e.title, e.description, e.category, e.startsAtUtc, e.endsAtUtc, e.localDate,
        e.localTime, e.timezone, e.timePrecision, e.allDay ? 1 : 0, e.venueName, e.address, e.cost, e.costText,
        e.organizer, e.imageUrl, e.url, e.status, e.active ? 1 : 0, e.listingIds.length, now, now,
      ),
  )
}

export function assignClusterStatements(db: D1Like, assignments: Array<{ listingId: string; clusterId: string }>): D1Statement[] {
  return assignments.map((a) => db.prepare(`UPDATE listings SET cluster_id = ? WHERE id = ?`).bind(a.clusterId, a.listingId))
}

/** Clusters in the window that no longer own any listing are closed, not deleted. */
export function deactivateEventStatements(db: D1Like, ids: string[], now: string): D1Statement[] {
  return ids.map((id) => db.prepare(`UPDATE events SET active = 0, updated_at = ? WHERE id = ?`).bind(now, id))
}

export async function recordDedupRun(
  db: D1Like,
  run: { startedAt: string; finishedAt: string; listings: number; pairs: number; ruleSame: number; ruleDistinct: number; llmCalls: number; llmSame: number; clusters: number; error?: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO dedup_runs (started_at, finished_at, listings, pairs, rule_same, rule_distinct, llm_calls, llm_same, clusters, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(run.startedAt, run.finishedAt, run.listings, run.pairs, run.ruleSame, run.ruleDistinct, run.llmCalls, run.llmSame, run.clusters, run.error ?? null)
    .run()
}

/* ---------- detail-page enrichment ---------- */

export interface EnrichmentCandidate {
  id: string
  sourceSlug: string
  url: string
  title: string
  description: string | null
  cost: Cost
  costText: string | null
  imageUrl: string | null
  contentHash: string
}

export interface EnrichedListing {
  id: string
  description: string | null
  cost: Cost
  costText: string | null
  imageUrl: string | null
}

/** How many times a detail page may fail before the queue gives up on it. */
const MAX_DETAIL_ATTEMPTS = 3

/**
 * The next listings whose event page is worth reading: never read, or read before the
 * list row changed. Soonest first, because an event next week matters more than one in
 * five months, and past events not at all.
 *
 * Council meetings are skipped. They are hidden by default, they are free, and they are a
 * third of some calendars — spending the budget on them would starve everything else.
 */
export async function loadEnrichmentCandidates(
  db: D1Like,
  sourceSlugs: string[],
  limit: number,
): Promise<EnrichmentCandidate[]> {
  if (sourceSlugs.length === 0) return []
  const placeholders = sourceSlugs.map(() => '?').join(',')
  const { results } = await db
    .prepare(
      `SELECT id, source_slug, url, title, description, cost, cost_text, image_url, content_hash
         FROM listings
        WHERE active = 1
          AND local_date >= date('now')
          AND category <> 'civic-meeting'
          AND source_slug IN (${placeholders})
          AND (detail_hash IS NULL OR detail_hash <> content_hash)
          AND detail_attempts < ?
        ORDER BY local_date ASC
        LIMIT ?`,
    )
    .bind(...sourceSlugs, MAX_DETAIL_ATTEMPTS, limit)
    .all<Record<string, unknown>>()

  return results.map((row) => ({
    id: String(row.id),
    sourceSlug: String(row.source_slug),
    url: String(row.url),
    title: String(row.title),
    description: (row.description as string | null) ?? null,
    cost: (row.cost as Cost) ?? 'unknown',
    costText: (row.cost_text as string | null) ?? null,
    imageUrl: (row.image_url as string | null) ?? null,
    contentHash: String(row.content_hash),
  }))
}

/** What is still queued, so a run says how much of the backlog is left. */
export async function countEnrichmentBacklog(db: D1Like, sourceSlugs: string[]): Promise<number> {
  if (sourceSlugs.length === 0) return 0
  const placeholders = sourceSlugs.map(() => '?').join(',')
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM listings
        WHERE active = 1 AND local_date >= date('now') AND category <> 'civic-meeting'
          AND source_slug IN (${placeholders})
          AND (detail_hash IS NULL OR detail_hash <> content_hash)
          AND detail_attempts < ?`,
    )
    .bind(...sourceSlugs, MAX_DETAIL_ATTEMPTS)
    .first<{ n: number }>()
  return row?.n ?? 0
}

/**
 * Write back what the detail page said. `detail_hash` is set from the row's own
 * `content_hash` rather than passed in, so it always records the version that was read,
 * and `content_hash` itself is never touched — reconciliation owns that.
 */
export function enrichListingStatements(db: D1Like, updates: EnrichedListing[], now: string): D1Statement[] {
  return updates.map((u) =>
    db
      .prepare(
        `UPDATE listings
            SET description = ?, cost = ?, cost_text = ?, image_url = ?,
                detail_hash = content_hash, detail_at = ?, detail_attempts = 0
          WHERE id = ?`,
      )
      .bind(u.description, u.cost, u.costText, u.imageUrl, now, u.id),
  )
}

/** A page that could not be read: counted, so it leaves the queue after a few tries. */
export function recordDetailFailureStatements(db: D1Like, ids: string[], now: string): D1Statement[] {
  return ids.map((id) =>
    db
      .prepare(`UPDATE listings SET detail_attempts = detail_attempts + 1, detail_at = ? WHERE id = ?`)
      .bind(now, id),
  )
}

/* ---------- second opinions on price ---------- */

export interface CostCandidate {
  id: string
  title: string
  description: string
  sourceName: string
  contentHash: string
}

export interface CostDecisionRow {
  listingId: string
  contentHash: string
  verdict: 'free' | 'paid' | 'unclear'
  quote: string | null
}

/** Enough words that a price could plausibly be stated in them. */
const MIN_TEXT = 60

/**
 * Listings still unclear about price, with a sum of money in them and no reading on file.
 *
 * Sources whose event pages we read are only eligible once that reading has happened:
 * asking about a description we already know is truncated would spend tokens on the half
 * of the text that never mentions the price. Sources with nothing more to fetch — the
 * news sites, the ticketing feeds — are eligible straight away.
 */
export async function loadCostCandidates(
  db: D1Like,
  enrichableSlugs: string[],
  limit: number,
): Promise<{ candidates: CostCandidate[]; remaining: number }> {
  const placeholders = enrichableSlugs.length ? enrichableSlugs.map(() => '?').join(',') : "''"
  const where = `
       WHERE l.active = 1
         AND l.local_date >= date('now')
         AND l.category <> 'civic-meeting'
         AND l.cost = 'unknown'
         AND l.source_slug <> 'manual'
         AND length(coalesce(l.description, '')) >= ?
         AND (l.source_slug NOT IN (${placeholders}) OR l.detail_hash = l.content_hash)
         -- A coarse superset of core's MONEY pattern, which SQLite's LIKE cannot express.
         -- Deliberately loose ('%cad%' also matches "academy"); judgeCosts applies the
         -- real containsMoney test. Its only job is to keep the other 99% out of the
         -- query, since a listing with no sum in it has no price sentence to find.
         AND (
              l.description LIKE '%$%'      OR l.title LIKE '%$%'
           OR l.description LIKE '%dollar%' OR l.title LIKE '%dollar%'
           OR l.description LIKE '%cad%'    OR l.title LIKE '%cad%'
         )
         AND NOT EXISTS (
           SELECT 1 FROM cost_decisions d
            WHERE d.listing_id = l.id AND d.content_hash = l.content_hash
         )`

  const { results } = await db
    .prepare(
      `SELECT l.id, l.title, l.description, l.content_hash, s.name AS source_name
         FROM listings l JOIN sources s ON s.slug = l.source_slug
         ${where}
         ORDER BY l.local_date ASC
         LIMIT ?`,
    )
    .bind(MIN_TEXT, ...enrichableSlugs, limit)
    .all<Record<string, unknown>>()

  const total = await db
    .prepare(`SELECT COUNT(*) AS n FROM listings l ${where}`)
    .bind(MIN_TEXT, ...enrichableSlugs)
    .first<{ n: number }>()

  return {
    candidates: results.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      description: String(row.description ?? ''),
      sourceName: String(row.source_name ?? row.id),
      contentHash: String(row.content_hash),
    })),
    remaining: total?.n ?? 0,
  }
}

/** Every reading is recorded, including the ones that decided nothing. */
export function costDecisionStatements(
  db: D1Like,
  decisions: CostDecisionRow[],
  method: string,
  now: string,
): D1Statement[] {
  return decisions.map((d) =>
    db
      .prepare(
        `INSERT INTO cost_decisions (listing_id, content_hash, verdict, quote, method, decided_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(listing_id, content_hash) DO UPDATE SET
           verdict = excluded.verdict, quote = excluded.quote,
           method = excluded.method, decided_at = excluded.decided_at`,
      )
      .bind(d.listingId, d.contentHash, d.verdict, d.quote, method, now),
  )
}

/** Only ever applied to a listing that is still unclear, so nothing stated is overruled. */
export function setListingCostStatements(
  db: D1Like,
  updates: Array<{ id: string; cost: Cost; costText: string }>,
): D1Statement[] {
  return updates.map((u) =>
    db
      .prepare(`UPDATE listings SET cost = ?, cost_text = ? WHERE id = ? AND cost = 'unknown'`)
      .bind(u.cost, u.costText, u.id),
  )
}
