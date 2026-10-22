import { describe, expect, it } from 'vitest'
import { MUNICIPALITIES, SOURCES, reconcile, type Listing } from '@scec/core'
import { enrichListingStatements, loadExisting, removeListingStatements, reviveListingStatements, upsertListingStatements, upsertRegistry } from '../src/repository.ts'
import { INGEST_MIGRATIONS, sqliteD1 } from '../../web/test/d1-sqlite.ts'

const listing: Listing = {
  id: 'tay:1', sourceSlug: 'tay', sourceKind: 'municipal', externalId: '1', municipalitySlug: 'tay',
  title: 'Craft Fair', description: 'Short.', category: 'community', sourceCategories: [],
  startsAtUtc: '2026-11-07T15:00:00.000Z', endsAtUtc: null, localDate: '2026-11-07', localTime: '10:00',
  timezone: 'America/Toronto', timePrecision: 'exact', allDay: false, venueName: null, address: null,
  cost: 'unknown', costText: null, organizer: null, imageUrl: null, url: 'https://tay.example/1',
  status: 'scheduled', active: true, contentHash: 'h1',
} as Listing

describe('a listing back from a missed run', () => {
  it('keeps what enrichment added, because its text has not changed', async () => {
    const sqlite = sqliteD1(INGEST_MIGRATIONS)
    const db = { ...sqlite, batch: async (all: Array<{ run(): Promise<unknown> }>) => { for (const s of all) await s.run() } }
    await upsertRegistry(db as never, MUNICIPALITIES, SOURCES)
    const t = '2026-10-22T00:00:00.000Z'
    for (const s of upsertListingStatements(db as never, [listing], t)) await s.run()
    for (const s of enrichListingStatements(db as never, [{ id: 'tay:1', description: 'The full text.', cost: 'paid', costText: '$5', imageUrl: 'https://tay.example/p.jpg' }], t)) await s.run()
    for (const s of removeListingStatements(db as never, ['tay:1'], t)) await s.run()

    const existing = await loadExisting(db as never, 'tay', '2026-10-01', '2026-12-31')
    const plan = reconcile([listing], existing)
    expect(plan.ok && plan.updates.map((u) => u.changes)).toEqual([['reactivated']])
    for (const s of reviveListingStatements(db as never, plan.ok ? plan.updates.map((u) => u.event) : [], t)) await s.run()

    expect(db.rows('SELECT active, description, cost_text, image_url FROM listings')).toEqual([
      { active: 1, description: 'The full text.', cost_text: '$5', image_url: 'https://tay.example/p.jpg' },
    ])
  })
})
