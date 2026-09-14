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

A full run takes ~60 s and ~320 HTTP requests: 25/25 sources, ~2,300 listings, ~2,190
events, ~2,400 candidate pairs, ~160 rule merges, ~50 ambiguous pairs for the judge.

## Architecture

```
packages/core/       types, municipalities + gazetteer, sources registry, time, identity,
                     title/civic-meeting rules, normalize (cost, category), reconcile, dedup, ical
packages/adapters/   one module per PLATFORM + shared http; test/fixtures are captured responses
apps/ingest/         pipeline, D1 repository, dedup runner, cron worker, dry-run CLI, migrations
apps/web/            API + iCal + event pages worker, static front end
```

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
- Zone settings on `outinsimcoe.ca` are Cloudflare defaults except **Always Use HTTPS**,
  turned on when the domain was attached — without it the site answered on plain HTTP.
  HSTS is deliberately off: it is a long-lived promise and there is no reason to make it yet.
- `.env` is gitignored, as is `jeremy-atlassian-token.key`. Keep it that way.

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
- **The theme is applied by an inline script in the head**, in `index.html` and in the
  event page, before the stylesheet. Without it every load flashes white for a reader who
  chose dark. `app.js` sets it too, but that is too late to matter. A browser test blocks
  `app.js` on reload to prove the head script is doing the work.
- **A typed date range replaces the "upcoming only" default** rather than narrowing it —
  see `inDateScope`. Someone who asks for last week means last week, whatever the "Past
  events" box says. `from`/`to` also ride along to the iCal feed.
- **The iCal UID domain is not the site's domain**, and was left alone when the site was
  named. A UID is an identity, not an address: changing it makes every subscribed calendar
  delete and re-add every event. See the comment in `packages/core/src/ical.ts`.
- **The mark exists in three copies**: inline in `public/index.html`, as `MARK` in
  `apps/web/src/worker.ts` (both in CSS variables) and in `scripts/brand.ts` (hardcoded
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
- **The month parameter in URLs is `month=`, not `m=`** — `m` is the municipality filter.
  The civi-times tests used `m` for the month; that is why the ported suite was patched.
