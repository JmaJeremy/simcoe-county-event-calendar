import { describe, expect, it } from 'vitest'
import { merge } from '../src/enrich.ts'
import type { EnrichmentCandidate } from '../src/repository.ts'

const listing = (over: Partial<EnrichmentCandidate> = {}): EnrichmentCandidate => ({
  id: 'orillia:2026-09-17-1930-Million-Dollar-Quartet',
  sourceSlug: 'orillia',
  url: 'https://calendar.orillia.ca/default/Detail/2026-09-17-1930-Million-Dollar-Quartet',
  title: 'Million Dollar Quartet',
  description: 'On December 4, 1956, Johnny Cash, Jerry Lee Lewis, Carl Perkins and Elvis Pre',
  cost: 'unknown',
  costText: null,
  imageUrl: null,
  contentHash: 'hash-1',
  ...over,
})

/**
 * The rule the whole pass turns on: a detail page may add, but never erase. A page that
 * is down, changed or simply thin must leave the listing no worse than the list row.
 */
describe('merging a detail page into a listing', () => {
  it('takes the price out of the full description the list row truncated', () => {
    const merged = merge(listing(), {
      description: 'Relive the era with the smash-hit sensation.\n\nAdults: $50.00 | Seniors: $45.00',
      imageUrl: 'https://calendar.orillia.ca/default/Detail/x/poster.jpg',
    })
    expect(merged.cost).toBe('paid')
    expect(merged.costText).toContain('$50.00')
    expect(merged.imageUrl).toContain('poster.jpg')
  })

  it('keeps what the listing had when the page says nothing', () => {
    const before = listing({ cost: 'free', costText: 'Free', imageUrl: 'https://x.invalid/a.jpg' })
    const merged = merge(before, {})
    expect(merged).toMatchObject({
      cost: 'free',
      costText: 'Free',
      imageUrl: 'https://x.invalid/a.jpg',
      description: before.description,
    })
  })

  it('does not overturn a stated cost on a page that merely fails to mention money', () => {
    const merged = merge(listing({ cost: 'free', costText: 'Free admission' }), {
      description: 'Doors open at seven. Bring a friend.',
    })
    expect(merged.cost).toBe('free')
  })

  it('prefers the source\'s own words to a phrase we extracted', () => {
    const merged = merge(listing(), {
      costText: '$12 in advance, $15 at the door',
      description: 'Tickets $12.',
    })
    expect(merged.costText).toBe('$12 in advance, $15 at the door')
  })

  it('caps a runaway description', () => {
    const merged = merge(listing(), { description: 'x'.repeat(9000) })
    expect(merged.description).toHaveLength(4000)
  })
})

describe('re-reading a page that was read before', () => {
  it('replaces a phrase an earlier reading found with the better one', () => {
    const before = listing({ cost: 'paid', costText: 'www.theatricalrights.com Adults: $50.00 | Seniors' })
    const merged = merge(before, { description: 'Tweed & Company presents.\n\nAdults: $50.00 | Seniors: $45.00' })
    expect(merged.costText).toBe('Adults: $50.00 | Seniors: $45.00')
  })

  it('still defers to a field the source labelled Cost', () => {
    const merged = merge(listing({ cost: 'paid', costText: 'Adults: $50.00' }), {
      costText: '$20 at the door',
      description: 'Adults: $50.00',
    })
    expect(merged.costText).toBe('$20 at the door')
  })
})
