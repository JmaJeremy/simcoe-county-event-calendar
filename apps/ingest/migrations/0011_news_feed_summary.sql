-- The feed's standfirst, kept for articles a browser cannot read.
--
-- BradfordToday's zone answers a datacentre IP with an interactive Cloudflare "Verify you
-- are human" checkbox, so the nightly browser pass renders about one of its pages in
-- seven. Nothing in the scraper answers that checkbox, and nothing will. But every zone
-- serves its /rss feed to anyone, and each item carries a one- or two-sentence standfirst
-- that often names the event, the day and the place. For sources marked to skip the
-- browser, a challenged article is staged from that instead.
--
-- Written when the article is first polled, since the feed only holds the last twenty
-- items and the summary cannot be fetched again once the item has scrolled off.
ALTER TABLE news_articles ADD COLUMN summary TEXT;

-- Articles read from their feed summary this run, counted apart from pages read directly
-- and pages recovered from the browser.
ALTER TABLE news_runs ADD COLUMN from_feed INTEGER NOT NULL DEFAULT 0;
