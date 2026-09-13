# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A public calendar of community events across Simcoe County, Ontario — the county, its 16
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
npm test                                    # vitest, fixture-based, no network
npm run typecheck
node --experimental-strip-types apps/ingest/src/cli.ts [--source <slug>] [--json]   # dry run
```

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

## Things that will bite you

- **Identity is the platform's id for the occurrence, never a content hash**, and for
  recurring events the id must include the occurrence (Drupal: `nodePath@datetime`, SPACES:
  `dataId@startDate`). See `packages/core/src/identity.ts`.
- **`localStart` is always a naive America/Toronto wall string.** `normalize` converts it
  exactly once. Sources that publish offsets or UTC (Drupal, CitySpark, EventON) must emit
  the local form in the adapter, or times double-convert.
- **The empty-response guard in `reconcile()` is load-bearing.** A source returning zero
  listings is far more likely to be an outage than a calendar with nothing on it.
- **Never merge on title + time alone across different municipalities.** Two townships'
  "Farmers' Market" at 9:00 are two events. The municipality gate in dedup enforces this.
- **Generic source categories ("Community Events") say nothing.** `classifyCategory`
  ignores them and reads the title.
