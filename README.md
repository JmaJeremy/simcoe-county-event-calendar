# Out in Simcoe

A public calendar of community events across Simcoe County, Ontario — the county, its 16
member municipalities, and the cities of Barrie and Orillia — gathered from municipal, county,
library and local-media calendars and **de-duplicated across sources**, so the same fall fair
listed by the township, the county and the local news site shows up once.

Live: **https://outinsimcoe.ca** (`scec-web.thejeremy-net.workers.dev` still answers as a fallback)

- List and month-calendar views, filtered by municipality, category and cost, including a
  "Not specified" option for the events no town could be resolved for
- Free events by default; paid ones are kept and labelled, one toggle away
- Council and committee meetings are hidden by default — they live on [Civi-Times](https://civi-times.ca)
- Every event has a short shareable page (`/e/{code}`) that says where it was listed
- Subscribable iCal feeds with the same filters (`/calendar.ics?m=barrie&cost=free`)

## How it works

25 sources on 6 platforms are fetched every two hours by a Cloudflare Worker, normalized into
**listings** (one source's view of one occurrence), reconciled against what was seen before,
and then clustered into **events**: candidate pairs are gated by date and municipality,
scored on title, time, place and shared links, and the ambiguous middle is judged by Claude
(Haiku 4.5) with every verdict cached. See [CLAUDE.md](CLAUDE.md) for the architecture and
the things that bite, and [docs/known-issues.md](docs/known-issues.md) for measured
limitations.

| Platform | Sources |
|---|---|
| Granicus govStack Events | Orillia, Midland, Bradford West Gwillimbury, Springwater, Oro-Medonte, Severn, Tay, Ramara, Penetanguishene, Essa, Wasaga Beach, Orillia Public Library |
| Drupal (FullCalendar / rendered rows) | Barrie, Innisfil, Collingwood, Tiny, Clearview |
| WordPress EventON | County of Simcoe, Adjala-Tosorontio |
| WordPress The Events Calendar | New Tecumseth |
| SPACES (Village Media) | BarrieToday, OrilliaMatters, MidlandToday, CollingwoodToday |
| CitySpark (Metroland) | Simcoe.com |

## Development

```bash
npm install
npm test                                                   # 191 tests, fixture-based; the UI suite uses your Chrome
npm run typecheck
node --experimental-strip-types apps/ingest/src/cli.ts     # dry run against the live sites, writes nothing
node --experimental-strip-types apps/ingest/src/cli.ts --source ramara --json
```

Run the whole pipeline locally against a local D1:

```bash
npx wrangler d1 migrations apply scec --local --config apps/ingest/wrangler.jsonc
npx wrangler dev --config apps/ingest/wrangler.jsonc --port 8787 --var INGEST_TOKEN:dev
curl -X POST 'http://localhost:8787/run?token=dev'         # ingest + dedup into the local D1
npx wrangler dev --config apps/web/wrangler.jsonc --port 8788 --persist-to apps/ingest/.wrangler/state
```

## Deployment

See the Deployment section of [CLAUDE.md](CLAUDE.md). Work is tracked in Jira project SCEC.

## Licence

GPL-3.0, like Civi-Times.
