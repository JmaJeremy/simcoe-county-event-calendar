import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeEvent, sourceBySlug } from '@scec/core'
import { cfmwsWallTime, extractLoadedData, mapCfmwsEvents } from '../src/cfmws.ts'

// Trimmed from the live page (2026-09-18): the loadedData script, as the page declares it.
const html = readFileSync(new URL('./fixtures/cfmws-borden.html', import.meta.url), 'utf8')
const WINDOW = { from: '2026-09-18', to: '2027-03-18' }
const source = sourceBySlug('cfb-borden')!

describe('cfmws adapter', () => {
  const rows = extractLoadedData(html)
  const events = mapCfmwsEvents('https://cfmws.ca', 'CFB Borden', rows, WINDOW)

  it('reads the whole list the page embeds', () => {
    expect(rows).toHaveLength(9)
  })

  it('drops the online webinars and keeps what happens on the base', () => {
    expect(rows.filter((r) => r.event_virtual)).toHaveLength(7)
    expect(events.map((e) => e.title).sort()).toEqual(['Borden Blast', 'Spooky Sprint'])
  })

  it('reads twelve-hour times and ignores the editor’s stray seconds', () => {
    expect(cfmwsWallTime('2026-10-23 6:15:11 p.m.')).toBe('2026-10-23T18:15')
    expect(cfmwsWallTime('2026-09-19 10:00:00 a.m.')).toBe('2026-09-19T10:00')
    expect(cfmwsWallTime('2026-09-19 12:30:00 p.m.')).toBe('2026-09-19T12:30')
    expect(cfmwsWallTime('2026-09-19 12:05:00 a.m.')).toBe('2026-09-19T00:05')
  })

  it('places events on the base, which is its own place rather than Essa', () => {
    const blast = events.find((e) => e.title === 'Borden Blast')!
    expect(blast.localStart).toBe('2026-09-19T10:00')
    expect(blast.url).toBe('https://cfmws.ca/borden/events-activities/events/borden-blast')
    expect(normalizeEvent(source, blast).municipalitySlug).toBe('cfb-borden')
    // No location of its own: the base stands in.
    expect(events.find((e) => e.title === 'Spooky Sprint')!.venueName).toBe('CFB Borden')
  })

  it('fails loudly when the page no longer declares its data', () => {
    expect(() => extractLoadedData('<html><body>new template</body></html>')).toThrow(/loadedData/)
  })
})
