import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeEvent, sourceBySlug } from '@scec/core'
import { mapSitefinityEvents, sitefinityUrl, type SitefinityEvent } from '../src/sitefinity.ts'

const rows: SitefinityEvent[] = JSON.parse(
  readFileSync(new URL('./fixtures/sitefinity-tourism-barrie.json', import.meta.url), 'utf8'),
).value
const ORIGIN = 'https://www.tourismbarrie.com'
const DETAIL = '/festivals-events/details'
const source = sourceBySlug('tourism-barrie')!
const events = mapSitefinityEvents(ORIGIN, DETAIL, rows)
const byTitle = (title: string) => {
  const i = rows.findIndex((r) => r.Title.startsWith(title))
  if (i < 0) throw new Error(`no fixture row titled ${title}`)
  return events[i]!
}

describe('sitefinity adapter', () => {
  it('pages the OData service in hundreds, its own ceiling, for events not yet over', () => {
    const url = new URL(sitefinityUrl(ORIGIN, { from: '2026-09-18', to: '2027-03-18' }, 200))
    expect(url.pathname).toBe('/api/default/events')
    expect(url.searchParams.get('$top')).toBe('100')
    expect(url.searchParams.get('$skip')).toBe('200')
    expect(url.searchParams.get('$filter')).toBe('EventEnd ge 2026-09-18T00:00:00Z and EventStart le 2027-03-18T23:59:59Z')
  })

  it('maps every row, keyed on the event GUID, linked to the event’s own page', () => {
    expect(events).toHaveLength(rows.length)
    expect(new Set(events.map((e) => e.externalId)).size).toBe(rows.length)
    expect(byTitle('Pumpkin Mania').url).toBe(`${ORIGIN}${DETAIL}/2026/09/19/default-calendar/Pumpkin_Mania.aspx`)
  })

  it('reads the wall clock from the offset field, whichever zone the entry was saved in', () => {
    // Saved in Eastern time: EventStart is 14:00Z, the wall clock 10:00.
    expect(byTitle('Pumpkin Mania').localStart).toBe('2026-09-19T10:00')
    // Saved as "UTC" with offset 0: EventStart already IS the wall clock. Read as an
    // instant it would open Doors Open Barrie at 6:00.
    const doorsOpen = rows.find((r) => r.Title === 'Doors Open Barrie')!
    expect(doorsOpen.EventStart).toBe('2026-09-26T10:00:00Z')
    expect(byTitle('Doors Open Barrie').localStart).toBe('2026-09-26T10:00')
    expect(normalizeEvent(source, byTitle('Doors Open Barrie')).localTime).toBe('10:00')
  })

  it('keeps a season-long span whole, so a festival under way still shows', () => {
    const pumpkins = byTitle('Pumpkin Mania')
    expect(pumpkins.localEnd).toBe('2026-10-25T17:00')
    expect(pumpkins.timePrecision).toBe('exact')
  })

  it('treats a midnight start as no time given, and ends an all-day event on its last day', () => {
    const cultureDays = byTitle('Culture Days')
    expect(cultureDays.timePrecision).toBe('date-only')
    expect(cultureDays.localEnd).toBe('2026-10-04T23:00')
    // First Light: all day, Nov 26 to the midnight that begins Dec 14.
    const firstLight = byTitle('First Light')
    expect(firstLight.allDay).toBe(true)
    expect(firstLight.localEnd).toBe('2026-12-13T23:59')
  })

  it('places each event by its own city and street, since the source is regional', () => {
    expect(source.municipalitySlug).toBeNull()
    expect(normalizeEvent(source, byTitle('Pumpkin Mania')).municipalitySlug).toBe('springwater')
    expect(normalizeEvent(source, byTitle('First Light')).municipalitySlug).toBe('midland')
    expect(byTitle('Barrie Colts vs Sudbury Wolves').venueName).toBe('Sadlon Arena')
    // No City, and a street named after another town: "80 Bradford Street" is in Barrie.
    const maids = byTitle('TIFT Presents - The Maids')
    expect(maids.municipalityHint).toBeUndefined()
    expect(normalizeEvent(source, maids).municipalitySlug).toBe('barrie')
  })

  it('passes a stated admission to the cost rules', () => {
    const comicFest = byTitle('BPL Comic Fest')
    expect(comicFest.costText).toBe('Free')
    expect(normalizeEvent(source, comicFest).cost).toBe('free')
  })

  it('refuses a recurring event rather than keep only its first date', () => {
    const recurring = { ...rows[0]!, IsRecurrent: true, RecurrenceExpression: 'FREQ=WEEKLY' }
    expect(() => mapSitefinityEvents(ORIGIN, DETAIL, [recurring])).toThrow(/recurring/)
  })
})
