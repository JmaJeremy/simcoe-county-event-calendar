import type { Event, Listing, Municipality, Source, StoredListing } from '@scec/core'

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
