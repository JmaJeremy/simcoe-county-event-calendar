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
  contentHash: 'aaaa',
  ...over,
})

const stored = (over: Partial<StoredListing> = {}): StoredListing => ({
  id: 'ramara:2026-09-22-0930-Ride-Ramara',
  externalId: '2026-09-22-0930-Ride-Ramara',
  contentHash: 'aaaa',
  startsAtUtc: '2026-09-22T13:00:00.000Z',
  status: 'scheduled',
  ...over,
})

describe('reconcile', () => {
  it('inserts events it has not seen before', () => {
    const plan = reconcile([event()], [])
    expect(plan.ok).toBe(true)
    expect(plan.inserts).toHaveLength(1)
    expect(plan.cancellations).toEqual([])
  })

  it('is a no-op when nothing changed', () => {
    const plan = reconcile([event()], [stored()])
    expect(plan.unchanged).toBe(1)
    expect(plan.inserts).toEqual([])
    expect(plan.updates).toEqual([])
  })

  it('marks a moved meeting as rescheduled', () => {
    const moved = event({ startsAtUtc: '2026-09-29T13:00:00.000Z', contentHash: 'bbbb' })
    const plan = reconcile([moved], [stored()])
    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0]!.changes).toContain('startsAtUtc')
    expect(plan.updates[0]!.event.status).toBe('rescheduled')
  })

  it('updates an edited meeting without changing its status', () => {
    // A new agenda link or a venue change is not a reschedule.
    const edited = event({ venueName: 'Committee Room 2', contentHash: 'cccc' })
    const plan = reconcile([edited], [stored()])
    expect(plan.updates[0]!.changes).toEqual(['content'])
    expect(plan.updates[0]!.event.status).toBe('scheduled')
  })

  it('cancels a meeting that has vanished from the source', () => {
    const plan = reconcile([], [stored({ externalId: 'other', id: 'x' }), stored()])
    // Guard only trips on a *fully* empty response; here one of two vanished.
    expect(plan.ok).toBe(false)
  })

  it('cancels the vanished meeting when others are still listed', () => {
    const survivor = event({ id: 'simcoe-county:2', externalId: '2' })
    const plan = reconcile([survivor], [stored({ id: 'simcoe-county:2', externalId: '2' }), stored()])
    expect(plan.ok).toBe(true)
    expect(plan.cancellations).toEqual(['ramara:2026-09-22-0930-Ride-Ramara'])
  })

  it('never deletes: a cancellation is an update, not a removal', () => {
    const survivor = event({ id: 'simcoe-county:2', externalId: '2' })
    const plan = reconcile([survivor], [stored({ id: 'simcoe-county:2', externalId: '2' }), stored()])
    expect(plan).not.toHaveProperty('deletes')
    expect(plan.cancellations).toHaveLength(1)
  })

  it('does not re-cancel something already cancelled', () => {
    const survivor = event({ id: 'simcoe-county:2', externalId: '2' })
    const plan = reconcile(
      [survivor],
      [stored({ id: 'simcoe-county:2', externalId: '2' }), stored({ status: 'cancelled' })],
    )
    expect(plan.cancellations).toEqual([])
  })

  it('reinstates a cancelled meeting that reappears', () => {
    const plan = reconcile([event()], [stored({ status: 'cancelled' })])
    expect(plan.updates[0]!.changes).toContain('reinstated')
    expect(plan.updates[0]!.event.status).toBe('scheduled')
  })

  it('keeps a cancellation the source states outright, even if the time also moved', () => {
    // In-band 'CANCELLED' must win over the reschedule we would otherwise infer.
    const cancelledAndMoved = event({
      status: 'cancelled',
      startsAtUtc: '2026-09-29T13:00:00.000Z',
      contentHash: 'dddd',
    })
    const plan = reconcile([cancelledAndMoved], [stored()])
    expect(plan.updates[0]!.event.status).toBe('cancelled')
  })

  /**
   * The guard that matters most. An empty response is far more likely to be a fetch
   * failure or a platform migration than a municipality cancelling everything on its
   * calendar, and acting on it would wipe out a whole council's schedule.
   */
  describe('empty-response guard', () => {
    it('refuses to reconcile when a source with history returns nothing', () => {
      const plan = reconcile([], [stored(), stored({ id: 'b', externalId: 'b' })])
      expect(plan.ok).toBe(false)
      expect(plan.abortReason).toMatch(/refusing to cancel/i)
    })

    it('writes absolutely nothing when it aborts', () => {
      const plan = reconcile([], [stored()])
      expect(plan.inserts).toEqual([])
      expect(plan.updates).toEqual([])
      expect(plan.cancellations).toEqual([])
    })

    it('accepts an empty response from a source that had no events either', () => {
      // A brand-new source, or one genuinely between sessions, is not an error.
      const plan = reconcile([], [])
      expect(plan.ok).toBe(true)
    })
  })
})

describe('content hashing', () => {
  it('treats a newly published start time as a change', () => {
    // A municipality filling in a time that was blank must reach anyone subscribed,
    // so time precision has to participate in the content hash.
    const base = {
      externalId: '1',
      title: 'Council',
      localStart: '2026-09-16T00:00',
      categories: [], url: 'https://x', raw: {},
    }
    const withoutTime = contentHash({ ...base, timePrecision: 'date-only' })
    const withTime = contentHash({ ...base, localStart: '2026-09-16T09:30', timePrecision: 'exact' })
    expect(withoutTime).not.toBe(withTime)
  })
})
