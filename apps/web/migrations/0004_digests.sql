-- Email digests (SCEC-109): a reader's pins and saved views, by email, once a day or once
-- a week. Off unless the reader turns it on.
--
-- The settings ride on user_calendars, one row per reader already. The hour and day are in
-- America/Toronto wall time, and there is no timezone column: the whole site assumes that
-- zone (events, "today", "on now"), and a reader in another one is reading about Simcoe
-- County. digest_day is 0 = Sunday to 6 = Saturday, used only by 'weekly'.
ALTER TABLE user_calendars ADD COLUMN digest TEXT NOT NULL DEFAULT 'none';
ALTER TABLE user_calendars ADD COLUMN digest_hour INTEGER NOT NULL DEFAULT 8;
ALTER TABLE user_calendars ADD COLUMN digest_day INTEGER NOT NULL DEFAULT 4;

-- One row per digest period per reader, CLAIMED before the message is sent: the primary
-- key is what makes a re-run, an overlapping cron or a retry unable to send a second copy.
-- period_key is 'd:2026-09-24' (daily), 'w:2026-09-24' (weekly, the send date — digest_day
-- already fixes which day of the week that is) or 'p:2026-09-24' (the account page's
-- once-a-day preview). outcome moves from 'sending' to 'sent', 'skipped-empty' (a window
-- with nothing in it sends nothing) or 'error: …'. A failed send is not retried within its
-- period, because a failure reported after delivery would make the retry a second copy.
CREATE TABLE digest_sends (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_key  TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, period_key)
);
-- The daily budget counts today's sends across everyone.
CREATE INDEX digest_sends_created ON digest_sends(created_at);
