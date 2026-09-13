import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mapCards, parseCards, parseDetail, parseWhen } from '../src/spaces.ts'

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const window = { from: '2026-09-13', to: '2026-12-31' }

describe('spaces adapter', () => {
  const cards = parseCards(fixture('spaces-barrie-list.html'))

  it('parses every card, including titles in the alternate span', () => {
    expect(cards).toHaveLength(21)
    const market = cards.find((c) => c.id === '69486')!
    expect(market).toMatchObject({
      category: 'Small business',
      title: 'Curated Collective Market @ Georgian Mall',
      when: 'Sep 12 9:30 AM - Sep 13 5:00 PM',
      link: '/small-business/curated-collective-market-georgian-mall-69486',
    })
    expect(cards.find((c) => c.id === '69810')!.title).toContain('Romance of the Violin')
  })

  it.each([
    ['Sep 12 9:30 AM - Sep 13 5:00 PM', { startDate: '2026-09-12', startTime: '09:30', endDate: '2026-09-13', endTime: '17:00' }],
    ['Sep 13 2:30 PM - 4:30 PM', { startDate: '2026-09-13', startTime: '14:30', endDate: '2026-09-13', endTime: '16:30' }],
    ['Sep 13', { startDate: '2026-09-13', startTime: undefined }],
    ['Jan 4 7:00 PM', { startDate: '2027-01-04', startTime: '19:00' }],
  ])('parses the date line %s', (text, expected) => {
    expect(parseWhen(text, window)).toMatchObject(expected)
  })

  it('reads the organiser text and labelled lines from the detail page', () => {
    const detail = parseDetail(fixture('spaces-barrie-detail.html'))
    expect(detail.organizer).toBe('Beyond Giving')
    expect(detail.description).toContain('Curated Collective Market at Georgian Mall')
    expect(detail.description).not.toMatch(/<[a-z]/i)
  })

  it('picks Location and Cost lines when the organiser wrote them', () => {
    const html = `<div id="post" class="card" data-id="1"><div class="card-body"><span class="title">CELL</span><h3>Mushrooms</h3><p>Date: September 13, 2026<br>Time: 10am - 1pm<br>Location: Copeland Forest (Hillsdale via Horseshoe Valley Road)<br>Cost: $60 +HST</p><p>More.</p><div class="snippet snippet-md"></div>`
    const detail = parseDetail(html)
    expect(detail.venueName).toBe('Copeland Forest (Hillsdale via Horseshoe Valley Road)')
    expect(detail.costText).toBe('$60 +HST')
  })

  it('maps cards to occurrences keyed by post id and start date', () => {
    const events = mapCards('barrie.spaces.ca', cards, new Map(), window)
    const market = events.find((e) => e.externalId === '69486@2026-09-12')!
    expect(market.localStart).toBe('2026-09-12T09:30')
    expect(market.localEnd).toBe('2026-09-13T17:00')
    expect(market.url).toBe('https://barrie.spaces.ca/small-business/curated-collective-market-georgian-mall-69486')
    expect(market.categories).toEqual(['Small business'])
    const dateOnly = events.find((e) => e.externalId === '69810@2026-09-13')!
    expect(dateOnly.timePrecision).toBe('date-only')
    expect(dateOnly.allDay).toBe(true)
  })
})
