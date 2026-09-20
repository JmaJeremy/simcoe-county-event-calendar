-- Staging for events found in news articles, written by the companion tool in
-- JmaJeremy/news-event-scraper and reviewed in this repo's console at /staged.
--
-- The scraper is a separate repo and a separate Worker, but it binds THIS database, and
-- the schema is owned here — one database, one migration authority. That is the same
-- arrangement the suggestions table already has: "The table's migration lives in
-- apps/ingest/migrations/ like every other, though only the web worker writes it."
-- Apply migrations before deploying the scraper worker, or its first run 500s.
--
-- Nothing here ever becomes an event on its own. A staged row is reviewed by hand and
-- approved through the ordinary console event form, which writes a `manual` listing the
-- same way typing an event by hand does. Dedup then does the rest.

-- Every article the scraper has seen, so each is read and extracted exactly once.
CREATE TABLE IF NOT EXISTS news_articles (
  url             TEXT PRIMARY KEY,
  source_slug     TEXT NOT NULL,
  title           TEXT NOT NULL,
  -- The URL path segment: 'local-news', 'national-news', 'obituaries'. Sections outside the
  -- allowlist are recorded and never fetched, which is where most of the feed goes.
  section         TEXT,
  published_at    TEXT,
  first_seen_at   TEXT NOT NULL,

  -- Set once the article page itself has been read.
  read_at         TEXT,
  article_hash    TEXT,

  -- Extraction is keyed on the hash, exactly like listings.detail_hash: an article edited
  -- after publication comes round again, an unedited one never does.
  extracted_hash  TEXT,
  extracted_at    TEXT,
  extract_method  TEXT,

  -- 'section' | 'no-date-cue' | 'no-forward-cue' | 'staged' | 'duplicate' | a reject reason.
  outcome         TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  error           TEXT
);

CREATE INDEX IF NOT EXISTS idx_news_articles_unread ON news_articles (read_at, first_seen_at);
CREATE INDEX IF NOT EXISTS idx_news_articles_source ON news_articles (source_slug, first_seen_at);

-- The review queue. Column names match the console's event form so the pre-fill is a
-- straight copy rather than a translation.
CREATE TABLE IF NOT EXISTS staged_events (
  id                     TEXT PRIMARY KEY,

  -- Where it came from, all of which the review page shows.
  source_slug            TEXT NOT NULL,
  article_url            TEXT NOT NULL,
  article_title          TEXT NOT NULL,
  article_published_at   TEXT,
  article_hash           TEXT NOT NULL,

  -- The draft itself.
  title                  TEXT NOT NULL,
  -- Every title here is the model's own wording, because articles name events in prose
  -- rather than stating a title, so the title always wants a reviewer's eye. This flag is
  -- the narrower question: 1 when even the title's WORDS appear nowhere in the article,
  -- which means it was built out of nothing and is worth shouting about.
  title_generated        INTEGER NOT NULL DEFAULT 0,
  municipality_slug      TEXT,
  local_date             TEXT NOT NULL,
  local_time             TEXT,
  end_date               TEXT,
  end_time               TEXT,
  venue_name             TEXT,
  address                TEXT,
  description            TEXT,
  organizer              TEXT,
  cost                   TEXT NOT NULL DEFAULT 'unknown',
  cost_text              TEXT,
  url                    TEXT,
  image_url              TEXT,

  -- The verbatim words behind each field, as JSON keyed by field name. Every one has been
  -- checked to appear in the article; the review page prints them beside the values.
  evidence               TEXT NOT NULL DEFAULT '{}',
  confidence             REAL,
  notes                  TEXT,

  -- `municipality | normalized title | local_date`, so two outlets covering one event, or
  -- a republished article, stage once. Unique outright, unlike social_posts' partial index:
  -- there, an unapproved draft had to be freed before its date; here a dismissal SHOULD
  -- burn the key for good, because dismissing means someone looked and said no.
  stage_key              TEXT NOT NULL,

  created_at             TEXT NOT NULL,
  handled_at             TEXT,
  -- 'event' | 'dismissed' | 'duplicate'
  handled_as             TEXT,
  handled_listing_id     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_staged_key ON staged_events (stage_key);
CREATE INDEX IF NOT EXISTS idx_staged_inbox ON staged_events (handled_at, local_date);

-- One row per scraper run, like sync_runs and dedup_runs.
CREATE TABLE IF NOT EXISTS news_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  polled      INTEGER NOT NULL DEFAULT 0,
  fetched     INTEGER NOT NULL DEFAULT 0,
  -- Article pages Cloudflare answered with a bot challenge rather than the page. Counted
  -- apart from a real error: it is a verdict on the IP the run came from, not on the page.
  challenged  INTEGER NOT NULL DEFAULT 0,
  gated       INTEGER NOT NULL DEFAULT 0,
  extracted   INTEGER NOT NULL DEFAULT 0,
  staged      INTEGER NOT NULL DEFAULT 0,
  duplicates  INTEGER NOT NULL DEFAULT 0,
  rejected    TEXT,
  requests    INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);
