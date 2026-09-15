import { describe, expect, it } from 'vitest'
import { acceptedMail } from '../src/suggestion-mail.ts'

describe('acceptedMail', () => {
  it('links the published event, under the title the admin gave it', () => {
    const { subject, text } = acceptedMail(
      { kind: 'event', createdAt: '2026-09-15T14:00:00.000Z' },
      { title: 'Pumpkin Walk at Ganaraska', url: 'https://outinsimcoe.ca/e/abc1234' },
    )
    expect(subject).toBe('Your suggestion is on Out in Simcoe')
    expect(text).toContain('the event you suggested to Out in Simcoe on September 15 is now on the calendar')
    expect(text).toContain('Pumpkin Walk at Ganaraska\nhttps://outinsimcoe.ca/e/abc1234')
  })

  it('accepts a website without promising an event, and links nothing', () => {
    const { subject, text } = acceptedMail({ kind: 'website', createdAt: '2026-09-15T01:01:53.696Z' }, null)
    expect(subject).toBe('Your suggestion was accepted — Out in Simcoe')
    // 01:01 UTC is still the 14th in Simcoe County.
    expect(text).toContain("we've accepted the website you suggested to Out in Simcoe on September 14, and plan to include the events it lists")
    expect(text).not.toContain('/e/')
  })

  it('keeps an event title on one line', () => {
    const { text } = acceptedMail({ kind: 'event', createdAt: '2026-09-15T14:00:00.000Z' }, { title: 'Fair\r\nBcc: someone', url: 'https://outinsimcoe.ca/e/x' })
    expect(text).toContain('Fair Bcc: someone\nhttps://outinsimcoe.ca/e/x')
  })
})
