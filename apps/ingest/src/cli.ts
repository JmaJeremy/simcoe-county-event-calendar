/**
 * Dry-run ingestion.
 *
 *   node --experimental-strip-types apps/ingest/src/cli.ts [--source <slug>] [--platform <p>] [--json]
 *
 * Runs the real adapters against the real sites and prints what *would* be written,
 * touching no database.
 */
import { enabledSources, sourceBySlug, type Source } from '@scec/core'
import { defaultWindow, syncSource } from './pipeline.ts'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const has = (name: string): boolean => args.includes(name)

const slug = flag('--source')
const platform = flag('--platform')
const asJson = has('--json')

let sources: Source[] = enabledSources()
if (slug) {
  const found = sourceBySlug(slug)
  if (!found) {
    console.error(`Unknown source "${slug}". Known: ${enabledSources().map((s) => s.slug).join(', ')}`)
    process.exit(1)
  }
  sources = [found]
} else if (platform) {
  sources = sources.filter((s) => s.platform === platform)
}

const window = defaultWindow()
console.error(`Window ${window.from} → ${window.to}, ${sources.length} source(s)\n`)

// Sequential on purpose: these are small municipal servers, and a dry run is never urgent.
const results = []
for (const source of sources) {
  const result = await syncSource(source, window)
  results.push(result)
  if (asJson) continue

  const status = result.ok ? 'ok  ' : 'FAIL'
  const timing = `${String(result.durationMs).padStart(5)}ms`
  const costs = { free: 0, paid: 0, unknown: 0 }
  for (const l of result.listings) costs[l.cost]++
  console.log(
    `${status} ${source.slug.padEnd(26)} ${source.platform.padEnd(13)} ` +
      `${String(result.listings.length).padStart(4)} listings  ${timing} ${String(result.requests).padStart(3)} req` +
      `  free ${costs.free} / paid ${costs.paid} / ? ${costs.unknown}` +
      (result.skipped.length ? `  (${result.skipped.length} skipped)` : ''),
  )
  if (result.error) console.log(`     ↳ ${result.error}`)
  const reasons = new Map<string, number>()
  for (const s of result.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1)
  for (const [reason, n] of reasons) console.log(`     skipped ${n}: ${reason}`)
}

if (asJson) {
  console.log(JSON.stringify(results.flatMap((r) => r.listings), null, 2))
} else {
  const all = results.flatMap((r) => r.listings)
  const failed = results.filter((r) => !r.ok)
  const requests = results.reduce((n, r) => n + r.requests, 0)
  console.log(`\n${all.length} listings from ${results.length - failed.length}/${results.length} sources, ${requests} HTTP requests`)

  const byCategory = new Map<string, number>()
  for (const l of all) byCategory.set(l.category, (byCategory.get(l.category) ?? 0) + 1)
  console.log('by category:', [...byCategory].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(', '))
  const unplaced = all.filter((l) => !l.municipalitySlug)
  if (unplaced.length) console.log(`${unplaced.length} listings without a municipality`)

  const upcoming = all
    .filter((e) => e.startsAtUtc >= new Date().toISOString())
    .sort((a, b) => a.startsAtUtc.localeCompare(b.startsAtUtc))
    .slice(0, 10)
  if (upcoming.length) {
    console.log('\nNext up:')
    for (const e of upcoming) {
      const when = e.timePrecision === 'date-only' ? `${e.localDate} (all day)` : `${e.localDate} ${e.localTime}`
      console.log(`  ${when.padEnd(20)} ${(e.municipalitySlug ?? '?').padEnd(26)} ${e.cost.padEnd(7)} ${e.title}`)
    }
  }
  if (failed.length) process.exitCode = 1
}
