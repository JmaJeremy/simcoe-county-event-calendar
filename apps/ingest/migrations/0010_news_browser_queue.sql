-- The browser-fetch queue, for articles a plain HTTP client cannot read.
--
-- Four of the six Village Media sites run a Cloudflare JavaScript challenge on their
-- article pages. It is not geography and not the user agent: measured 2026-09-20, the same
-- syndicated story answered 200 on barrietoday.com and 403 `cf-mitigated: challenge` on
-- midlandtoday.ca at the same moment, and a Canadian terminal got the same 403 a US one
-- did while a browser on that same Canadian machine got 200. Only something that executes
-- the challenge script gets in, which no Worker and no Lambda can do.
--
-- So the scraper queues what it cannot read, and once a day an ephemeral EC2 instance in
-- ca-central-1 renders those pages with Playwright and drops the HTML in R2. The next
-- ordinary run picks them up and treats them exactly like a page it fetched itself.
--
-- Schema lives here for the same reason 0009 does: one database, one migration authority.

-- When a challenge put this article in the browser queue. Cleared once the HTML arrives.
ALTER TABLE news_articles ADD COLUMN challenged_at TEXT;
-- When the browser actually rendered it, so a page that defeats even Playwright is not
-- queued for ever. Three attempts and it is left alone, like any other failure.
ALTER TABLE news_articles ADD COLUMN browser_at TEXT;
ALTER TABLE news_articles ADD COLUMN browser_attempts INTEGER NOT NULL DEFAULT 0;

-- What the daily browser run is asked for: queued, never rendered, not given up on.
CREATE INDEX IF NOT EXISTS idx_news_articles_queue
  ON news_articles (challenged_at, read_at, browser_attempts);

-- Pages recovered from R2 this run, counted apart from those fetched directly.
ALTER TABLE news_runs ADD COLUMN recovered INTEGER NOT NULL DEFAULT 0;
