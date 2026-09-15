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
```

A full run takes ~90 s and ~620 HTTP requests: 25/25 sources for ~2,300 listings, then up
to 300 event pages read for price and posters, then up to 200 unclear listings sent to the
cost judge, then dedup over ~2,300 pairs into ~2,160 events. The subrequest ceiling is
1,000 per invocation, so the two budgets in `enrich.ts` and `cost.ts` are what keeps the
run inside it — raise either and check the total.

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

**Adapters are per platform, sources are per site.** Six adapters cover 25 sources; adding a
site on a supported platform is a row in `packages/core/src/sources.ts`.

**Listings vs events.** A `Listing` is one source's view of one occurrence, keyed
`(source, platform id)`. An `Event` is a cluster of listings the de-duplicator judged to be
the same thing; its id is the representative listing's id at creation and never changes.

## Deployment

Two Workers on the shared `scec` D1 database (id `2a5bb740-6719-4498-9c0d-4f8eb7b601b9`):

```bash
set -a; . ./.env; set +a          # CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN / INGEST_TOKEN
npx wrangler d1 migrations apply scec --remote --config apps/ingest/wrangler.jsonc
npx wrangler deploy --config apps/ingest/wrangler.jsonc   # cron: 23 past every second hour
npx wrangler deploy --config apps/web/wrangler.jsonc
printf '%s' "$INGEST_TOKEN" | npx wrangler secret put INGEST_TOKEN --config apps/ingest/wrangler.jsonc
printf '%s' "$ANTHROPIC_API_KEY" | npx wrangler secret put ANTHROPIC_API_KEY --config apps/ingest/wrangler.jsonc

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
  It also holds the suggestions inbox. Posters live in the private R2 bucket
  `scec-suggestion-posters`, bound as `POSTERS` on both workers; the web worker's
  `CONSOLE_ORIGIN` var is where the admin email's links point.
- Zone settings on `outinsimcoe.ca` are Cloudflare defaults except **Always Use HTTPS**,
  turned on when the domain was attached — without it the site answered on plain HTTP.
  HSTS is deliberately off: it is a long-lived promise and there is no reason to make it yet.
- `.env` is gitignored, as is `jeremy-atlassian-token.key`. Keep it that way.

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
  "Farmers' Market" at 9:00 are two events. The municipality gate in dedup enforces this.
- **Generic source categories ("Community Events") say nothing.** `classifyCategory`
  ignores them and reads the title.
- **Dedup: a listing with no municipality must never bridge two towns.** News-site copies
  (SPACES) often have `municipalitySlug = null`; `buildClusters` applies edges strongest-first
  and refuses one that would join two different placed municipalities. Listings that start
  on different dates never auto-merge (a theatre run vs one performance) — the judge decides.
  Changing any scoring rule means bumping `RULES_VERSION` so cached rule verdicts recompute.
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
- **The cost judge is a finder, not a decider.** It returns the sentence that states the
  price; `decideCost` then checks that sentence really appears in the listing and runs the
  ordinary cost rules over it. Never let a model's verdict set a cost directly. The bar is
  higher for paid than for free on purpose: a free event wrongly marked paid vanishes from
  the view almost everyone uses.
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
  Something that started on an earlier day and is still running is filed under today with
  an "On now" tag (`listDate`), not under a heading reading "3 days ago". The calendar view
  is untouched; "Past events" still shows everything.
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
- **Never give an element the id `turnstile`.** An id becomes a global of the same name,
  so `window.turnstile` was the widget's own `<div>`: Turnstile warned "already has been
  loaded" and `render` was "not a function", and no widget ever appeared.
- **Headless browsers never get a real Turnstile token** — Cloudflare flags them as bots.
  Test the wiring with Cloudflare's always-pass keys instead (site key
  `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA`). Their
  token comes back with action `test`, so expect our worker to refuse it as
  `action-mismatch`: that refusal is the proof the whole chain ran.
- **The work-in-progress tag and the copyright line are repeated** in `index.html`,
  `suggest.html` and `WIP_TAG`/`COPYRIGHT` in `apps/web/src/html.ts`. Change one, change all three.
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
- **Adding a route to a worker turns its workers.dev URL off** unless `workers_dev: true`
  is set. `apps/ingest/wrangler.jsonc` sets it, because `/run` is called on workers.dev.
- **The month parameter in URLs is `month=`, not `m=`** — `m` is the municipality filter.
  The civi-times tests used `m` for the month; that is why the ported suite was patched.
