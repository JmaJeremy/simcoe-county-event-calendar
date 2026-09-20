-- One drafted social post: one event, one platform, one day.
--
-- Drafted the evening before and sent the next morning, with a human approving it in the
-- console in between, so the row has to survive six ingest runs without becoming a lie.
--
-- It is deliberately NOT keyed on the event id, and carries no foreign key to `events`.
-- On govStack, Drupal rows and SPACES the platform's id encodes the date, so an organiser
-- moving an event retires one cluster and creates another: a check on the event id alone
-- would post the same thing twice under two ids, and a foreign key would take the draft
-- down with the old row. `post_key` is what the event IS rather than which cluster it
-- happens to be in, so the replacement is recognised as the same event.
CREATE TABLE IF NOT EXISTS social_posts (
  id          TEXT PRIMARY KEY,
  -- 'facebook' | 'x' | 'instagram'
  platform    TEXT NOT NULL,
  -- The America/Toronto date this is to be posted on.
  post_date   TEXT NOT NULL,
  -- The cluster it was drafted from, for the console's link. May be gone by send time.
  event_id    TEXT NOT NULL,
  short_code  TEXT NOT NULL,
  -- municipality | normalizeTitle(title) | local_date — the event's identity.
  post_key    TEXT NOT NULL,
  -- municipality | normalizeTitle(title) — the cooldown key, so a weekly programme is
  -- posted once and not every Tuesday forever.
  series_key  TEXT NOT NULL,
  rank        INTEGER NOT NULL,
  score       REAL NOT NULL,
  -- The event's cost at draft time, so the day's free/paid quota can be counted without
  -- re-reading every event.
  cost        TEXT NOT NULL,
  -- JSON of the template inputs as they were at draft time: title, local_date,
  -- local_time, all_day, time_precision, venue_name, municipality_slug, cost, cost_text,
  -- short_code. Compared again immediately before sending.
  --
  -- Only those fields, never the whole row. Dedup rewrites every event in its window on
  -- each of the six runs between drafting and sending: updated_at moves on nearly all of
  -- them, listing_count and source_slugs move when another source picks the event up,
  -- description and image_url move when enrichment reads the page — and the near-future
  -- events with real descriptions are exactly the front of that queue — and cost moves
  -- when the judge prices one. A whole-row comparison would stale almost every draft,
  -- every night.
  snapshot    TEXT NOT NULL,
  -- The model's one-sentence hook, already verified to be an excerpt of the event's own
  -- text, and where it came from: 'model' | 'none' | 'edited'.
  hook        TEXT,
  hook_source TEXT NOT NULL,
  -- The exact text that will be sent. Rendered here so the console shows what goes out.
  body        TEXT NOT NULL,
  -- Instagram only: the public path of the card, not a bucket key, so per-event cards can
  -- replace the static ones later without a migration.
  image_path  TEXT,
  -- drafted | approved | posting | posted | failed | skipped | stale | expired
  status      TEXT NOT NULL,
  -- Won by the one-shot UPDATE that moves a row to 'posting'; proves who may send it.
  claim       TEXT,
  remote_id   TEXT,
  error       TEXT,
  drafted_at  TEXT NOT NULL,
  decided_at  TEXT,
  -- The Access identity that approved or skipped it.
  decided_by  TEXT,
  posted_at   TEXT
);

-- An event is posted to a platform once, ever — but only a live or sent row may block it.
--
-- Partial on purpose. A plain unique index would mean a draft nobody approved before its
-- post_date burns that event for good: the first weekend the console is not looked at,
-- those few events could never be drafted again, and their series would sit out the
-- cooldown as well. Undecided drafts become 'expired' once their date passes, which frees
-- them. The draft pass therefore checks the day's existing rows itself rather than
-- leaning on INSERT OR IGNORE, which this index no longer provides.
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_posts_key ON social_posts (platform, post_key)
  WHERE status IN ('approved', 'posting', 'posted');

CREATE INDEX IF NOT EXISTS idx_social_posts_series ON social_posts (series_key, post_date);
CREATE INDEX IF NOT EXISTS idx_social_posts_queue ON social_posts (status, post_date);

-- Which of the daily passes have already run, in local dates.
--
-- The cron fires every hour and the pass gates on the Toronto clock rather than on a
-- fixed UTC hour, which would drift by an hour twice a year. That makes the repeated hour
-- in the autumn fall-back a real possibility, and this primary key makes it a no-op.
CREATE TABLE IF NOT EXISTS social_runs (
  -- 'draft' | 'post'
  kind       TEXT NOT NULL,
  local_date TEXT NOT NULL,
  ran_at     TEXT NOT NULL,
  stats      TEXT,
  PRIMARY KEY (kind, local_date)
);
