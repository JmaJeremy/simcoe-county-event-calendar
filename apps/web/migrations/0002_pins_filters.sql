-- Pins and saved views (SCEC-106): the first things an account owns. Both cascade with the
-- user, so deleting a person stays one statement against users and strands nothing.

-- One row per event a reader pinned. event_id points into scec's events table, in ANOTHER
-- database: no foreign key is possible, and on govStack, Drupal rows and SPACES a moved
-- event becomes a new cluster with a new id while the old row is closed. So the pin keeps a
-- snapshot of what it pointed at — title, date and short code at pinning, refreshed
-- whenever the account page finds them changed — and a pin whose event is gone or inactive
-- can still say what it was ("withdrawn") instead of showing a blank row.
-- The primary key is the only index needed: every read is "this user's pins", a prefix of it.
CREATE TABLE calendar_pins (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id   TEXT NOT NULL,
  title      TEXT NOT NULL,
  local_date TEXT NOT NULL,
  short_code TEXT NOT NULL,
  pinned_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, event_id)
);

-- One row per saved view. `query` is a canonical query string in the site's own filter
-- language (savedQueryFrom in src/query.ts) — the same string the list URL and the iCal
-- feed read — so there is no second filter schema to keep in step with the first, and the
-- value can be pasted into an address bar. Unique per user so saving a view twice is a
-- no-op, not a duplicate; the unique index is also the per-user read's index.
CREATE TABLE calendar_filters (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  query      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, query)
);
