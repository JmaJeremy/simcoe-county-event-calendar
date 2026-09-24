-- Which event pages Facebook has been asked to read, and the card it was shown.
--
-- Facebook caches a link's preview (title, description, picture) the first time the link
-- is shared, and a share that races that first fetch goes out as a bare link — Messenger
-- did exactly that with /e/1d90301 on 2026-09-24, although the page's og tags were
-- complete. The Graph API's `scrape=true` makes it read the page ahead of time. The
-- companion social poster (JmaJeremy/social-event-poster) does that for new and changed
-- events, because it already holds the Page token; like social_posts, the table is created
-- here and this repo's deploy applies it. The ingest worker never holds that token.
--
-- card_hash covers every column the event page's og tags are built from, plus the measured
-- poster size that decides which picture travels, so a changed title, date, cost or
-- newly measured poster sends the page round again and an unchanged one never does. Keyed
-- on the event id; on the platforms whose ids encode the date, a moved event is a new id
-- and simply a new row. ok = 0 with an error is a refusal about that one URL, recorded so
-- it is not retried every hour; a rate limit or bad token is not recorded at all.
CREATE TABLE IF NOT EXISTS share_scrapes (
  event_id   TEXT PRIMARY KEY,
  card_hash  TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  error      TEXT,
  scraped_at TEXT NOT NULL
);
