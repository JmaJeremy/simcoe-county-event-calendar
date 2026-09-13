import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mapFullCalendar, mapRows, parseFullCalendar, parseRows } from '../src/drupal.ts'

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const window = { from: '2026-09-01', to: '2026-12-31' }

describe('drupal fullcalendar mode', () => {
  it('reads every event out of drupalSettings on Barrie, Tiny and Clearview', () => {
    expect(parseFullCalendar(fixture('drupal-barrie-list.html'))).toHaveLength(392)
    expect(parseFullCalendar(fixture('drupal-tiny-list.html'))).toHaveLength(1081)
    expect(parseFullCalendar(fixture('drupal-clearview-list.html'))).toHaveLength(82)
  })

  it('keys occurrences by eid, keeps naive local times and windows them', () => {
    const events = mapFullCalendar('https://www.barrie.ca', parseFullCalendar(fixture('drupal-barrie-list.html')), window)
    expect(events.length).toBeGreaterThan(50)
    expect(events.length).toBeLessThan(392)
    for (const e of events) {
      expect(e.localStart >= '2026-09-01' && e.localStart <= '2026-12-31T23:59').toBe(true)
      expect(e.externalId).toMatch(/^\d+-[DR]-/)
      expect(e.url.startsWith('https://www.barrie.ca/community-recreation-environment/community-events/')).toBe(true)
    }
    const timed = events.find((e) => !e.allDay)!
    expect(timed.localStart).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    expect(timed.timePrecision).toBe('exact')
  })

  it('treats all-day entries as date-only and trims the exclusive end day', () => {
    const [single] = mapFullCalendar('https://x', [{ title: 'Fair', eid: '1-D-0', url: '/e/fair', start: '2026-10-03', end: '2026-10-04', allDay: true }], window)
    expect(single).toMatchObject({ localStart: '2026-10-03T00:00', allDay: true, timePrecision: 'date-only' })
    expect(single!.localEnd).toBeUndefined()
    const [multi] = mapFullCalendar('https://x', [{ title: 'Fair', eid: '1-D-0', url: '/e/fair', start: '2026-10-03', end: '2026-10-06', allDay: true }], window)
    expect(multi!.localEnd).toBe('2026-10-05T23:59')
  })

  it('strips the All Day badge Clearview glues onto titles and falls back to path@start ids', () => {
    const events = mapFullCalendar('https://www.clearview.ca', parseFullCalendar(fixture('drupal-clearview-list.html')), window)
    expect(events.some((e) => /All Day|<|fc-time/.test(e.title))).toBe(false)
    const orchard = events.find((e) => e.externalId === '29862-D-0')!
    expect(orchard.title).toBe('Autumn in the Orchard')
    expect(orchard.allDay).toBe(true)
    // Repeating-rule instances arrive with epoch-second starts; rendered in Toronto time.
    const [epoch] = mapFullCalendar('https://x', [{ title: 'Yoga', eid: '5-R-1-I-2', url: '/e/yoga', start: 1792798200, end: 1792801800, allDay: false }], { from: '2026-10-01', to: '2026-10-31' })
    expect(epoch).toMatchObject({ localStart: '2026-10-23T12:10', localEnd: '2026-10-23T13:10' })
    const [noEid] = mapFullCalendar('https://x', [{ title: 'T', eid: '', url: '/e/t', start: '2026-10-03T10:00:00' }], window)
    expect(noEid!.externalId).toBe('/e/t@2026-10-03T10:00')
  })
})

describe('drupal rows mode', () => {
  it('parses the rendered rows on Innisfil and Collingwood', () => {
    const innisfil = parseRows(fixture('drupal-innisfil-list.html'))
    const collingwood = parseRows(fixture('drupal-collingwood-list.html'))
    expect(innisfil.length).toBeGreaterThan(200)
    expect(collingwood.length).toBeGreaterThan(150)
    expect(collingwood[0]).toMatchObject({
      path: '/arts-culture-heritage/community-public-events/collingwood-fashion-week-returns',
      title: 'Collingwood Fashion Week Returns',
      start: '2026-09-11T19:00:00-04:00',
      end: '2026-09-11T22:00:00-04:00',
    })
  })

  it('treats a bare date as an all-day, date-only occurrence', () => {
    const [e] = mapRows('https://x', [{ path: '/e/fair', title: 'Fair', start: '2026-09-12', end: '2026-09-13' }], window)
    expect(e).toMatchObject({ localStart: '2026-09-12T00:00', localEnd: '2026-09-13T23:59', allDay: true, timePrecision: 'date-only' })
    const [same] = mapRows('https://x', [{ path: '/e/fair', title: 'Fair', start: '2026-09-12', end: '2026-09-12' }], window)
    expect(same!.localEnd).toBeUndefined()
  })

  it('ids recurring nodes per occurrence, since the path names only the first date', () => {
    const rows = parseRows(fixture('drupal-innisfil-list.html'))
    const council = rows.filter((r) => r.path.endsWith('/2026-03-11-council-meeting'))
    expect(council.length).toBeGreaterThan(1)
    const events = mapRows('https://www.innisfil.ca', council, { from: '2026-01-01', to: '2027-12-31' })
    expect(new Set(events.map((e) => e.externalId)).size).toBe(events.length)
    expect(events[0]!.externalId).toMatch(/^\/community-recreation\/events\/2026-03-11-council-meeting@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    expect(events[0]!.localStart).not.toContain('-04:00')
  })
})
