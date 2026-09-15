-- Posters uploaded with a suggestion, and what became of each suggestion.
--
-- The image itself lives in the private R2 bucket scec-suggestion-posters, under
-- poster_key. It is shown to the admin through the console, behind Access, and served
-- publicly only once its suggestion has been approved as an event.
ALTER TABLE suggestions ADD COLUMN poster_key TEXT;
-- Decided from the file's own bytes at upload, never from its name or declared type.
ALTER TABLE suggestions ADD COLUMN poster_type TEXT;
-- Why a poster that was sent is not stored. The suggestion is kept either way.
ALTER TABLE suggestions ADD COLUMN poster_error TEXT;

-- 'event' when approved into a manual event, 'dismissed' otherwise; NULL while waiting.
-- handled_at (0004) records when.
ALTER TABLE suggestions ADD COLUMN handled_as TEXT;
-- The manual listing an approved suggestion became.
ALTER TABLE suggestions ADD COLUMN handled_listing_id TEXT;

CREATE INDEX IF NOT EXISTS suggestions_inbox ON suggestions (handled_at, created_at);
