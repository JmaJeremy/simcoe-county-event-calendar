-- Suggestions from the public "Are we missing something?" form.
--
-- Lives with the ingest migrations because this directory owns the whole schema, even
-- though only the web worker writes here. Every field a visitor types is optional and
-- untrusted; the web worker caps and validates them before they arrive.
CREATE TABLE IF NOT EXISTS suggestions (
  id           TEXT PRIMARY KEY,
  -- 'event' for a single event, 'website' for a site that lists many.
  kind         TEXT NOT NULL,
  name         TEXT,
  email        TEXT,
  title        TEXT,
  url          TEXT,
  -- As typed into the form's date and time inputs: 'YYYY-MM-DD' and 'HH:MM'.
  event_date   TEXT,
  event_time   TEXT,
  description  TEXT,
  comments     TEXT,
  -- SHA-256 of the sender's IP salted with the UTC date: enough to rate-limit within a
  -- day, useless for following anyone across days.
  ip_hash      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  -- What happened to each email: 'sent', 'skipped' (no address given), or the error text.
  -- A failed send never loses the suggestion; it is here to be read.
  admin_mail   TEXT,
  user_mail    TEXT,
  -- For the admin to mark off by hand; nothing in the site reads it yet.
  handled_at   TEXT
);

CREATE INDEX IF NOT EXISTS suggestions_rate ON suggestions (ip_hash, created_at);
