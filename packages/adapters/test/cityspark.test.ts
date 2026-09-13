import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { citySparkBody, mapCitySparkEvents, type CitySparkResponse } from '../src/cityspark.ts'

const body: CitySparkResponse = JSON.parse(readFileSync(new URL('./fixtures/cityspark-simcoe.json', import.meta.url), 'utf8'))
const rows = body.Value ?? []

describe('cityspark adapter', () => {
  const { events, outsideCounty } = mapCitySparkEvents('https://www.simcoe.com/events/', rows)

  it('sends the request shape the portal page uses', () => {
    const b = citySparkBody({ ppid: 9299, lat: 44.389, lng: -79.69, distanceKm: 75 }, { from: '2026-09-13', to: '2026-12-31' }, 100)
    expect(b).toMatchObject({ ppid: 9299, start: '2026-09-13T00:00:00', end: '2026-12-31T23:59:59', distance: 75, skip: 100, sort: 'Date' })
  })

  it('drops rows outside Simcoe County, since the portal ignores its own radius', () => {
    expect(rows.some((r) => r.CityState === 'Markham, ON')).toBe(true)
    expect(events.some((e) => e.address?.includes('Markham'))).toBe(false)
    expect(outsideCounty).toBeGreaterThan(0)
    expect(events.length + outsideCounty).toBe(rows.length)
    expect(events.length).toBeGreaterThan(0)
  })

  it('reads DateStart as local wall time and keeps the real cost signal', () => {
    const local = rows.find((r) => r.CityState === 'Collingwood, ON' && r.HasTime)!
    const mapped = events.find((e) => e.externalId === String(local.PId))!
    expect(mapped.localStart).toBe(local.DateStart.replace(/Z$/, '').slice(0, 16))
    expect(mapped.timePrecision).toBe('exact')
    expect(mapped.municipalityHint).toBe('Collingwood')
    expect(mapped.url).toBe(`https://www.simcoe.com/events/#/details/${mapped.url.split('/').at(-2)}/${local.PId}`)
    const free = events.find((e) => e.isFree)
    expect(free?.costText).toBe('Free')
  })

  it('marks rows without a time as date-only all-day events', () => {
    const untimed = rows.find((r) => !r.HasTime && /Collingwood|Barrie|Innisfil|Wasaga|Cookstown|Alliston|Tottenham/.test(r.CityState ?? ''))
    if (!untimed) return
    const mapped = events.find((e) => e.externalId === String(untimed.PId))!
    expect(mapped.allDay).toBe(true)
    expect(mapped.localStart.endsWith('T00:00')).toBe(true)
  })
})
