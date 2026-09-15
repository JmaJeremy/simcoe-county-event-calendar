import { describe, expect, it } from 'vitest'
import { runDedup } from '../src/dedup.ts'

/**
 * The run that would otherwise erase every hand edit: dedup rewrites each event from its
 * listings, so it must lay the console's overrides back on top.
 */

const row = {
  id: 'tay:fair',
  source_slug: 'tay',
  external_id: 'fair',
  municipality_slug: 'tay',
  title: 'Waubaushene Fall Fair',
  description: 'Rides and pie.',
  category: 'community',
  source_categories: '[]',
  starts_at_utc: '2099-10-03T14:00:00.000Z',
  ends_at_utc: null,
  local_date: '2099-10-03',
  local_time: '10:00',
  timezone: 'America/Toronto',
  time_precision: 'exact',
  all_day: 0,
  venue_name: 'Memorial Park',
  address: null,
  cost: 'unknown',
  cost_text: null,
  organizer: null,
  image_url: null,
  url: 'https://tay.ca/fair',
  status: 'scheduled',
  active: 1,
  removed_at: null,
  content_hash: 'h',
  cluster_id: 'tay:fair',
}

function fakeDb(overrides: Array<{ event_id: string; fields: string }>) {
  const written: Array<{ sql: string; values: unknown[] }> = []
  const answer = (sql: string): unknown[] => {
    if (sql.startsWith('SELECT * FROM listings WHERE local_date')) return [row]
    if (sql.startsWith('SELECT id, created_at FROM events')) return [{ id: 'tay:fair', created_at: '2026-09-01T00:00:00.000Z' }]
    if (sql.startsWith('SELECT event_id, fields FROM event_overrides')) return overrides
    return []
  }
  const statement = (sql: string, values: unknown[] = []): any => ({
    sql,
    values,
    bind: (...bound: unknown[]) => statement(sql, bound),
    all: async () => ({ results: answer(sql) }),
    first: async () => answer(sql)[0] ?? null,
    run: async () => void written.push({ sql, values }),
  })
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: any[]) => {
      for (const s of statements) written.push({ sql: s.sql, values: s.values })
      return []
    },
  }
  return { db, events: () => written.filter((w) => w.sql.includes('INSERT INTO events')) }
}

describe('runDedup', () => {
  const window = { from: '2099-01-01', to: '2099-12-31' }

  it('lays hand edits over what the sources say', async () => {
    const { db, events } = fakeDb([{ event_id: 'tay:fair', fields: JSON.stringify({ title: 'Waubaushene Fall Fair (edited)', cost: 'free' }) }])
    await runDedup(db as any, window)
    const [event] = events()
    expect(event!.values).toContain('Waubaushene Fall Fair (edited)')
    expect(event!.values).toContain('free')
    expect(event!.values).not.toContain('Waubaushene Fall Fair')
    // Unedited fields keep following the listing.
    expect(event!.values).toContain('Memorial Park')
  })

  it('writes the sources’ version when nothing was edited', async () => {
    const { db, events } = fakeDb([])
    await runDedup(db as any, window)
    expect(events()[0]!.values).toContain('Waubaushene Fall Fair')
  })
})
