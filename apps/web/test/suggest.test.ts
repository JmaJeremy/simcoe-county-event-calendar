import { describe, expect, it } from 'vitest'
import { HONEYPOT, adminMail, thanksMail, validateSuggestion, type Suggestion } from '../src/suggest.ts'

const valid = (form: Record<string, unknown>): Suggestion => {
  const result = validateSuggestion(form)
  if (result.ok !== true) throw new Error(`expected a valid suggestion, got ${JSON.stringify(result)}`)
  return result.suggestion
}

describe('validateSuggestion', () => {
  it('accepts a single field on its own, since every field is optional', () => {
    expect(valid({ title: 'Pumpkin festival' }).title).toBe('Pumpkin festival')
    expect(valid({ comments: 'The Legion does a fish fry every Friday' }).comments).toContain('fish fry')
  })

  it('refuses a submission that suggests nothing at all', () => {
    const result = validateSuggestion({ name: 'Sam', email: 'sam@example.com' })
    expect(result.ok).toBe(false)
  })

  it('drops a bot that filled the hidden field, without telling it so', () => {
    expect(validateSuggestion({ title: 'Buy now', [HONEYPOT]: 'Acme' })).toEqual({ ok: 'spam' })
  })

  it('forgives a link pasted without https://', () => {
    expect(valid({ kind: 'website', url: 'barrieconcerts.org' }).url).toBe('https://barrieconcerts.org/')
  })

  it('refuses a link that is not a web address', () => {
    for (const url of ['javascript:alert(1)', 'ftp://example.com/x', 'not a link', 'mailto:a@b.co']) {
      expect(validateSuggestion({ url }).ok, url).toBe(false)
    }
  })

  it('refuses a malformed email rather than silently never thanking them', () => {
    expect(validateSuggestion({ title: 'Fair', email: 'sam at example' }).ok).toBe(false)
    expect(validateSuggestion({ title: 'Fair', email: 'a@b.co\r\nBcc: victim@example.com' }).ok).toBe(false)
  })

  it('keeps only well-formed dates and times', () => {
    const s = valid({ title: 'Fair', date: '2026-10-03', time: '09:30' })
    expect([s.date, s.time]).toEqual(['2026-10-03', '09:30'])
    const bad = valid({ title: 'Fair', date: '2026-13-40', time: '25:00' })
    expect([bad.date, bad.time]).toEqual([null, null])
  })

  it('ignores event-only fields on a website suggestion', () => {
    const s = valid({ kind: 'website', url: 'https://example.org', date: '2026-10-03', description: 'A fair' })
    expect([s.kind, s.date, s.description]).toEqual(['website', null, null])
  })

  it('caps every field, so one submission cannot fill the database', () => {
    const s = valid({ title: 'x'.repeat(10_000), description: 'y'.repeat(100_000) })
    expect(s.title).toHaveLength(200)
    expect(s.description).toHaveLength(5000)
  })

  it('treats anything unknown as an event and ignores fields that are not strings', () => {
    const s = valid({ kind: 'nonsense', title: 'Fair', name: { toString: () => 'x' } })
    expect([s.kind, s.name]).toEqual(['event', null])
  })
})

describe('suggestion emails', () => {
  const suggestion = valid({
    kind: 'event',
    name: 'Sam',
    email: 'sam@example.com',
    title: 'Harvest supper\r\nBcc: someone@example.com',
    url: 'https://example.org/supper',
    date: '2026-10-03',
    description: 'Roast beef, pie.\nAll welcome.',
  })

  it('never lets a line break from the title reach the subject', () => {
    const { subject } = adminMail(suggestion, { id: 'abc', receivedAt: '2026-09-14T18:00:00Z' })
    expect(subject).not.toMatch(/[\r\n]/)
    expect(subject).toMatch(/^Suggestion \(event\): Harvest supper/)
  })

  it('gives the admin everything that was sent', () => {
    const { text } = adminMail(suggestion, { id: 'abc', receivedAt: '2026-09-14T18:00:00Z' })
    for (const part of ['Sam <sam@example.com>', 'https://example.org/supper', '2026-10-03', 'Roast beef, pie.\nAll welcome.', 'abc']) {
      expect(text).toContain(part)
    }
  })

  it('says so when the suggester left no way to reach them', () => {
    const anonymous = valid({ url: 'example.org' })
    expect(adminMail(anonymous, { id: 'x', receivedAt: 'now' }).text).toContain('Anonymous')
  })

  it('thanks the suggester without repeating a word they typed', () => {
    // Anyone can enter anyone's address, so an echo would be a way to mail a stranger.
    const { subject, text } = thanksMail(suggestion)
    expect(subject).not.toMatch(/[\r\n]/)
    for (const typed of ['Sam', 'Harvest', 'example.org', 'Roast beef', 'someone@example.com']) {
      expect(text).not.toContain(typed)
    }
    expect(text).toContain('the event you suggested')
  })
})
