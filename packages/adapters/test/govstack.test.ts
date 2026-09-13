import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { listUrl, mapItems, pageCount, parseListItems, resultCount, yearFor } from '../src/govstack.ts'

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const window = { from: '2026-09-14', to: '2026-12-31' }

describe('govstack list parsing', () => {
  const html = fixture('govstack-ramara-list.html')
  const items = parseListItems(html)

  it('reads the result count and derives the page count', () => {
    expect(resultCount(html)).toBe(92)
    expect(pageCount(92)).toBe(4)
    expect(pageCount(25)).toBe(1)
    expect(pageCount(0)).toBe(1)
  })

  it('builds first-page and fragment URLs the way the site paginator does', () => {
    expect(listUrl('calendar.ramara.ca', window)).toBe(
      'https://calendar.ramara.ca/default/List?StartDate=09/14/2026&EndDate=12/31/2026',
    )
    expect(listUrl('calendar.ramara.ca', window, 2)).toBe(
      'https://calendar.ramara.ca/default/_List?StartDate=09/14/2026&EndDate=12/31/2026&Page=2',
    )
  })

  it('yields every item on the page with its fields', () => {
    expect(items).toHaveLength(25)
    const ride = items.find((i) => i.title.startsWith('Ride Ramara'))!
    expect(ride).toMatchObject({
      href: '/default/Detail/2026-09-22-0930-Ride-Ramara-Explore-Ramara-Trails',
      category: 'Community Events',
      day: 22,
      month: 9,
      timeText: '9:30 AM',
      address: 'Various',
    })
    expect(ride.description).toContain('Grab your helmet')
    expect(ride.description).not.toContain('<')
  })

  it('parses the fragment pages with the same code', () => {
    const page1 = parseListItems(fixture('govstack-ramara-list-page1.html'))
    expect(page1).toHaveLength(25)
    expect(page1[0]!.title).toBe('Ramara Quilting Club')
  })
})

describe('govstack mapping', () => {
  const items = parseListItems(fixture('govstack-ramara-list.html'))
  const events = mapItems('calendar.ramara.ca', items, window)

  it('uses the detail slug as the id and builds the detail URL', () => {
    const ride = events.find((e) => e.title.startsWith('Ride Ramara'))!
    expect(ride.externalId).toBe('2026-09-22-0930-Ride-Ramara-Explore-Ramara-Trails')
    expect(ride.url).toBe('https://calendar.ramara.ca/default/Detail/2026-09-22-0930-Ride-Ramara-Explore-Ramara-Trails')
    expect(ride.localStart).toBe('2026-09-22T09:30')
    expect(ride.timePrecision).toBe('exact')
    expect(ride.allDay).toBe(false)
    // "Various" is not an address anyone can go to.
    expect(ride.address).toBeUndefined()
    expect(ride.categories).toEqual(['Community Events'])
  })

  it('keeps a real address and infers the year from the window', () => {
    const council = events.find((e) => e.title === 'Township of Ramara Council Meeting')!
    expect(council.address).toBe('2297 Highway 12, Brechin, ON L0K 1B0')
    expect(council.localStart).toBe('2026-09-14T09:30')
  })

  it('synthesises an id when the detail link is empty', () => {
    const voting = events.find((e) => e.title === 'Voting Period Begins')!
    expect(voting.externalId).toBe('2026-10-08-0900-voting-period-begins')
    expect(voting.url).toBe('https://calendar.ramara.ca/default/Month?StartDate=10/01/2026')
  })

  it('drops excluded categories', () => {
    const filtered = mapItems('calendar.ramara.ca', items, window, ['Public Meeting'])
    expect(filtered.some((e) => e.categories.includes('Public Meeting'))).toBe(false)
    expect(filtered.length).toBeLessThan(events.length)
  })

  it('rolls the year over for months before the window start', () => {
    expect(yearFor(9, window)).toBe(2026)
    expect(yearFor(12, window)).toBe(2026)
    expect(yearFor(1, { from: '2026-11-01', to: '2027-02-01' })).toBe(2027)
  })

  it('treats a non-clock time as an all-day, date-only event', () => {
    const [allDay] = mapItems('h', [{ ...items[0]!, timeText: 'All Day', href: '' }], window)
    expect(allDay!.allDay).toBe(true)
    expect(allDay!.timePrecision).toBe('date-only')
    expect(allDay!.localStart.endsWith('T00:00')).toBe(true)
  })
})
