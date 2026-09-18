import { describe, expect, it } from 'vitest'
import { parseIcs } from '../src/ical-read.ts'

/**
 * The parts of RFC 5545 a published feed actually uses. Folding and escaping are the two
 * that look like noise and silently corrupt a title when they are ignored.
 */

const feed = (...events: string[]) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.join('')}END:VCALENDAR\r\n`
const event = (body: string) => `BEGIN:VEVENT\r\n${body}\r\nEND:VEVENT\r\n`

describe('parseIcs', () => {
  it('unfolds continuation lines, whichever line ending the feed uses', () => {
    const [long] = parseIcs(feed(event('UID:a\r\nDTSTART:20261001T140000Z\r\nSUMMARY:A very long title that the\r\n  feed wrapped')))
    expect(long!.summary).toBe('A very long title that the feed wrapped')
    const [unix] = parseIcs(feed(event('UID:b\nDTSTART:20261001T140000Z\nSUMMARY:Unix endings')).replace(/\r/g, ''))
    expect(unix!.summary).toBe('Unix endings')
  })

  it('reads the escapes, so a comma is a comma and not a new value', () => {
    const [e] = parseIcs(feed(event('UID:c\r\nDTSTART:20261001T140000Z\r\nSUMMARY:Build\\, design\; imagine\r\nDESCRIPTION:Line one\\nLine two')))
    expect(e!.summary).toBe('Build, design; imagine')
    expect(e!.description).toBe('Line one\nLine two')
  })

  it('tells the three kinds of moment apart', () => {
    const [utc] = parseIcs(feed(event('UID:d\r\nDTSTART:20260817T143000Z\r\nDTEND:20260817T153000Z')))
    expect(utc!.start).toEqual({ value: '2026-08-17T14:30', kind: 'utc' })
    const [day] = parseIcs(feed(event('UID:e\r\nDTSTART;VALUE=DATE:20260731\r\nDTEND;VALUE=DATE:20260801')))
    expect(day!.start).toEqual({ value: '2026-07-31', kind: 'date' })
    expect(day!.end).toEqual({ value: '2026-08-01', kind: 'date' })
    const [zoned] = parseIcs(feed(event('UID:f\r\nDTSTART;TZID=America/Toronto:20261001T190000')))
    expect(zoned!.start).toEqual({ value: '2026-10-01T19:00', kind: 'floating', timeZone: 'America/Toronto' })
  })

  it('splits categories and keeps the event’s own link', () => {
    const [e] = parseIcs(feed(event('UID:g\r\nDTSTART:20261001T140000Z\r\nCATEGORIES:Childrens Programming,Reading\r\nURL:https://example.ca/event/1\r\nLOCATION:Elmvale Branch')))
    expect(e!.categories).toEqual(['Childrens Programming', 'Reading'])
    expect([e!.url, e!.location]).toEqual(['https://example.ca/event/1', 'Elmvale Branch'])
  })

  it('drops an entry with no id or no start, and ignores everything outside VEVENT', () => {
    const parsed = parseIcs(
      feed(event('UID:h\r\nSUMMARY:No start'), event('DTSTART:20261001T140000Z\r\nSUMMARY:No uid'), event('UID:i\r\nDTSTART:20261002T140000Z')),
    )
    expect(parsed.map((e) => e.uid)).toEqual(['i'])
  })
})
