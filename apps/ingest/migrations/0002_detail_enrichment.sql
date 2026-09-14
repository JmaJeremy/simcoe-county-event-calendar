-- Detail-page enrichment.
--
-- govStack and Drupal list views publish a truncated description and no price or poster;
-- both keep them on the event's own page. Fetching one page per listing per run is far
-- more than the subrequest budget allows, so the pass is incremental: each run enriches a
-- capped number of listings and records which version of the row it enriched.
--
-- detail_hash holds the listing's content_hash at the moment its detail page was read.
-- A listing is a candidate when the two differ, which covers both "never enriched" and
-- "the list row changed since we did". content_hash itself is never touched here.
ALTER TABLE listings ADD COLUMN detail_hash TEXT;
ALTER TABLE listings ADD COLUMN detail_at TEXT;
-- Bounded retries, so one permanently broken page cannot occupy the queue forever.
ALTER TABLE listings ADD COLUMN detail_attempts INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_listings_detail
  ON listings (active, local_date, detail_hash);
