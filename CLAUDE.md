# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**Out in Simcoe** (outinsimcoe.ca) — a public calendar of community events across Simcoe County, Ontario — the county, its 16
member municipalities, and the separated cities of Barrie and Orillia — aggregated from
municipal, county, library and local-media calendars and **de-duplicated across sources**.
TypeScript monorepo (npm workspaces) targeting Cloudflare Workers + D1, built on the same
pattern as `/Users/jeremy/Code/civi-times` (civic meetings). The two sites share
municipality slugs so they can link to each other.

Work is tracked in Jira project SCEC (https://autario.atlassian.net). Ticket keys live in
`docs/jira-keys.json`; reference them in commit messages.

## Commands

```bash
npm install
npm test                                    # vitest; fixtures, no network; UI suite needs system Chrome (skips otherwise)
npm run typecheck
node --experimental-strip-types apps/ingest/src/cli.ts [--source <slug>] [--platform <p>] [--json]   # dry run, writes nothing

# Full pipeline against a LOCAL D1 (ingest + dedup), then the site on top of it
npx wrangler d1 migrations apply scec --local --config apps/ingest/wrangler.jsonc
npx wrangler dev --config apps/ingest/wrangler.jsonc --port 8787 --var INGEST_TOKEN:dev
curl -X POST 'http://localhost:8787/run?token=dev'                 # add &source=<slug> or &dedup=0
npx wrangler dev --config apps/web/wrangler.jsonc --port 8788 --persist-to apps/ingest/.wrangler/state
node --experimental-strip-types apps/ingest/scripts/dedup-report.ts apps/ingest/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite
node --experimental-strip-types apps/web/scripts/brand.ts          # re-render icons + og.png
node --experimental-strip-types apps/web/scripts/social-cards.ts   # re-render the Instagram cards
```

A full run takes ~2 min and ~660 HTTP requests: 40/40 sources for ~5,300 listings (Eventbrite
alone is 13 slow requests, ~25 s; Barrie's 823 library events are one request), then up to 300
event pages read for price and posters, then the unclear listings that mention a sum sent to the cost judge (a few a run, capped at 200),
then dedup over ~9,000 pairs into ~4,650 events. **The subrequest ceiling is 10,000 per
invocation**, the paid-plan default since 2026-02-11 (it was 1,000 before, and the older
figure is still written in a few comments), and it can be raised to 10M with a
`subrequests` limit in wrangler config. A subrequest is not only a `fetch()`: **every D1
call counts**, as do R2, KV, Cache and Queue operations — so a run's true total is its
~660 HTTP requests plus every statement the repository executes, which is the larger
number of the two. The budgets in `enrich.ts` and `cost.ts` therefore exist to bound the
token bill and the run's wall clock, not because the ceiling is close; there is roughly an
order of magnitude of headroom. Six outbound connections may await response headers at
once, whatever the plan, which is what actually paces a run.

## Architecture

```
packages/core/       types, municipalities + gazetteer, sources registry, time, identity,
                     title/civic-meeting rules, normalize (cost, category), reconcile, dedup, ical
packages/adapters/   one module per PLATFORM + shared http; test/fixtures are captured responses
apps/ingest/         pipeline, D1 repository, detail enrichment, cost judge, dedup runner,
                     cron worker, dry-run CLI, migrations
apps/web/            API + iCal + server-rendered pages (event, municipality, 404, robots,
                     sitemap) + suggestion form worker, static front end
```

**A run is four passes, in this order**: fetch every source (`pipeline.ts`), read event
pages for the listings that need one (`enrich.ts`), ask the cost judge about listings
still unclear on price (`cost.ts`), then cluster (`dedup.ts`). The order is load-bearing:
dedup rewrites every event from its representative listing, so anything the middle two
passes learn reaches the site in the same run instead of two hours later.

**Adapters are per platform, sources are per site.** Sixteen adapters cover 40 enabled sources; adding a
site on a supported platform is a row in `packages/core/src/sources.ts`. Eventbrite and
Ticketmaster need credentials, passed to adapters as an `AdapterContext` the worker builds
from its secrets and the dry-run CLI from the environment (`adapterContextFrom`).

**Listings vs events.** A `Listing` is one source's view of one occurrence, keyed
`(source, platform id)`. An `Event` is a cluster of listings the de-duplicator judged to be
the same thing; its id is the representative listing's id at creation and never changes.

## Deployment

**`main` is production.** Every change goes on its own branch with a PR, and every PR into
`main` runs `.github/workflows/test.yml` against its merge with `main`. Merging to `main`
runs `.github/workflows/deploy.yml`, which tests, applies D1 migrations, deploys both
workers and checks `/health`. It needs the repository secrets `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`; the workers' own secrets live in Cloudflare and survive a deploy.
Never merge a branch that is behind what is live: the push deploys `main` exactly as it is.
The commands below are for deploying by hand.

Two Workers on the shared `scec` D1 database (id `2a5bb740-6719-4498-9c0d-4f8eb7b601b9`):

```bash
set -a; . ./.env; set +a          # CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN / INGEST_TOKEN
npx wrangler d1 migrations apply scec --remote --config apps/ingest/wrangler.jsonc
npx wrangler deploy --config apps/ingest/wrangler.jsonc   # cron: 23 past every second hour
npx wrangler deploy --config apps/web/wrangler.jsonc
printf '%s' "$INGEST_TOKEN" | npx wrangler secret put INGEST_TOKEN --config apps/ingest/wrangler.jsonc
printf '%s' "$ANTHROPIC_API_KEY" | npx wrangler secret put ANTHROPIC_API_KEY --config apps/ingest/wrangler.jsonc
printf '%s' "$EVENTBRITE_TOKEN" | npx wrangler secret put EVENTBRITE_TOKEN --config apps/ingest/wrangler.jsonc
printf '%s' "$TICKETMASTER_CONSUMER_KEY" | npx wrangler secret put TICKETMASTER_CONSUMER_KEY --config apps/ingest/wrangler.jsonc
for k in FETCH_PROXY_FUNCTION FETCH_PROXY_REGION FETCH_PROXY_ACCESS_KEY_ID FETCH_PROXY_SECRET_ACCESS_KEY; do
  printf '%s' "${(P)k}" | npx wrangler secret put "$k" --config apps/ingest/wrangler.jsonc   # zsh
done

# Trigger a run by hand and read the summary
curl -X POST "https://scec-ingest.thejeremy-net.workers.dev/run?token=$INGEST_TOKEN"
```

- Site: https://outinsimcoe.ca (Worker `scec-web`; `scec-web.thejeremy-net.workers.dev`
  still answers as a fallback). `outinsimcoe.ca` and `www.outinsimcoe.ca` are custom
  domains on the worker; `CANONICAL_HOST` in `wrangler.jsonc` names the apex, which makes
  the worker redirect `www` to it and pin every share card, permalink and feed URL to one
  origin no matter which host answered.
- Ingest: https://scec-ingest.thejeremy-net.workers.dev (token-guarded, not public)
- Console: https://console.outinsimcoe.ca — the admin console for adding events by hand,
  served by the **ingest** worker on its own custom domain behind the Cloudflare Access
  application "outinsimcoe.ca console". `CONSOLE_HOST`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`
  and `PUBLIC_ORIGIN` are plain vars in `apps/ingest/wrangler.jsonc`; none is a secret.
  It also holds the suggestions inbox and an editor for any event (`/find`). Posters live in the private R2 bucket
  `scec-suggestion-posters`, bound as `POSTERS` on both workers; the web worker's
  `CONSOLE_ORIGIN` var is where the admin email's links point.
- Zone settings on `outinsimcoe.ca` are Cloudflare defaults except **Always Use HTTPS**,
  turned on when the domain was attached — without it the site answered on plain HTTP.
  HSTS is deliberately off: it is a long-lived promise and there is no reason to make it yet.
- `.env` is gitignored, as is `jeremy-atlassian-token.key`. Keep it that way.
- **Commits are checked for secrets** by gitleaks in `.githooks/pre-commit`; `npm install`
  enables it (the `prepare` script sets `core.hooksPath`). It fails closed if gitleaks is not
  installed (`brew install gitleaks`). `.gitleaks.toml` allowlists three public identifiers
  the generic-api-key rule mistakes for secrets — keep that list short and specific.

## Search

The worker renders four surfaces itself, split out of `worker.ts` so they cannot drift:
`html.ts` builds the head every one of them shares, `pages.ts` renders the event page, the
municipality page and the 404, `sitemap.ts` emits `/robots.txt` and `/sitemap.xml`.
`apps/web/test/seo.test.ts` covers them against a stub database — metadata is invisible
when it breaks, so nothing here is checked by eye.

- **`/place/{slug}` exists as much for crawlers as for readers.** The home page is a
  filterable app — every view of it is a query string, rendered from JSON after load — so
  nothing on the site was *about* one town, and `/e/{code}` permalinks were reachable only
  from a link someone had already shared. The nineteen municipality pages are the crawlable
  path to all of them, and the `__PLACE_LINKS__` block in the footer is the crawlable path
  to the municipality pages. Remove either and the event permalinks are orphans in the
  sitemap again. The slugs match civi-times', so `/place/tay` exists on both sites.

- **A municipality page shows paid events; the list does not.** `buildQuery`'s default
  hides them because most readers want the free things, but a page answering "what is on
  in this town" that silently dropped every ticketed concert would answer a different
  question. That is why `placeResponse` writes its own SQL rather than calling
  `buildQuery`. Civic meetings stay out, as everywhere else.

- **Anything but `CANONICAL_HOST` gets `X-Robots-Tag: noindex, follow`.** The workers.dev
  fallback serves the identical site; without it two hosts compete for the same queries.
  robots.txt there deliberately still allows crawling — `Disallow: /` would stop a crawler
  ever reading the header that does the work, and a blocked URL can still be indexed from
  inbound links. With no `CANONICAL_HOST` set there is only one host and nothing to prefer.

- **The sitemap has no `lastmod`, on purpose.** Dedup rewrites every event in its window
  each run, so `updated_at` is "the last cron run" for nearly all of them (2,127 of 2,161
  when measured). A lastmod built from it claims everything changed two hours ago, and
  search engines then ignore the field site-wide. It comes back with SCEC-56, when
  `updated_at` only moves on a real change. `/suggest` is left out too: it is noindex, and
  a sitemap listing a noindex page is a Search Console error.

- **A municipality page lists at most 120 upcoming events but counts them all.** Essa has
  several hundred; the page says how many there are and links to the calendar filtered to
  that town for the rest.

- **`isAccessibleForFree` is only emitted when the cost is known.** `false` for "cost not
  listed" would tell search engines most events here charge admission.

- **An Event needs a `location` carrying an `address`.** Google treats one without as an
  error, not a warning, and a venue name is not an address. Most of these events publish
  neither, so the municipality stands in rather than the property going missing.

## Things that will bite you

- **Identity is the platform's id for the occurrence.** Only some platforms give one that
  survives edits: EventON (post id), The Events Calendar (occurrence id), CitySpark
  (`PId`), Drupal FullCalendar (`eid`). On govStack (detail slug = date+time+title), Drupal
  rows (`path@datetime`) and SPACES (`dataId@startDate`) the id ENCODES content, so an
  organiser editing the time retires one listing and creates another. That is why
  reconciliation only ever flips `active` — it never infers a cancellation from a listing
  vanishing — and why a rescheduled event on those platforms gets a new cluster and a new
  short link. `status` comes from the source's own text. See `reconcile.ts`.
- **`localStart` is always a naive America/Toronto wall string.** `normalize` converts it
  exactly once. Sources that publish offsets or UTC (Drupal, CitySpark, EventON) must emit
  the local form in the adapter, or times double-convert.
- **The empty-response guard in `reconcile()` is load-bearing.** A source returning zero
  listings is far more likely to be an outage than a calendar with nothing on it.
- **govStack hosts 403 anything that does not look like a browser.** `USER_AGENT` is a
  Chrome string with our name and repo appended; do not "clean it up".
- **EventON's `data-time` is not UTC.** simcoe.ca's WordPress zone is UTC+1, so the unix
  value is five hours off there and right on adjtos.ca. The adapter reads the JSON-LD wall
  clock instead; keep it that way.
- **Never merge on title + time alone across different municipalities.** Two townships'
  "Farmers' Market" at 9:00 are two events. The municipality gate in dedup enforces this —
  with one exception, `samePlaceAndTime`: an identical street address (number and street)
  at the identical minute. A municipal calendar files everything under its own town, so
  Quest Art's week at 333 King Street, Midland, reposted by Tay and Penetanguishene, showed
  three times a day. The exception only makes the pair a candidate; `scorePair` still
  decides, and its title cap keeps two different events at one venue apart. It opens the
  clustering guard too, but only for that direct edge, never through an unplaced copy.
  Measured 2026-09-21: 49 such pairs, all kept apart before; 46 the same event reposted,
  3 different events at one venue, which score distinct. No `RULES_VERSION` bump, since
  `scorePair` is unchanged. The merged event is filed under whichever town's listing is
  the representative — for three municipal copies that is a tie, not the true host.
- **A category is read from what an event is about, in order of how much each input says.**
  `classifyCategory` tries the source's subject labels ("Performing & Visual Arts"), then
  the title with place names removed ("Wasaga Beach Chess Club" is about chess), then
  audience and catch-all labels ("Seniors", "Adults", "Drop-in", "Community Event"), then
  gives up with `other`. Labels that say nothing ("Events", "Orillia events") and
  department names (Severn's "Recreation, Parks, and Facilities events") are skipped
  entirely: read first, "Parks" made 227 yoga, beading and chess sessions outdoors, and
  "Seniors" made a chair-yoga class community. Children's labels stay decisive on purpose,
  since `family` is itself an audience category. Measured on 5,153 live listings when it
  changed: about 1,070 moved, outdoors fell from 320 to 98.
- **A rule change reaches existing listings through `reclassified`, never a full update.**
  Reconciliation only rewrites a listing whose source text or time changed, so a better
  category or placement rule used to apply to new listings alone. Now a listing whose
  content hash is unchanged but whose `category` or `municipality_slug` comes out
  differently is written as those two columns only (`reclassifyListingStatements`). A full
  upsert would overwrite the description, price and poster the enrichment pass added, and
  with the content hash unchanged nothing would ever read the event page again.
- **The social poster lives in its own repository.** `JmaJeremy/social-event-poster` picks
  a few of each day's events and posts them to the site's Facebook, X and Instagram
  accounts. Like the news scraper, its worker binds **this** database with no
  `migrations_dir` of its own: `social_posts` and `social_runs` are created by
  `0008_social_posts.sql` here, and this repo's deploy applies them. It reads `events` and
  `municipalities` and writes nothing else. Three pieces stay on this side, for reasons
  that will not change: the **approval screen** (SCEC-89) belongs in the console, because
  it is a view over shared rows behind an Access application that already exists — the same
  place the scraper's drafts are reviewed; the **Instagram cards** (SCEC-93) are rendered
  by `apps/web/scripts` into `apps/web/public/social/` and served by the web worker,
  because Meta fetches them over public HTTPS and takes JPEG only; and `/privacy`, which
  names the social accounts.
- **The Instagram cards are static files, one per category in three colourways.**
  `scripts/social-cards.ts` writes `public/social/{category}-{0,1,2}.jpg` (1080x1080, JPEG
  quality 88 — Instagram refuses PNG, so never copy `brand.ts`'s screenshot call), and the
  poster picks a colourway by hashing the post's key. `civic-meeting` has none (it is never
  posted) and `other` is the card for anything unmapped. Static rather than rendered per
  event because `public/` is served from the edge with no route, so a card is public the
  moment it deploys and Meta can always fetch it; a per-event card would add a renderer that
  can fail on the one evening it matters. The category labels are `CATEGORY_LABELS` from
  `app.js` and the colours `--cat-*` from `style.css`, repeated in the script — change
  either, re-run it. Renaming or removing a card breaks any draft that already names it.
- **The console's `/social` page is where a person says yes to a post.** It lists the poster's
  drafts by the day they go out, then by event with every platform's post under it, exactly
  as they will be sent, and shows the last run's judge stats. Rows are addressed by their own
  uuid, never the event id, because listing ids carry colons and slashes. Approving is per
  **event** — the row and its siblings on the other platforms, same day — because a person
  approves an event, not a platform; skipping is per row, so one platform's post can be
  dropped while the others go out; `/social/day/{date}/approve` does a whole day. Every write
  is a conditional UPDATE that only moves a row out of the state it was shown in and never
  touches a day already past, so a stale tab cannot approve something sent or skipped — a
  write that matched nothing says "already moved on" rather than claiming success, and the
  partial unique index refusing a second approval says so too. Nothing here sends anything:
  approving marks a row for the poster's send pass (SCEC-90).
- **An edited post is compared with what the form was filled in with, and is never
  re-rendered.** The edit form posts `orig_body` beside `body` and stores nothing when they
  match — after turning the textarea's CRLF back into LF, or every untouched save would look
  edited. A save sets `hook_source = 'edited'`, which is what tells the send pass not to
  rebuild the post from the event, and only lands where the stored body is still the one
  edited, so two tabs cannot silently overwrite each other. An edit may not remove the link
  to the event or run past the platform's length; X's ceiling here is a plain character
  count, since the poster's `xLength` is the real one and its send pass checks again.
- **Two decisions in `0008_social_posts.sql` are not obvious and are load-bearing.** A row
  is keyed on `post_key` — municipality, normalized title and local date — and has no
  foreign key to `events`, because on govStack, Drupal rows and SPACES a rescheduled event
  becomes a new cluster with a new id: asked of `event_id`, "have we posted this?" answers
  no and it goes out twice, and a foreign key would take the draft down with the retired
  row. And the unique index is **partial**, over `('approved','posting','posted')` only, so
  a draft nobody approved before its date does not burn that event for good — one
  unattended weekend would otherwise spend those events and their series' cooldown.
  Undecided drafts turn `expired` instead. `snapshot` holds ten template inputs rather than
  the row, because dedup rewrites every event in its window on each of the six runs between
  drafting and sending.
- **Dedup: a listing with no municipality must never bridge two towns.** News-site copies
  (SPACES) often have `municipalitySlug = null`; `buildClusters` applies edges strongest-first
  and refuses one that would join two different placed municipalities. Listings that start
  on different dates never auto-merge (a theatre run vs one performance) — the judge decides.
  Changing any scoring rule means bumping `RULES_VERSION` so cached rule verdicts recompute.
- **A source duplicates itself, so same-source pairs are scored too** — but behind a
  stricter gate (`sameSourceCandidate`). BarrieToday carried one concert under both
  "arts-culture" and "live-music", Collingwood the same big band three times, Tay its own
  cribbage tournament twice, Eventbrite two ticket pages for one library programme; none
  could ever merge, because the pair was never a candidate. The gate is stricter than the
  cross-source score on purpose: across sources a differing venue is usually wording
  ("Downtown Branch" vs "Barrie Public Library, 60 Worsley St"), but within one source the
  naming is consistent, so a difference is real. Barrie Public Library runs "Kindergarten
  School Skills" at 10:00 at three branches at once and the ordinary score merges all
  three — the shared word "Branch" alone lifts them to 0.94. So one source's listings pair
  only when the place matches exactly (or one side is silent) and the time agrees exactly;
  two showings of "Friday Flicks" and 40-minute tech-help slots stay apart. The gate is
  most of the value: ~8,400 same-source pairs share a date, and it throws out all but ~286
  of them (9,006 candidate pairs became 9,292), so the judge budget barely moves. It needs
  no `RULES_VERSION` bump: `scorePair` is unchanged, so cached verdicts stay valid and the
  new pairs have none. Measured on the first run: 28 self-duplicate clusters across 12
  sources, 18 judge calls.
- **The judge is optional and cached.** Without `ANTHROPIC_API_KEY` ambiguous pairs stay
  unmerged (`unresolved` in the run stats) and are retried next run. A verdict is stored per
  pair per content hash, so the model sees each pair once.
- **The dark palette is written twice**, once under `prefers-color-scheme` guarded by
  `:root:not([data-theme="light"])` and once under `:root[data-theme="dark"]`. Three theme
  states need that: the system preference must lose to an explicit light choice, and an
  explicit dark choice must beat a light system. Change one block, change the other.
- **The theme is applied by an inline script in the head**, in `index.html` and in
  `renderHead` (which every server-rendered page shares), before the stylesheet. Without it every load flashes white for a reader who
  chose dark. `app.js` sets it too, but that is too late to matter. A browser test blocks
  `app.js` on reload to prove the head script is doing the work.
- **A typed date range replaces the "upcoming only" default** rather than narrowing it —
  see `inDateScope`. Someone who asks for last week means last week, whatever the "Past
  events" box says. `from`/`to` also ride along to the iCal feed.
- **Never change the iCal UID domain again.** It is `outinsimcoe.ca`, moved off the
  placeholder `events.simcoe` on the day the domain was registered, while nobody had
  subscribed. A subscribed calendar treats a changed UID as a different event, so it
  deletes every entry and re-adds a copy. See the comment in `packages/core/src/ical.ts`.
- **Two passes are queues, not sweeps.** Reading an event page for all 1,500 govStack and
  Drupal listings, or judging every unclear price, would blow the subrequest budget and
  the token bill. Each run takes the next N by date and records what it did —
  `listings.detail_hash` for pages read, the `cost_decisions` table for prices judged,
  both keyed on the listing's `content_hash` so an edited listing comes round again and an
  unedited one never does. Neither ever touches `content_hash` itself; reconciliation owns
  that.
- **Parse the event's container, never the page.** Barrie's event page is 146KB of which
  the event is 2.6KB. A "$" from the site's own footer would price a free concert, and
  govStack recreation pages carry the arena's drop-in rate card below the description —
  which is why the govStack parser stops at the "See more" toggle.
- **The cost judge is only asked about listings that contain a sum of money.** It can
  only return a sentence already in the listing, and `decideCost` then requires that
  sentence to state a price, so a listing with no sum in it has nothing to find. Over the
  first 1,463 readings every one of the 66 that produced a price came from a listing
  containing money, and the other 1,371 came back unclear without exception — so the gate
  cuts the calls by about 95% and loses nothing measurable. `loadCostCandidates` screens in
  SQL with a deliberately loose `LIKE` superset (SQLite cannot express core's `MONEY`
  pattern; `'%cad%'` also matches "academy"), and `judgeCosts` applies `containsMoney`
  itself. It self-heals: text that gains a price gets a new content hash and becomes a
  candidate. A miss is cheap, since an unknown cost still shows in the default view.
- **The cost judge is a finder, not a decider.** It returns the sentence that states the
  price; `decideCost` then checks that sentence really appears in the listing and runs the
  ordinary cost rules over it. Never let a model's verdict set a cost directly. The bar is
  higher for paid than for free on purpose: a free event wrongly marked paid vanishes from
  the view almost everyone uses.
- **A source's poster is measured once, and keyed on its URL.** `image_sizes` (migration
  0012) holds a poster's pixel size; `measureImageSizes` fills it after dedup, a few a run,
  by reading only the first 64KB — every format states its size in a header, so a ranged
  request is enough. It skips what `shareablePoster` rejects, the one copy of the govStack
  host rule that core now holds for both apps: 208 of the first 1,009 rows measured were
  posters nothing could ever share. Keyed on the URL because a poster is shared: 1,961 upcoming events
  carried 694 distinct images when this was written, and Barrie library's 598 listings use
  46 between them. A row with NULL width means "read, and it did not say" (an SVG, a 404, a
  JPEG whose frame header sat past the range) — it exists so the pass does not retry that
  URL every two hours. The event page reads the size when it renders, so nothing waits on
  the pass and a failure costs a share card, never a run. `imageSize` in core never guesses:
  Facebook lays the card out from these numbers, so silence beats a wrong width. The
  one-time catch-up for posters already on the site is
  `apps/ingest/scripts/backfill-image-sizes.ts`, which runs on a laptop precisely because
  a laptop has no subrequest ceiling, no CPU limit and no cron to fit inside.
- **A share card states its own size; a source's poster does not.** Facebook will not hold
  a story open while it fetches an image, so without `og:image:width`/`height` the first
  share of a URL is a bare link and the picture only appears once the crawler has been
  round — which is after the moment that mattered. `renderHead` declares `SHARE_IMAGE`'s
  1200x630 whenever the card is our own `og.png`, and stays silent for a source's poster,
  which arrives at whatever size that site chose: Facebook lays the card out from these
  numbers, so a guessed one is worse than none. `index.html` carries its own copy, as it
  does for every og tag. Change `brand.ts`'s canvas, change `SHARE_IMAGE`. A URL Facebook
  has already scraped keeps its old card until the Sharing Debugger re-scrapes it.
- **A poster is the share image only when it is big enough to be one.** `shareCard` in
  `pages.ts`: a measured poster of at least 600x315 travels with the link, and everything
  else takes the site's own 1200x630 card. Below that floor Facebook draws a small square
  thumbnail beside the text, and below 200px it drops the picture altogether — so for those
  the card says less but shows up. Measured on the live site (2026-09-22): of 2,012 upcoming
  events with a usable poster, 1,317 clear the bar, 599 would be a thumbnail, 96 nothing.
  An **unmeasured** poster takes the card too, the same trade a beat later — the pass reads
  it within a run or two. Every card the site emits is therefore wide, and `twitterCard` is
  always `summary_large_image`; the old `summary` case is gone. The event page itself always
  shows the poster, whatever travels with the link.
- **A govStack poster cannot be a share image.** Those hosts 403 anything that is not a
  browser, crawlers included, so `shareableImage` in the web worker keeps them out of
  `og:image` while the page still shows them to visitors.
- **The mark exists in three copies**: inline in `public/index.html`, as `MARK` in
  `apps/web/src/html.ts` (both in CSS variables) and in `scripts/brand.ts` (hardcoded
  hex, because a screenshot cannot read CSS variables). Change one, change all three, and
  re-run `brand.ts` — the palette is repeated at the top of that script for the same reason.
- **Fraunces is self-hosted in `public/fonts/`** (SIL OFL), not linked from Google. The UI
  suite loads the page with `networkidle0` and `npm test` is promised to run with no
  network, so a third-party font request would hang the tests offline.
- **An event link carries the list's filters** (`/e/{code}?m=tay&…`) and the event page
  turns them back into its "All events" href through `listUrlFrom`. That function rebuilds
  the query from a whitelist rather than echoing it: the input is a stranger's text on its
  way into an href.
- **`m=unspecified` is not a municipality.** It is the sentinel for events no town could
  be resolved for, exported as `UNPLACED` from `apps/web/src/query.ts` and repeated in
  `public/app.js`. The query builder turns it into `municipality_slug IS NULL` and ORs it
  with any real slugs in the same list, so the two combine. Unplaced events read
  "Not specified" everywhere — menu, pill, card badge, calendar chip.
- **"Upcoming" means not over yet, not dated today or later.** `hasFinished` in `app.js`
  retires an event when its published end time passes, and nothing else may: all-day
  events and the ~1,500 with no end time stay until their last day is over (America/Toronto).
  Something that started on an earlier day and is still running is filed under today
  (`listDate`, which asks `runsToday`), not under a heading reading "3 days ago". The
  calendar view is untouched; "Past events" still shows everything.
- **A span longer than a day states DAILY hours, not a continuous run.** "Barrie Hill
  Farms Fall Festival Weekends, Sep 5 9:00 to Oct 31 17:00" means the farm opens at 9:00
  and closes at 17:00 on the days it runs. Read as one unbroken interval it put an "On
  now" tag on three farm festivals, a quilt fair and a blues festival at half past two in
  the morning. So `isOnNow` tests the clock against that window, while `listDate` only
  asks whether the event runs today at all — a month-long festival shut at this hour still
  belongs under today's heading. The trigger is duration, never the calendar: hundreds of
  events end on a later date than they start without being spans (a 19:00 concert
  finishing at 21:00 is already the next day in UTC), so "covers two dates" would strip
  the tag from every evening out. Measured instead — below a day the longest continuous
  run is 16 hours, above it the shortest true span is 26, and the three rows at exactly 24
  all open and close at the same clock (20:00 to 20:00 for a Friday-and-Saturday show),
  so a day or more counts. The gap is not perfectly clean: a 22-hour conference running
  19:00 to 17:00 the next day still reads as continuous, and nothing in the data tells it
  from an overnight retreat that genuinely is.
  `dailyWindow` believes a window only when it opens before it closes and not at 00:00; of
  the 41 spans live when this was written, 28 qualified, 8 close before they open (the two
  clocks are a theatre run's opening night and its closing matinee, not one day's hours),
  2 open and close at the same minute, and 3 start at 00:00, which is already this site's
  way of saying no time was given. For those 13 the hours are unknown and no tag is shown.
  All-day spans have no clock to test and keep the tag they always had.
- **A card and an event page both say when a span ends.** A card filed under today reading
  only "9:00 a.m." cannot be told from a one-morning fair, so `renderEvent` adds "until
  October 31" whenever the last day is later than the heading it sits under, and
  `describeWhen` writes "September 5, 2026 to October 31, 2026, 9:00 a.m. to 5:00 p.m."
  rather than dropping the end date as it used to. The two are separate copies of the same
  rule, `app.js` and `pages.ts`, as `UNPLACED` is — change one, change the other.
- **Suggestions are stored before they are mailed.** `POST /api/suggest` validates
  (`src/suggest.ts`), inserts into `suggestions`, then sends two emails through the `EMAIL`
  binding (Cloudflare Email Service), recording each outcome on the row. A mail failure
  still answers "thanks" — the row is the record, the mail is a notification. The table's
  migration lives in `apps/ingest/migrations/` like every other, though only the web worker
  writes it: apply migrations **before** deploying the web worker or the form 500s
  (0005 added the poster and handled columns its INSERT names).
- **The thank-you email echoes nothing the visitor typed**, not even their name. Anyone can
  put anyone's address in the form; an echo would let them mail their own words to a
  stranger from outinsimcoe.ca. The admin copy has everything, with Reply-To set to the
  suggester. Abuse limits are a honeypot field (`company`), field caps, http(s)-only links,
  5 per hour per IP hash salted with the UTC date, and Turnstile.
- **Turnstile fails closed.** The worker verifies every token with siteverify — and checks
  that `action` is `suggest` and `hostname` is the host that served the form — after
  validation and before the rate limit or any write. Without `TURNSTILE_SECRET_KEY`, or
  with siteverify unreachable, the form refuses everything. So the form needs JavaScript;
  a scripts-off post is told so. The site key is public and hardcoded in `suggest.js`;
  the widget ("outinsimcoe.ca suggestion form") also allows localhost and the workers.dev
  host, so `wrangler dev --var TURNSTILE_SECRET_KEY:$TURNSTILE_SECRET_KEY` works locally.
- **No email address is ever served whole.** Harvesters read page source, scripts and
  responses. `suggest.html` shows the site's address split by `.decoy` spans (hidden with
  `display: none`, so people neither see nor copy them), `suggest.js` assembles it at
  runtime as `CONTACT`, and the worker's messages say `{contact}` for the script to fill
  in. `ADMIN_ADDRESS` in `worker.ts` belongs in mail headers only. `test/no-email.test.ts`
  scans every served file and the worker's replies for anything email-shaped — including
  an example address in a comment.
- **No share URL can tag the Facebook Page, and nothing should pretend otherwise.**
  `sharer.php` honours only its `u` parameter — `quote` and `hashtag` stopped working — and
  a Page tag in a post can only be typed by the person posting. What the site can do is
  claim the link: `article:publisher` names the Page (`FACEBOOK_PAGE` in `html.ts`, repeated
  in `index.html`'s own head), and the share dialog carries a plain "Follow Out in Simcoe on
  Facebook" link. `fb:pages` carries the numeric Page id (`FACEBOOK_PAGE_ID`), which is
  public — it is on the Page's transparency panel — and is not the poster's `META_PAGE_TOKEN`.
  Attribution only takes full effect once outinsimcoe.ca is verified in Meta Business Suite.
  `fb:app_id` carries the app id, which is public for the same reason.
  An **App ID is public** and belongs in the client; an app secret or access token is
  neither and must never reach `share.js` or any other served file.
- **Messenger goes two ways, and the plain Facebook button goes neither.** A touch device
  gets the `fb-messenger://` deep link, which hands off to the app and needs no app id; a
  desktop gets the Send Dialog, which does (`FB_APP_ID` in `share.js`, public). The deep
  link keeps its lack of a `target`, or the app takes over and leaves a blank tab behind.
  The Send Dialog needs `redirect_uri`, and Facebook checks it against the app's allowed
  domains, so it is built from the **canonical** origin and never from whatever host
  answered — the workers.dev fallback serves the identical site and is deliberately not on
  that list. Two things live in the Meta dashboard, not here: `outinsimcoe.ca` among the
  app's domains, and the app in **Live** mode, or the dialog only opens for app roles.
  The main Facebook button stays on `sharer.php` on purpose: no app, no configuration, no
  review, so it cannot break. `.share-targets` is an auto-fit grid because the count
  changes with the device.
- **Never give an element the id `turnstile`.** An id becomes a global of the same name,
  so `window.turnstile` was the widget's own `<div>`: Turnstile warned "already has been
  loaded" and `render` was "not a function", and no widget ever appeared.
- **Headless browsers never get a real Turnstile token** — Cloudflare flags them as bots.
  Test the wiring with Cloudflare's always-pass keys instead (site key
  `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA`). Their
  token comes back with action `test`, so expect our worker to refuse it as
  `action-mismatch`: that refusal is the proof the whole chain ran.
- **The work-in-progress tag and the footer's copyright, licence and Privacy lines are
  repeated** in `index.html`, `suggest.html`, `privacy.html` and `WIP_TAG`/`FOOTER_NOTES` in
  `apps/web/src/html.ts`. Change one, change all four.
- **`/privacy` is a static page that must stay free of any email address.** Meta's App
  Review needs a privacy policy URL on a real domain, which is why it exists (SCEC-79), and
  `no-email.test.ts` scans it with every other served file — so the way to be reached is the
  suggestion form, never an address. Unlike `/suggest` it is indexable and is in the
  sitemap. It describes what the code actually does: day-salted IP hashes for the rate
  limit, posters private until approval and stripped of metadata, Turnstile, the Buy Me a
  Coffee image the home page loads from a third party, and the social accounts. Change any
  of those and the page is wrong.
- **Hand-entered events are listings, never rows written into `events`.** Dedup rebuilds
  events from listings each run and closes any event in its window with no listing behind
  it, so a bare event would vanish within two hours. The console (`apps/ingest/src/
  console.ts`) stores a listing from the `manual` source, built by `normalizeEvent` like any
  scraped one, plus the event `buildClusters` makes of it — under the id dedup will keep —
  so it shows at once. A manual listing can merge with a scraped copy of the same event;
  `PRIORITY.manual = 5` makes it the representative. Once merged, the console leaves the
  event to dedup and edits reach the public page at the next run.
- **The `manual` source is disabled but registered.** Disabled keeps it out of the ingest
  loop, enrichment and the public sources list; registered matters because D1 enforces the
  `listings.source_slug` foreign key. That is why `ingestAll` now passes all of `SOURCES`
  to `upsertRegistry`, and why the console registers it again before every write. Manual
  listings are also excluded from the cost judge: "Not listed" in the form is a choice.
- **A manual event's `url` may be empty.** The column is NOT NULL, so no link is `''`. The
  event page then drops "View the listing", iCal drops its "Source:" line, and dedup's URL
  signal cannot match `''` against a scraped listing, which always has one.
- **The console checks the Access JWT itself, on every request.** Access only guards the
  console hostname; the same worker answers on workers.dev. `access.ts` verifies the
  `Cf-Access-Jwt-Assertion` header against the team's published keys (issuer, audience,
  expiry, RS256) and fails closed without the vars. Writes also need `Origin` and
  `Sec-Fetch-Site: same-origin`, because a cross-site form post carries the Access cookie
  and gets a perfectly valid token. The console is never served off `CONSOLE_HOST`, and
  `/run` is never served on it.
- **Posters are private until a suggestion is approved.** Uploads go to the R2 bucket
  `scec-suggestion-posters`, bound as `POSTERS` on both workers: the web worker writes, the
  console reads and shows them behind Access, and the admin email links to the console —
  never to the bucket. The site's `/posters/{key}` serves one only when its suggestion has
  `handled_as = 'event'`, which is set by saving the event form the console pre-fills from
  it (hidden `from` field). So only a dismissal can be undone: un-approving would break the
  poster on a live event page.
- **A suggestion ends one of three ways**: `handled_as` is `event` (saved through the event
  form the console pre-fills), `accepted` (accepted without an event — a website planned as
  a source, say) or `dismissed`. Accepting either way emails the suggester, if they left an
  address, from the **ingest** worker's own `EMAIL` binding (`src/suggestion-mail.ts`); an
  event's email links it. Like the thank-you, it repeats nothing the visitor typed — only
  what the admin made, the event's title and link. `accepted_mail` records the outcome and
  stops a second email: an acceptance or dismissal can be undone and made again, but nobody
  is emailed twice. A failed email never undoes the acceptance.
- **A poster is judged by its bytes and stored without its metadata.** `inspectImage`
  (`apps/web/src/image.ts`) reads the file signature — the name and declared type are the
  sender's word — and accepts only JPEG, PNG, GIF and WebP; SVG can carry script. It runs
  before Turnstile, so a bad file spends no token, and storage happens after it, so a bot's
  bytes never reach R2. `stripMetadata` then drops EXIF/XMP/IPTC/comments/text chunks and
  anything after a JPEG's end marker (motion-photo video): a phone photo of a poster
  carries GPS. It keeps a JPEG's orientation, rewritten as a one-entry EXIF block, and its
  ICC and Adobe segments, or phone photos show sideways and CMYK files in wrong colours.
  A file it cannot walk is refused. The form lists the four types in `accept` rather than
  `image/*`, which is what makes an iPhone convert HEIC to JPEG before upload.
- **Descriptions are rendered as a little markdown, for every event.** `apps/web/src/markdown.ts`:
  bold, italic, `***both***`, links, bare http(s) addresses, `- ` lists, paragraphs and line
  breaks, backslash escapes. Sources already type `**bold**` and `*italic*`; before this they
  showed as literal stars. Escaped first, so the only markup is what the renderer adds, and
  only http(s) is ever linked. No headings, images, raw HTML or `_underscores_` — underscores
  turn up inside scraped names. When it changed, all 1,349 live descriptions were rendered
  both ways and every one of the 86 differences read (39 links, 28 bold, 12 italic): check
  the same way before widening the subset. Plain-text outputs strip it with
  `descriptionText`: the JSON-LD description, and iCal, at the `buildIcal` call in `worker.ts`.
- **Hand edits to scraped events are overrides, never writes to `events`.** Dedup rewrites
  every event in its window each run, so the console's `/find` and `/event/{short code}`
  store only the edited fields in `event_overrides` (JSON keyed by `Event` property), and
  `applyOverrides` (`packages/core/src/overrides.ts`) lays them over the sources' version —
  in `runDedup` before `upsertEventStatements`, in the console's `writeListing`, and on save,
  which rebuilds that one event from its listings with `eventFromCluster` (the function
  `buildClusters` itself uses), so the page shows at once exactly what the next run writes.
  Unedited fields keep following the sources. The six time fields pin together or not at
  all (`TIME_FIELDS`), or a source moving the date would slide under a pinned UTC start.
  `active: false` hides an event its sources keep publishing.
- **An edit is detected against what the form was filled in with, not the database.** The
  edit form posts each field's original beside it as `orig_{name}`. Scraped values do not
  survive a round trip through the form — http posters fail the https rule, links gain a
  trailing slash, whitespace is tidied — so diffing against the stored event would pin those
  fields on the first save and quietly cut them off from their sources. For the same reason
  a form rule an untouched field fails is ignored. The console test "stores nothing when the
  form comes back unchanged" guards this. A solo event added by hand is edited as its
  listing (`/events/{uuid}`), never through an override.
- **An override belongs to an event id, which is sticky — until it isn't.** On platforms whose
  ids encode the date (govStack, Drupal rows, SPACES), a rescheduled event becomes a new
  cluster, and its override stays with the old one. The edit has to be made again.
- **Eventbrite has no documented search any more.** `/v3/events/search/` was removed in 2020.
  The adapter uses `POST /v3/destination/search/`, the endpoint eventbrite.com itself calls,
  with the OAuth token and a bounding box: JSON, not scraping, but unpublished, so it can
  change without notice — the adapter throws rather than return nothing. The documented
  alternatives were measured and rejected as the main feed: "list events by venue" works on
  venues we do not own, but 278 of the 293 venue ids behind 348 county events carried a
  single event (organizers mint a venue per event, one church has four ids), so a curated
  venue list would miss most future events; organizers repeat more (153 for 348 events)
  and are the fallback if the search goes. `page_size` is capped at 50, only
  `dates: 'current_future'` is accepted, and expanding `full_description` is a 500.
- **Ticketmaster is asked by venue, never by radius.** A radius search from Barrie missed
  Sadlon Arena's 33 Colts games entirely. `TICKETMASTER_VENUES` in core holds the 63 venues
  the gazetteer placed in the county (2026-09-15); a venue new to Ticketmaster needs the
  survey repeated. The key is a query parameter, and an `HttpError` message carries its URL
  into `sync_runs`, the CLI and the log, so `fetchTicketmaster` redacts it from every error.
  Only the consumer key is used; the consumer secret is for OAuth and is configured nowhere.
- **Ticketing events are paid unless they say otherwise.** Ticketmaster events never carry a
  usable price, so every one is `isFree: false` → paid, and shows under "Paid only", on
  municipality pages and in "Everything", not in the default free view. Eventbrite's
  `ticket_availability.is_free` is structural and is taken as given. Both platforms put a
  cancellation or reschedule in their data, not the title; the adapters prefix
  `CANCELLED:`/`RESCHEDULED:` so normalization's title rules set the status.
- **An organization's own calendar outranks the town's copy.** `PRIORITY.organization = 8`
  (the Barrie Film Festival): a festival knows its own programme better than a municipal
  repost. `ticketing = 45` sits between tourism and media.
- **A room named after a town will move an event to that town.** Barrie's Downtown branch has
  an Angus Ross Room, and Angus is a hamlet in Essa, so passing the room to the gazetteer put
  those events a township away. The Communico adapter sends the branch and never the room,
  and only an outside venue (`venue_name`) becomes a municipality hint. Any adapter that has
  room or space names should do the same.
- **iCal is a source format, not just an output.** `ical-read.ts` parses a published feed
  (unfolding, escapes, VALUE=DATE, UTC vs floating vs TZID, X- properties) and `ics.ts` maps
  it: LibCal builds its own URLs per calendar (`libcal.ts`), Tockify is a plain `ics` source
  with one URL. UIDs are the per-occurrence identity, DTEND on an all-day event is the
  morning after so it is pulled back to 23:59 the day before, and times arrive as UTC
  instants and are converted to wall time once, here. No feed of ours carries RRULE; one that
  did would need expansion added rather than silently losing its repeats.
- **Tourism Barrie is Sitefinity, read through its OData service** (`sitefinity.ts`,
  `/api/default/events`, paged by `$skip` because `$top` above 100 is a 400). Read the wall
  clock from `EventStartWithOffset` with its `Z` stripped, never `EventStart`: entries saved
  with TimeZoneId "UTC" store the typed wall clock as if it were UTC, so Doors Open Barrie
  would open at 6:00. An all-day end is the midnight after, a 00:00 start on a timed event
  means no time was given. `DisplayTimeOnEventDetails` is off on 98 of 100 and then the site
  shows dates only; the clocks are kept because most are right, but the source does not
  vouch for them and at least one is a placeholder (Pumpkinferno, "13:00"). Most
  listings are season-long spans; anything not yet over is kept. The source is regional
  (Cookstown to Penetanguishene) so it claims no municipality. No event on record has ever
  been recurring; the adapter throws on one rather than keep only the first date.
- **The Orillia Opera House is read through its TIXHUB box office** (`tixhub.ts`), which
  sells more than the Opera House: Mariposa Arts Theatre's main stage, the Leacock Museum,
  the jazz festival. The listing comes from `cdn.tixhub.com/{tenant}/online/index_content.asp`;
  every row's date `datetime` is a stale 2013 placeholder, so the text is read. A run of
  performances is one "Multiple Dates" row, expanded from its own content page's
  performance `<option>`s — one request per run. The performance id is the identity. It is a
  box office, so everything on it is paid.
- **MAT Film Nights is read from prose** (`mat-film-nights.ts`): the season exists only as
  text on Mariposa's Wix page ("Tuner | Wednesday, September 9, 2026 (4pm, 7pm) | …"). It is
  the most fragile source here and throws on a page with no films. Venue, address and
  admission are stated once on the page and live in the source config. A "TBA" film is kept
  as a screening, film to be announced.
- **A chamber of commerce runs on GrowthZone, and only its APPROVED rows are events.**
  `growthzone.ts` reads `/api/events` on the `business.` host — ChamberMaster's own XML,
  one request for the whole calendar, unpublished like Eventbrite's search, so it throws on
  a shape it does not know. Of the Barrie chamber's 149 records, 137 were `PENDING` and
  those were three series the platform generates years ahead: 104 copies of one weekly
  networking night, running to 2028, with no description, location or admission on any of
  them. The 12 `APPROVED` are the curated ones. A series is already expanded, one `EventID`
  per occurrence, so `Recurrence` never needs expanding. `EventID` is the identity; the
  slug carries the date. The `URL` field is the organiser's own site, not the event's page,
  which is `/events/details/{Slug}-{EventID}`. `ContactEmail` is a real person's address
  and is never read. The source claims no municipality: half its approved events are at a
  greenhouse in Springwater, and the Santa Claus Parade is placed only by its title.
- **An admission is what it costs to attend, not to take part.** The Barrie Santa Claus
  Parade's `AdmissionDesc` reads "FLOAT ENTRIES are: $250 Non-Member, commercial
  businesses" — the fee to put a float in it. Watching is free, and taken at face value
  that marks the biggest free event of Barrie's year as paid, which drops it out of the
  view almost everyone uses. `growthzone.ts` returns no cost text for a vendor's or
  entrant's fee, and none for "Free to Chamber Members" either, which reads as free and
  means free for some.
- **Venues surveyed and left out (2026-09-18):** Casino Rama already arrives through
  Ticketmaster (39 upcoming); Five Points Theatre sells through Ticketpro, which sits behind
  Cloudflare's bot challenge, and its shows reach us via the City and Tourism Barrie; Theatre
  by the Bay publishes a handful of events a year on a custom site, already arriving via the
  City. Bandsintown likewise blocks non-browsers.
- **A tribe series that occurs every day for 90 days or more is dropped** (`dropRunawaySeries`).
  Barrie 360 lists Gussapolooza, a festival held August 21-23, as recurring daily from
  September to March: 195 copies. The longest genuine daily run on the site when measured was
  37 days (Penetanguishene's drop-in pickleball). A regional tribe source (no municipality of
  its own) also drops events whose address places nowhere in the county — Barrie 360 reaches
  Fiddle Park in Shelburne — but keeps those with no address, which are usually local.
- **CFB Borden is a place of its own, with level `base`.** It is federal land, has no council
  and no civi-times page, so the list is no longer identical to civi-times' 19; nothing links
  there by place, so nothing breaks. Its events had been filed under Essa. The gazetteer knows
  "CFB Borden" and "Base Borden", never bare "Borden", a surname and a street. The CFMWS page
  (`cfmws.ts`) embeds its whole list as `var loadedData = [...]`; most of it is national
  online webinars, dropped, leaving the base's own events.
- **A place name followed by a street word is the street.** `resolveMunicipality` tries
  longer names first, so "80 Bradford Street, Barrie" went to Bradford West Gwillimbury and
  "Horseshoe Valley Road" to the Oro-Medonte hamlet. `STREET_WORDS` in `municipalities.ts`
  now stops a name matching when "Street", "Rd", "Line" and the like follow it. Measured
  against 4,008 live listings it changed 8 placements, and all 8 were corrections — which
  reached existing listings only once reclassification existed (see above).
- **A feed's LOCATION is free text.** LibCal writes a branch name, Tockify writes a room and
  then the street address; `splitLocation` keeps the first segment as the venue and the whole
  string as the address when a street number follows, because an event page without an
  address is a structured-data error.
- **A library's own opening hours are not an event, and are dropped by title.** Tockify
  and LibCal feeds publish the building's status as entries: Bradford's "CLOSED",
  Clearview's "CLOSED - All Branches" (28 of them), New Tecumseth's "Christmas Closure",
  Clearview's "Christmas Eve - OPEN Special Hours". `NON_EVENT_PATTERNS` in `normalize.ts`
  catches them from the title only, anchored at its start or end, because the words turn
  up in real events — "Museum After Hours", "Medicine Garden Closing and Gathering", a
  parade whose description lists the roads closed for it. Measured on 2,037 live titles
  (2026-09-21): 21 matched, 64 listings from five libraries, no false positives. A notice
  already stored is retired by the next run, since reconciliation marks inactive whatever
  a source stopped returning. Check a new pattern against every live title the same way.
- **An observance is a date, not an event: dropped when its title is one AND it has no
  time.** Collingwood and simcoe.com carry the same list of days — "Remembrance Day",
  "Diwali", "Hispanic Heritage Month", "International Men's Day", four "PA Day"s — each
  with a paragraph about what the day marks and nothing to attend. Neither labels them and
  they share real events' URL path, so the title is the only signal, and it is not enough
  alone: "PA Day: Rollercoaster Science" is a camp and New Tecumseth's "Family Day" an
  afternoon at the community centre. Those have start times; observances never do.
  `OBSERVANCE_PATTERNS` applies only to untimed listings. Description length was tried and
  rejected — observances run 27 to 300 characters, among real events. The bare holiday
  names are only ones seen in the data: an untimed "Canada Day" may be a town's own
  celebration. Measured 2026-09-21: 35 dropped, all observances; 17 same-shaped titles with
  a time kept.
- **Barrie Public Library says every programme is free**, structurally: 848 events, every one
  `registration_cost: "0"` with billing off. That is taken at its word. Its online events are
  dropped, both the 21 typed ONLINE and the few in-person ones held at the "Online branch".
- **A library's events may already be arriving through its township.** Tay and Severn put
  their library programs on the township govStack calendar — 40 of Tay's 75 active listings —
  so those libraries need no source of their own, and adding one would only make dedup work.
  Penetanguishene, Wasaga Beach, Ramara, Tiny and Oro-Medonte have no separate library site
  at all. Check the township's listings before adding a library (SCEC-28 has the survey).
- **Eight municipal calendars refuse requests from outside Canada.** Measured 2026-09-16
  against `calendar.midland.ca`: a Canadian laptop, a home server, ca-central-1 EC2 and
  ca-central-1 Lambda all get 200; us-east-2 EC2 gets 403. Cloudflare runs cron triggers
  wherever it has capacity, so from 2026-09-14 every scheduled run lost Midland, Orillia,
  Orillia Public Library, Oro-Medonte, Ramara, Severn, Springwater and Wasaga Beach, while
  every manual run from Toronto kept them. Placement settings cannot fix it: they "only
  affect the execution of fetch event handlers", never `scheduled`.
- **So a 403 is retried through a Lambda in ca-central-1** (`infra/ca-fetch-proxy`, function
  `scec-ca-fetch-proxy` in AWS account 635886974472). Retrying, rather than always proxying,
  keeps every other request direct and lets a town that lifts its block go back to being
  fetched directly with no change here. Public function URLs are blocked in that account, so
  `http.ts` signs a Lambda Invoke (`sigv4.ts`, Web Crypto, two signed headers) as the IAM
  user `scec-ingest-proxy`, which may do nothing but invoke that one function. The Lambda
  answers `{ status, body, headers }` and the calendar's own refusal is rethrown as if it
  came direct. The host allowlist lives in the Lambda, so widening it is a deploy there:
  `zip -j function.zip infra/ca-fetch-proxy/index.mjs && aws --profile jeremy lambda
  update-function-code --function-name scec-ca-fetch-proxy --region ca-central-1 --zip-file
  fileb://function.zip`.
- **`FETCH_PROXY_FORCE=1` sends every GET through the proxy.** The point of the switch is to
  prove that path from a machine nobody blocks: `FETCH_PROXY_FORCE=1 node
  --experimental-strip-types apps/ingest/src/cli.ts --source midland` fetched the same 102
  listings as the direct run. Never set it on the worker; it would route every source
  through Canada for nothing.
- **Adding a route to a worker turns its workers.dev URL off** unless `workers_dev: true`
  is set. `apps/ingest/wrangler.jsonc` sets it, because `/run` is called on workers.dev.
- **Events found in news articles are staged, never written.** The companion tool
  `JmaJeremy/news-event-scraper` reads local news sites, finds events no calendar ever
  published, and inserts drafts into `staged_events` in **this** database. Nothing it writes
  is an event: the console's `/staged` inbox reviews one, `/new?staged={uuid}` pre-fills the
  ordinary event form from it, and saving writes a `manual` listing and marks the draft
  `handled_as = 'event'` in the same batch — the same shape the suggestions flow has, and
  for the same reason: the draft and the event it became must land together, or the queue
  offers something already on the site.
- **The scraper's schema lives here, in `0009_news_scraper.sql`, and that is deliberate.**
  Its worker binds this database with no `migrations_dir` of its own, exactly as
  `apps/web` does — one database, one migration authority. Apply migrations before deploying
  it. Its three tables (`news_articles`, `staged_events`, `news_runs`) are never touched by
  anything in this repo except the console.
- **Two things can pre-fill the event form, and they get separate parameters.**
  `?from={uuid}` is a suggestion somebody sent through the site; `?staged={uuid}` is a news
  draft. They fill in different fields and carry different warnings — a suggestion is a
  message with a reply owed, a draft is a machine's reading of someone else's journalism
  that wants its quotes checked — so `newPage` branches rather than overloading one.
- **A staged draft's `stage_key` is unique outright, unlike `social_posts`'.** There, a
  partial index was needed so an unapproved draft did not burn its event for good. Here a
  dismissal *should* burn the key: dismissing means somebody looked and said no, and two
  outlets covering one ceremony must not come back as a second thing to review.
- **The gazetteer must never see a news article's prose.** `resolveMunicipality(title, body)`
  over BarrieToday's Battle of Britain story returns `cfb-borden`, not `barrie`: the body
  mentions "Canadian Forces Base Borden… 25 kilometres outside of Barrie", and "Base Borden"
  sorts ahead of "Barrie" in the longest-name-first list. A gazetteer cannot tell a venue
  from an aside. The scraper picks the municipality itself, from an enum of the slugs in
  `municipalities`, and hands this repo a slug rather than text to resolve.
- **The month parameter in URLs is `month=`, not `m=`** — `m` is the municipality filter.
  The civi-times tests used `m` for the month; that is why the ported suite was patched.
