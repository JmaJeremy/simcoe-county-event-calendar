import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { eventonListUrl, mapEventonPost, parseEventPage, publishedAfter, wallFromJsonLd, type EventonPost } from '../src/eventon.ts'

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const window = { from: '2026-09-01', to: '2026-12-31' }

describe('eventon adapter', () => {
  const posts: EventonPost[] = JSON.parse(fixture('eventon-simcoe-list.json'))
  const tay = posts.find((p) => p.id === 51625)!
  const page = parseEventPage(fixture('eventon-simcoe-event.html'))

  it('restricts the REST list to recently published posts', () => {
    expect(publishedAfter(window)).toBe('2025-07-28')
    expect(eventonListUrl('https://simcoe.ca', '2025-07-28', 2)).toContain('/wp-json/wp/v2/ajde_events?per_page=100&page=2&after=2025-07-28T00:00:00')
  })

  it('reads the occurrence, venue, description and image off the event page', () => {
    expect(page.times).toEqual([{ localStart: '2026-09-17T17:30', localEnd: '2026-09-17T18:30' }])
    expect(page.locationName).toBe('Tay Township Municipal Office')
    expect(page.address).toBe('450 Park St, Victoria Harbour, ON L0K 2A0, Canada')
    expect(page.description).toContain('Join us for an evening of connection')
    expect(page.description).not.toMatch(/<|wp:paragraph/)
    expect(page.imageUrl).toBe('https://simcoe.ca/wp-content/uploads/2026/08/taytownshiplogo.png')
  })

  it('reads the wall clock the page displays, not the mis-zoned data-time', () => {
    // simcoe.ca's WordPress zone is UTC+1; data-time is five hours off there.
    expect(wallFromJsonLd('2026-9-17T17:30-4:00')).toBe('2026-09-17T17:30')
    expect(wallFromJsonLd('2026-12-01T09:05-5:00')).toBe('2026-12-01T09:05')
    expect(wallFromJsonLd(undefined)).toBeUndefined()
  })

  it('maps occurrences and uses the post id as the occurrence id', () => {
    const [event] = mapEventonPost(tay, page, window, new Map([[360, 'Week of Welcome LIP Calendar']]))
    expect(event!.externalId).toBe('51625')
    expect(event!.localStart).toBe('2026-09-17T17:30')
    expect(event!.localEnd).toBe('2026-09-17T18:30')
    expect(event!.title).toBe('Welcome to Tay Township: Week of Welcome Municipal Open House')
    expect(event!.categories).toEqual(['Week of Welcome LIP Calendar'])
    expect(event!.url).toBe(tay.link)
  })

  it('drops occurrences outside the window and splits multi-time posts', () => {
    expect(mapEventonPost(tay, page, { from: '2026-10-01', to: '2026-12-31' })).toHaveLength(0)
    const two = mapEventonPost(tay, { ...page, times: [...page.times, { localStart: '2026-09-24T17:30' }] }, window)
    expect(two.map((e) => e.externalId)).toEqual(['51625@2026-09-17T17:30', '51625@2026-09-24T17:30'])
  })

  it('handles the Adjala-Tosorontio theme the same way', () => {
    const adj = parseEventPage(fixture('eventon-adjtos-event.html'))
    expect(adj.times).toEqual([{ localStart: '2026-09-30T10:00', localEnd: '2026-09-30T12:00' }])
    expect(adj.locationName).toBe("Warden's Park")
    expect(adj.address).toBe('7855 30th Sideroad')
    expect(adj.description).toContain('honour Residential School survivors')
  })
})
