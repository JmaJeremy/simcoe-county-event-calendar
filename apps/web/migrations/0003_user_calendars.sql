-- A reader's own calendar (SCEC-107, SCEC-108): the private feed of their pins, and the
-- optional public link that shares them. One row per user, created the first time the
-- account page is shown, and gone with the user.
--
-- The private feed's URL is /calendar/{calendar_id}.{mac}.ics, where mac is an HMAC under
-- the FEED_TOKEN_KEY secret over calendar_id and feed_generation. Nothing in this table is
-- the token, so a copy of the database opens no one's feed — the property hashing the token
-- would give — and yet the account page can show the link again whenever it is asked, which
-- a hashed token could not: a calendar URL gets pasted into a second device months later.
-- "Make a new link" bumps feed_generation, and every older link stops matching.
--
-- share_slug is the PUBLIC link, and is deliberately a different value from anything in
-- the private feed's URL: handing someone the shared calendar must never hand them the
-- means to reach the private one. NULL is not shared; turning sharing off clears it, and
-- turning it on again mints a fresh slug, so a link someone meant to kill stays dead.
CREATE TABLE user_calendars (
  user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  calendar_id     TEXT NOT NULL UNIQUE,
  feed_generation INTEGER NOT NULL DEFAULT 1,
  share_slug      TEXT UNIQUE,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
