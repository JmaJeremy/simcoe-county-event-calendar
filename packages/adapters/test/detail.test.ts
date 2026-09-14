import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assessCost } from '@scec/core'
import { parseGovstackDetail } from '../src/govstack.ts'
import { parseDrupalDetail } from '../src/drupal.ts'

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

/**
 * These pages are the reason the pass exists: both platforms publish a summary in their
 * list view and keep the price, the poster and the rest of the words on the event's own
 * page. Each fixture is a real page, captured with its scripts and styles stripped.
 */
describe('govStack detail pages', () => {
  const orillia = () => parseGovstackDetail(fixture('govstack-orillia-detail.html'), 'calendar.orillia.ca')
  const essa = () => parseGovstackDetail(fixture('govstack-essa-detail.html'), 'calendar.essatownship.on.ca')

  it('reads the untruncated description, price and all', () => {
    const detail = orillia()
    expect(detail.description).toContain('Adults: $50.00')
    expect(detail.description).toContain('Seniors: $45.00')
    // The list row stops mid-sentence; this is the whole thing.
    expect(detail.description!.length).toBeGreaterThan(1000)
  })

  it('turns that page into a paid verdict, which the list row could not', () => {
    const verdict = assessCost({ title: 'Million Dollar Quartet', description: orillia().description })
    expect(verdict.cost).toBe('paid')
    expect(verdict.confidence).toBe('high')
    expect(verdict.evidence).toContain('$50.00')
  })

  it('finds the poster and resolves it against the calendar host', () => {
    expect(orillia().imageUrl).toBe(
      'https://calendar.orillia.ca/default/Detail/2026-09-17-1930-Million-Dollar-Quartet/3e78524e-cedd-4485-962f-b48f00fad8c8',
    )
  })

  it('stops at the "See more" toggle, so the facility price list is not the event price', () => {
    // This page carries the arena's whole drop-in rate card below the description. Reading
    // past the toggle would put "$5.00" on a free seniors' walking group.
    const detail = essa()
    expect(detail.description).toContain('This is a free program')
    expect(detail.description).not.toContain('$')
    expect(assessCost({ description: detail.description })).toMatchObject({ cost: 'free', confidence: 'high' })
  })

  it('returns nothing at all rather than guessing when the container is missing', () => {
    expect(parseGovstackDetail('<html><body>Down for maintenance</body></html>', 'calendar.orillia.ca')).toEqual({})
  })
})

describe('Drupal detail pages', () => {
  const barrie = () => parseDrupalDetail(fixture('drupal-barrie-detail.html'), 'https://www.barrie.ca')
  const innisfil = () => parseDrupalDetail(fixture('drupal-innisfil-detail.html'), 'https://www.innisfil.ca')

  it('reads the site\'s own Cost field', () => {
    expect(barrie().costText).toBe('Free')
    expect(assessCost({ costText: barrie().costText })).toMatchObject({ cost: 'free', confidence: 'high' })
  })

  it('reads the body text without dragging in the rest of the site', () => {
    const detail = barrie()
    expect(detail.description).toContain('Culture Days')
    // The page is 146KB of which the event is 2.6KB; a "$" from the other 143KB would
    // put a price on a free concert.
    expect(detail.description!.length).toBeLessThan(2000)
    expect(detail.description).not.toContain('Freedom of Information')
  })

  it('takes the event node, not the first node on the page', () => {
    // Innisfil's page opens with a contact sidebar block and Tiny's with a site alert,
    // both of them nodes too. Only the event is in Drupal's "full" view mode.
    const detail = innisfil()
    expect(detail.description).toContain('Council')
    expect(detail.imageUrl).toContain('https://www.innisfil.ca/sites/default/files/')
  })

  it('returns nothing for a page with no event node', () => {
    expect(parseDrupalDetail('<html><body><article class="node node--type-alert">Closed</article></body></html>', 'https://x.invalid')).toEqual({})
  })
})
