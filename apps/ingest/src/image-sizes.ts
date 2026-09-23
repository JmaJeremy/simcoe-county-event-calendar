import { imageSize, shareablePoster } from '@scec/core'
import { runBatched, type D1Like } from './repository.ts'

/**
 * Measure the posters the site is about to share, so a share card has a size to lay out.
 *
 * A queue, like enrichment and the cost judge, and for the same reason: the work is
 * bounded per run and recorded, so an image is read once and an unread one comes round
 * again. Keyed on the URL, which is what makes it cheap — 1,961 upcoming events carried
 * 694 distinct posters when this was written, and Barrie library's 598 listings share 46
 * between them.
 *
 * Only the first bytes are read. Every format states its size in a header, so a ranged
 * request is enough and a poster's full megabyte never crosses the wire. A server that
 * ignores `Range` sends the whole file, which is why the response is truncated here too.
 */
export interface ImageSizeStats {
  measured: number
  unreadable: number
  remaining: number
}

/** Enough for any header, and for the JPEG frame headers that sit behind a thumbnail. */
const RANGE_BYTES = 65_536

export interface ImageSizeOptions {
  budget?: number
  concurrency?: number
  now?: string
  fetchImpl?: typeof fetch
}

/** The posters no one has read yet, commonest first: a shared poster is worth more. */
async function unmeasured(db: D1Like, budget: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT e.image_url AS url, COUNT(*) AS n
         FROM events e
         LEFT JOIN image_sizes s ON s.url = e.image_url
        WHERE e.active = 1
          AND e.image_url IS NOT NULL AND e.image_url != ''
          AND e.starts_at_utc >= datetime('now', '-1 day')
          AND s.url IS NULL
        GROUP BY e.image_url
        ORDER BY n DESC
        LIMIT ?`,
    )
    .bind(budget)
    .all<{ url: string; n: number }>()
  return (results ?? []).map((r) => r.url)
}

async function measure(url: string, fetchImpl: typeof fetch): Promise<{ width: number; height: number } | null> {
  const res = await fetchImpl(url, {
    headers: { Range: `bytes=0-${RANGE_BYTES - 1}`, Accept: 'image/*' },
    signal: AbortSignal.timeout(10_000),
  })
  // 206 is the ranged answer; 200 means the server ignored Range and is sending it all.
  if (!res.ok && res.status !== 206) return null
  const buffer = await res.arrayBuffer()
  return imageSize(new Uint8Array(buffer.byteLength > RANGE_BYTES ? buffer.slice(0, RANGE_BYTES) : buffer))
}

export async function measureImageSizes(db: D1Like, options: ImageSizeOptions = {}): Promise<ImageSizeStats> {
  const { budget = 60, concurrency = 4, now = new Date().toISOString(), fetchImpl = fetch } = options
  const stats: ImageSizeStats = { measured: 0, unreadable: 0, remaining: 0 }

  // Ask for more than the budget, because the host rule below throws some away: a poster
  // on a govStack calendar can never be a share image, so measuring it is a wasted fetch.
  const candidates = (await unmeasured(db, (budget + 1) * 3)).filter(shareablePoster)
  stats.remaining = Math.max(0, candidates.length - budget)
  const todo = candidates.slice(0, budget)
  if (todo.length === 0) return stats

  const rows: Array<{ url: string; size: { width: number; height: number } | null }> = []
  for (let i = 0; i < todo.length; i += concurrency) {
    const slice = todo.slice(i, i + concurrency)
    const sizes = await Promise.all(
      slice.map(async (url) => {
        try {
          return await measure(url, fetchImpl)
        } catch {
          // A host that refuses us, a timeout, a 404: recorded as unreadable so the pass
          // does not come back to it every two hours.
          return null
        }
      }),
    )
    slice.forEach((url, at) => rows.push({ url, size: sizes[at]! }))
  }

  for (const row of rows) row.size ? stats.measured++ : stats.unreadable++

  await runBatched(
    db,
    rows.map((row) =>
      db
        .prepare('INSERT OR REPLACE INTO image_sizes (url, width, height, checked_at) VALUES (?, ?, ?, ?)')
        .bind(row.url, row.size?.width ?? null, row.size?.height ?? null, now),
    ),
  )
  return stats
}
