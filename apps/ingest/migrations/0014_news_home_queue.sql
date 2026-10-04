-- The second-chance queue, for articles the nightly browser could not render either.
--
-- The EC2 browser gives up on a page after three nights. Measured 2026-10-04, that had
-- happened to 19 articles: 13 BarrieToday pages outside /local-news/ and 6 BradfordToday
-- pages, every one of them on a zone that escalates a datacentre IP to an interactive
-- "Verify you are human" check while a residential connection is usually let straight
-- through (BradfordToday rendered 4 of 5 from a laptop the same hour EC2 managed 1 in 7).
--
-- So once the browser has given up, the scraper hands the article to a Cloudflare Queue,
-- and a script on a home server pulls from it, renders the page in a real browser, and
-- leaves the HTML in the same R2 bucket the EC2 run uses. The next ordinary run recovers it
-- exactly like any other page.
--
-- Schema lives here for the same reason 0009 does: one database, one migration authority.

-- When the browser was last handed this article. `browser_attempts` counts handouts; this
-- dates the last one, so the home queue only takes an article once its third night has had
-- time to come back — otherwise a page the browser rendered at 09:50 could be sent home at
-- 09:53 and rendered twice.
ALTER TABLE news_articles ADD COLUMN browser_handed_at TEXT;

-- When it went to the home queue. Set once; the queue itself owns the retries from there.
ALTER TABLE news_articles ADD COLUMN home_queued_at TEXT;

-- Articles handed to the home queue this run.
ALTER TABLE news_runs ADD COLUMN sent_home INTEGER NOT NULL DEFAULT 0;
