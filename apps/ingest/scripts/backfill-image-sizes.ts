/**
 * Measure every poster already on the site, once.
 *
 * The ingest pass handles posters as they arrive, a few a run. This is the one-time
 * catch-up for the ones already there, and it runs HERE rather than in the worker: a
 * laptop has no subrequest ceiling, no CPU limit and no two-hour cron to fit inside, so
 * the whole backlog goes in one pass instead of a fortnight of runs.
 *
 *   node --experimental-strip-types apps/ingest/scripts/backfill-image-sizes.ts [--local] [--dry-run]
 *
 * Needs `.env` sourced for the Cloudflare credentials, and the migration applied — which
 * the deploy does. Re-running is safe: it only asks for URLs `image_sizes` has no row for.
 */
import { execFileSync } from 'node:child_process'
import { imageSize } from '../../../packages/core/src/image-size.ts'

const REMOTE = process.argv.includes('--local') ? '--local' : '--remote'
const DRY = process.argv.includes('--dry-run')
const CONFIG = 'apps/ingest/wrangler.jsonc'
const RANGE = 65_536
const CONCURRENCY = 8

const d1 = (sql: string): Record<string, unknown>[] => {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'scec', REMOTE, '--config', CONFIG, '--json', '--command', sql],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  )
  return JSON.parse(out)[0]?.results ?? []
}

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`

async function measure(url: string): Promise<{ width: number; height: number } | null> {
  try {
    const res = await fetch(url, { headers: { Range: `bytes=0-${RANGE - 1}`, Accept: 'image/*' }, signal: AbortSignal.timeout(15_000) })
    if (!res.ok && res.status !== 206) return null
    const buffer = await res.arrayBuffer()
    return imageSize(new Uint8Array(buffer.byteLength > RANGE ? buffer.slice(0, RANGE) : buffer))
  } catch {
    return null
  }
}

const urls = d1(`
  SELECT e.image_url AS url, COUNT(*) AS n
    FROM events e LEFT JOIN image_sizes s ON s.url = e.image_url
   WHERE e.active = 1 AND e.image_url IS NOT NULL AND e.image_url != '' AND s.url IS NULL
   GROUP BY e.image_url ORDER BY n DESC
`).map((r) => String(r.url))

console.log(`${urls.length} posters with no size on record.`)
if (DRY || urls.length === 0) process.exit(0)

const measured: Array<[string, { width: number; height: number } | null]> = []
for (let i = 0; i < urls.length; i += CONCURRENCY) {
  const slice = urls.slice(i, i + CONCURRENCY)
  const sizes = await Promise.all(slice.map(measure))
  slice.forEach((url, at) => measured.push([url, sizes[at]!]))
  process.stdout.write(`\r  read ${measured.length}/${urls.length}`)
}
process.stdout.write('\n')

const now = new Date().toISOString()
// One statement per chunk: 694 separate round trips to D1 would take longer than the
// fetching did.
for (let i = 0; i < measured.length; i += 50) {
  const values = measured
    .slice(i, i + 50)
    .map(([url, size]) => `(${quote(url)}, ${size?.width ?? 'NULL'}, ${size?.height ?? 'NULL'}, ${quote(now)})`)
    .join(', ')
  d1(`INSERT OR REPLACE INTO image_sizes (url, width, height, checked_at) VALUES ${values}`)
  process.stdout.write(`\r  wrote ${Math.min(i + 50, measured.length)}/${measured.length}`)
}

const ok = measured.filter(([, size]) => size).length
console.log(`\nMeasured ${ok}; ${measured.length - ok} could not be read and are recorded as unknown.`)
