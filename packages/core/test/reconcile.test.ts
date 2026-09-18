import { describe, expect, it } from 'vitest'
import { contentHash } from '../src/identity.ts'
import { reconcile, type StoredListing } from '../src/reconcile.ts'
import type { Listing } from '../src/types.ts'

const event = (over: Partial<Listing> = {}): Listing => ({
  id: 'ramara:2026-09-22-0930-Ride-Ramara',
  sourceSlug: 'ramara',
  sourceKind: 'municipal',
  externalId: '2026-09-22-0930-Ride-Ramara',
  municipalitySlug: 'ramara',
  title: 'Ride Ramara',
  description: null,
  category: 'outdoors',
  sourceCategories: ['Community Events'],
  startsAtUtc: '2026-09-22T13:00:00.000Z',
  endsAtUtc: null,
  localDate: '2026-09-22',
  localTime: '09:00',
  timezone: 'America/Toronto',
  timePrecision: 'exact',
  allDay: false,
  venueName: 'Ramara Centre',
  address: null,
  cost: 'unknown',
  costText: null,
  organizer: null,
  imageUrl: null,
  url: 'https://calendar.ramara.ca/default/Detail/2026-09-22-0930-Ride-Ramara',
  status: 'scheduled',
  active: true,
  contentHash: 'aaaa',
  ...over,
})

const stored = (over: Partial<StoredListing> = {}): StoredListing => ({
  id: 'ramara:2026-09-22-0930-Ride-Ramara',
  externalId: '2026-09-22-0930-Ride-Ramara',
  contentHash: 'aaaa',
  startsAtUtc: '2026-09-22T13:00:00.000Z',
  status: 'scheduled',
  active: true,
  ...over,
})

describe('reconcile', () => {
  it('inserts listings it has not seen before', () => {
    const plan = reconcile([event()], [])
    expect(plan.ok).toBe(true)
    expect(plan.inserts).toHaveLength(1)
    expect(plan.updates).toHaveLength(0)
    expect(plan.removals).toHaveLength(0)
  })

  it('reports an unchanged listing as unchanged', () => {
    const plan = reconcile([event()], [stored()])
    expect(plan.unchanged).toBe(1)
    expect(plan.updates).toHaveLength(0)
  })

  it('updates on a content change without touching status', () => {
    const plan = reconcile([event({ contentHash: 'bbbb' })], [stored()])
    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0]!.changes).toEqual(['content'])
    expect(plan.updates[0]!.event.status).toBe('scheduled')
  })

  it('marks a moved start time as rescheduled on a platform with stable ids', () => {
    const plan = reconcile([event({ startsAtUtc: '2026-09-22T15:00:00.000Z', contentHash: 'bbbb' })], [stored()])
    expect(plan.updates[0]!.changes).toEqual(['startsAtUtc', 'content'])
    expect(plan.updates[0]!.event.status).toBe('rescheduled')
  })

  it('keeps a stated cancellation even when the time also moved', () => {
    const plan = reconcile([event({ status: 'cancelled', startsAtUtc: '2026-09-22T15:00:00.000Z', contentHash: 'cc' })], [stored()])
    expect(plan.updates[0]!.event.status).toBe('cancelled')
  })

  it('records a status change the source states in text', () => {
    const plan = reconcile([event({ status: 'cancelled' })], [stored()])
    expect(plan.updates[0]!.changes).toEqual(['status'])
    expect(plan.updates[0]!.event.status).toBe('cancelled')
  })

  it('removes — never cancels — a listing that stopped appearing while others remain', () => {
    const other = event({ id: 'ramara:other', externalId: 'other' })
    const plan = reconcile([other], [stored(), stored({ id: 'ramara:other', externalId: 'other' })])
    expect(plan.removals).toEqual(['ramara:2026-09-22-0930-Ride-Ramara'])
    expect(plan.updates).toHaveLength(0)
  })

  it('does not re-remove a listing that is already inactive', () => {
    const plan = reconcile([event({ id: 'x', externalId: 'x' })], [stored({ active: false })])
    expect(plan.removals).toHaveLength(0)
  })

  it('reactivates a listing that reappears', () => {
    const plan = reconcile([event()], [stored({ active: false })])
    expect(plan.updates[0]!.changes).toEqual(['reactivated'])
    expect(plan.updates[0]!.event.active).toBe(true)
  })

  it('refuses to write anything when a source returns nothing but had live listings', () => {
    const plan = reconcile([], [stored()])
    expect(plan.ok).toBe(false)
    expect(plan.abortReason).toMatch(/refusing to remove/)
    expect(plan.removals).toHaveLength(0)
  })

  it('accepts an empty response when nothing live is on record', () => {
    expect(reconcile([], []).ok).toBe(true)
    expect(reconcile([], [stored({ active: false })]).ok).toBe(true)
  })
})

describe('contentHash', () => {
  it('changes when a source fills in a previously unpublished time', () => {
    const base = { externalId: '1', title: 'Fair', localStart: '2026-09-16T00:00', categories: [], url: 'https://x', raw: {} }
    const withoutTime = contentHash({ ...base, timePrecision: 'date-only' })
    const withTime = contentHash({ ...base, localStart: '2026-09-16T09:30', timePrecision: 'exact' })
    expect(withoutTime).not.toBe(withTime)
  })

  it('ignores the raw payload', () => {
    const base = { externalId: '1', title: 'Fair', localStart: '2026-09-16T10:00', categories: [], url: 'https://x' }
    expect(contentHash({ ...base, raw: { views: 1 } })).toBe(contentHash({ ...base, raw: { views: 2 } }))
  })
})

describe('reclassification', () => {
  it('reports a listing whose rules, not its text, changed — and nothing else about it', () => {
    // Same content hash, same time: the source did not touch it. The category rule did.
    const plan = reconcile([event({ category: 'sports' })], [stored({ category: 'outdoors', municipalitySlug: 'ramara' })])
    expect(plan.updates).toHaveLength(0)
    expect(plan.unchanged).toBe(0)
    expect(plan.reclassified).toEqual([{ id: 'ramara:2026-09-22-0930-Ride-Ramara', category: 'sports', municipalitySlug: 'ramara' }])
  })

  it('reclassifies a changed placement the same way', () => {
    const plan = reconcile([event({ municipalitySlug: 'severn' })], [stored({ category: 'outdoors', municipalitySlug: 'ramara' })])
    expect(plan.reclassified).toEqual([{ id: 'ramara:2026-09-22-0930-Ride-Ramara', category: 'outdoors', municipalitySlug: 'severn' }])
  })

  it('leaves a listing alone when the derived fields agree', () => {
    const plan = reconcile([event()], [stored({ category: 'outdoors', municipalitySlug: 'ramara' })])
    expect(plan.reclassified).toHaveLength(0)
    expect(plan.unchanged).toBe(1)
  })

  it('does not reclassify when the caller does not track derived fields', () => {
    const plan = reconcile([event({ category: 'sports' })], [stored()])
    expect(plan.reclassified).toHaveLength(0)
    expect(plan.unchanged).toBe(1)
  })

  it('lets a real content change take the full update path instead', () => {
    const plan = reconcile([event({ category: 'sports', contentHash: 'bbbb' })], [stored({ category: 'outdoors', municipalitySlug: 'ramara' })])
    expect(plan.updates).toHaveLength(1)
    expect(plan.reclassified).toHaveLength(0)
  })
})
