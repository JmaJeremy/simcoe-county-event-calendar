import { describe, expect, it } from 'vitest'
import worker, { type Env } from '../src/worker.ts'
import { parseFilters, selectEventPage } from '../src/query.ts'
import { INGEST_MIGRATIONS, sqliteD1 } from './d1-sqlite.ts'

/**
 * How the home page loads the calendar: in two halves split at one date (`since`, `before`),
 * through a cap that says when it has cut. Against real SQLite, because the split is SQL —
 * and because the bug it replaces was a query that quietly returned the wrong 4,000 rows.
 */
const SPLIT = '2026-10-08'

function calendar() {
  const db = sqliteD1(INGEST_MIGRATIONS)
  const add = (id: string, date: string, endsAtUtc: string | null = null) =>
    db.exec(
      `INSERT INTO events (id, short_code, representative_id, listing_ids, source_slugs, title, category, starts_at_utc, ends_at_utc,
                           local_date, local_time, timezone, url, cost, created_at, updated_at)
       VALUES (?, ?, ?, '[]', '[]', ?, 'community', ?, ?, ?, '09:00', 'America/Toronto', '', 'free', '', '')`,
      id, id, id, id, `${date}T13:00:00.000Z`, endsAtUtc, date,
    )
  const ids = async (query: string) => (await selectEventPage(db, parseFilters(new URL(`https://x/?${query}`)))).events.map((e) => e.id)
  return { db, add, ids }
}

describe('the two halves of the calendar', () => {
  it('keeps a festival that started long ago and is still running in the upcoming half', async () => {
    const c = calendar()
    c.add('over-last-month', '2026-09-10')
    c.add('ended-last-week', '2026-09-20', '2026-10-01T21:00:00.000Z')
    c.add('festival', '2026-09-05', '2026-10-31T21:00:00.000Z')
    c.add('yesterday', SPLIT)
    c.add('next-month', '2026-11-21')
    expect(await c.ids(`since=${SPLIT}`)).toEqual(['festival', 'yesterday', 'next-month'])
    expect(await c.ids(`before=${SPLIT}`)).toEqual(['over-last-month', 'ended-last-week'])
  })

  it('splits every event into exactly one half', async () => {
    const c = calendar()
    let n = 0
    for (const date of ['2026-08-30', '2026-10-07', SPLIT, '2026-10-09', '2027-04-07']) {
      for (const end of [null, `${date}T23:00:00.000Z`, '2026-10-07T23:59:00.000Z', `${SPLIT}T00:00:00.000Z`, '2026-12-01T00:00:00.000Z']) c.add(`e${n++}`, date, end)
    }
    const [upcoming, past, all] = await Promise.all([c.ids(`since=${SPLIT}`), c.ids(`before=${SPLIT}`), c.ids('')])
    expect(upcoming.filter((id) => past.includes(id))).toEqual([])
    expect([...upcoming, ...past].sort()).toEqual([...all].sort())
    expect(all).toHaveLength(n)
  })

  it('ignores a split date that is not a date', async () => {
    const c = calendar()
    c.add('a', '2026-10-09')
    expect(await c.ids("since=2026-13-45'--")).toEqual(['a'])
  })
})

describe('the cap', () => {
  it('says when it has cut a result short, with or without a search', async () => {
    const c = calendar()
    for (let i = 0; i < 5; i++) c.add(`e${i}`, `2026-10-1${i}`)
    const page = (query: string, limit: number) => selectEventPage(c.db, parseFilters(new URL(`https://x/?${query}`)), limit)
    expect(await page('', 5)).toMatchObject({ truncated: false })
    const cut = await page('', 3)
    expect(cut.truncated).toBe(true)
    // The soonest are kept: a cut costs the far future, never tomorrow.
    expect(cut.events.map((e) => e.id)).toEqual(['e0', 'e1', 'e2'])
    expect(await page('q=e', 2)).toMatchObject({ truncated: true })
    expect(await page('q=e3', 2)).toMatchObject({ truncated: false })
  })

  it('reports it on /api/events', async () => {
    const c = calendar()
    c.add('a', '2026-10-09')
    const env = { DB: c.db, ASSETS: { fetch: async () => new Response('') } } as unknown as Env
    const body = await (await worker.fetch(new Request('https://outinsimcoe.ca/api/events?since=2026-10-08'), env)).json()
    expect(body).toMatchObject({ count: 1, truncated: false })
  })
})
