-- A suggestion can now be accepted without an event being made from it: handled_as gains
-- 'accepted' beside 'event' and 'dismissed'.
--
-- Accepting either way emails the suggester, if they left an address. The outcome is kept
-- here ('sent', 'error: …'), and its presence is what stops a second email when an
-- acceptance is undone and made again.
ALTER TABLE suggestions ADD COLUMN accepted_mail TEXT;
