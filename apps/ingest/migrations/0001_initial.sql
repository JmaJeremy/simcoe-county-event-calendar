-- Canonical storage for community events.
--
-- Municipalities and sources are seeded from packages/core on every run, so this schema
-- holds only what the registry cannot: observed listings, the clusters (events) the
-- de-duplicator built from them, its cached verdicts, and run history.

CREATE TABLE IF NOT EXISTS municipalities (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  short_name  TEXT NOT NULL,
  level       TEXT NOT NULL,
  parent_slug TEXT
);

CREATE TABLE IF NOT EXISTS sources (
  slug              TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL,
  platform          TEXT NOT NULL,
  municipality_slug TEXT,
  priority          INTEGER NOT NULL,
  homepage          TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1
);

-- One source's view of one occurrence. Identity is (source, platform id), never content.
CREATE TABLE IF NOT EXISTS listings (
  id                TEXT PRIMARY KEY,           -- "<source_slug>:<external_id>"
  source_slug       TEXT NOT NULL REFERENCES sources(slug),
  external_id       TEXT NOT NULL,
  municipality_slug TEXT,
  title             TEXT NOT NULL,
  description       TEXT,
  category          TEXT NOT NULL,
  source_categories TEXT NOT NULL DEFAULT '[]', -- JSON array
  starts_at_utc     TEXT NOT NULL,
  ends_at_utc       TEXT,
  local_date        TEXT NOT NULL,
  local_time        TEXT NOT NULL,
  timezone          TEXT NOT NULL,
  time_precision    TEXT NOT NULL DEFAULT 'exact',
  all_day           INTEGER NOT NULL DEFAULT 0,
  venue_name        TEXT,
  address           TEXT,
  cost              TEXT NOT NULL DEFAULT 'unknown',
  cost_text         TEXT,
  organizer         TEXT,
  image_url         TEXT,
  url               TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'scheduled',
  -- Still published by the source. Flipped, never deleted, when it stops appearing.
  active            INTEGER NOT NULL DEFAULT 1,
  removed_at        TEXT,
  content_hash      TEXT NOT NULL,
  cluster_id        TEXT,
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  UNIQUE (source_slug, external_id)
);

CREATE INDEX IF NOT EXISTS idx_listings_local_date ON listings (local_date);
CREATE INDEX IF NOT EXISTS idx_listings_cluster ON listings (cluster_id);
CREATE INDEX IF NOT EXISTS idx_listings_source_date ON listings (source_slug, local_date);

-- A public event: one cluster of listings judged to be the same thing. Canonical columns
-- are copied from the representative listing; id is the representative's id at creation
-- and never changes, so short links survive re-clustering.
CREATE TABLE IF NOT EXISTS events (
  id                TEXT PRIMARY KEY,
  short_code        TEXT NOT NULL UNIQUE,
  representative_id TEXT NOT NULL,
  listing_ids       TEXT NOT NULL,             -- JSON array
  source_slugs      TEXT NOT NULL,             -- JSON array
  municipality_slug TEXT,
  title             TEXT NOT NULL,
  description       TEXT,
  category          TEXT NOT NULL,
  starts_at_utc     TEXT NOT NULL,
  ends_at_utc       TEXT,
  local_date        TEXT NOT NULL,
  local_time        TEXT NOT NULL,
  timezone          TEXT NOT NULL,
  time_precision    TEXT NOT NULL DEFAULT 'exact',
  all_day           INTEGER NOT NULL DEFAULT 0,
  venue_name        TEXT,
  address           TEXT,
  cost              TEXT NOT NULL DEFAULT 'unknown',
  cost_text         TEXT,
  organizer         TEXT,
  image_url         TEXT,
  url               TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'scheduled',
  active            INTEGER NOT NULL DEFAULT 1,
  listing_count     INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_starts_at ON events (starts_at_utc);
CREATE INDEX IF NOT EXISTS idx_events_municipality_starts ON events (municipality_slug, starts_at_utc);
CREATE INDEX IF NOT EXISTS idx_events_local_date ON events (local_date);

-- Every pairwise verdict, so a pair is judged at most once per content. Ordered pair:
-- listing_a < listing_b. `method` is 'rule' or 'llm'.
CREATE TABLE IF NOT EXISTS dedup_decisions (
  listing_a   TEXT NOT NULL,
  listing_b   TEXT NOT NULL,
  hash_a      TEXT NOT NULL,
  hash_b      TEXT NOT NULL,
  verdict     TEXT NOT NULL,                  -- 'same' | 'distinct'
  method      TEXT NOT NULL,
  score       REAL NOT NULL,
  confidence  REAL,
  reasoning   TEXT,
  decided_at  TEXT NOT NULL,
  PRIMARY KEY (listing_a, listing_b)
);

-- Per-source run history, so a failing site is visible rather than silent.
CREATE TABLE IF NOT EXISTS sync_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_slug TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  ok          INTEGER NOT NULL DEFAULT 0,
  fetched     INTEGER NOT NULL DEFAULT 0,
  listing_count INTEGER NOT NULL DEFAULT 0,
  inserted    INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  removed     INTEGER NOT NULL DEFAULT 0,
  requests    INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_source ON sync_runs (source_slug, started_at DESC);

-- One row per dedup pass.
CREATE TABLE IF NOT EXISTS dedup_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  listings    INTEGER NOT NULL DEFAULT 0,
  pairs       INTEGER NOT NULL DEFAULT 0,
  rule_same   INTEGER NOT NULL DEFAULT 0,
  rule_distinct INTEGER NOT NULL DEFAULT 0,
  llm_calls   INTEGER NOT NULL DEFAULT 0,
  llm_same    INTEGER NOT NULL DEFAULT 0,
  clusters    INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);
