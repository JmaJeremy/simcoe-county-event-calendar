/**
 * Dedup tuning report over the LOCAL wrangler D1 (apps/ingest/.wrangler/state/v3/d1/...).
 *   node --experimental-strip-types apps/ingest/scripts/dedup-report.ts <path-to-sqlite>
 * Prints rule merges, ambiguous pairs and near misses so thresholds can be judged by eye.
 */
import { DatabaseSync } from 'node:sqlite'
import { candidatePairs, scorePair, sourceBySlug, verdictByRules } from '@scec/core'
import { rowToListing } from '../src/repository.ts'
const db = new DatabaseSync(process.argv[2]!)
const rows = db.prepare('SELECT * FROM listings').all() as any[]
const listings = rows.map((r) => rowToListing(r, sourceBySlug(r.source_slug)?.kind ?? 'media'))
const pairs = candidatePairs(listings)
const scored = pairs.map(([a, b]) => ({ a, b, s: scorePair(a, b), v: verdictByRules(scorePair(a, b)) }))
const fmt = (l: any) => `${l.sourceSlug.padEnd(16)} ${l.localDate} ${l.localTime} ${l.municipalitySlug ?? '-'} | ${l.title.slice(0, 60)} | ${(l.venueName ?? l.address ?? '').slice(0, 30)}`
console.log(`\n=== RULE MERGES (${scored.filter((x) => x.v === 'same').length}) — sample ===`)
for (const x of scored.filter((x) => x.v === 'same').slice(0, 25)) console.log(`${x.s.score.toFixed(2)} t${x.s.title.toFixed(2)} T${x.s.time} p${x.s.place} u${x.s.url}\n   ${fmt(x.a)}\n   ${fmt(x.b)}`)
console.log(`\n=== AMBIGUOUS (${scored.filter((x) => x.v === 'ambiguous').length}) ===`)
for (const x of scored.filter((x) => x.v === 'ambiguous')) console.log(`${x.s.score.toFixed(2)} t${x.s.title.toFixed(2)} T${x.s.time} p${x.s.place}\n   ${fmt(x.a)}\n   ${fmt(x.b)}`)
console.log(`\n=== NEAR-MISS DISTINCT (0.35–0.45) — sample ===`)
for (const x of scored.filter((x) => x.v === 'distinct' && x.s.score > 0.35).slice(0, 15)) console.log(`${x.s.score.toFixed(2)} t${x.s.title.toFixed(2)}\n   ${fmt(x.a)}\n   ${fmt(x.b)}`)
