import { describe, expect, it } from 'vitest'
import { shortCode } from '@scec/core'
import { buildManualListing, editedGroups, overridesFromForm, parseEventForm, withoutGroups, type ManualEventInput } from '../src/console-form.ts'

const UUID = '6f1c1f57-0f7a-4c61-9a7e-0d5c1f2b3a44'

const valid = (form: Record<string, unknown>): ManualEventInput => {
  const result = parseEventForm(form)
  if (!result.ok) throw new Error(`expected a valid form, got ${JSON.stringify(result.errors)}`)
  return result.input
}

const base = { title: 'Harvest supper', date: '2026-10-03', start_time: '17:30' }

describe('parseEventForm', () => {
  it('needs only a title and a date', () => {
    const input = valid({ title: 'Legion fish fry', date: '2026-10-09' })
    expect(input).toMatchObject({ title: 'Legion fish fry', date: '2026-10-09', startTime: null, cost: 'unknown', status: 'scheduled', municipalitySlug: null })
  })

  it('says which fields are missing, and hands back what was typed', () => {
    const result = parseEventForm({ venue: 'Legion Hall' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(Object.keys(result.errors).sort()).toEqual(['date', 'title'])
    expect(result.values.venue).toBe('Legion Hall')
  })

  it('refuses a municipality, category, cost or status that is not on the list', () => {
    const result = parseEventForm({ ...base, municipality: 'toronto', category: 'nightlife', cost: 'cheap', status: 'maybe' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(Object.keys(result.errors).sort()).toEqual(['category', 'cost', 'municipality', 'status'])
  })

  it('refuses an end before the start, and an end time with no start time', () => {
    expect(parseEventForm({ ...base, end_time: '17:00' }).ok).toBe(false)
    expect(parseEventForm({ ...base, end_date: '2026-10-02' }).ok).toBe(false)
    expect(parseEventForm({ title: 'Fair', date: '2026-10-03', end_time: '16:00' }).ok).toBe(false)
  })

  it('allows a timed event to run past midnight when an end date says so', () => {
    expect(valid({ ...base, end_date: '2026-10-04', end_time: '01:00' })).toMatchObject({ endDate: '2026-10-04', endTime: '01:00' })
  })

  it('forgives a link pasted without https://, and refuses one that is not a web address', () => {
    expect(valid({ ...base, url: 'legion.ca/supper' }).url).toBe('https://legion.ca/supper')
    expect(parseEventForm({ ...base, url: 'javascript:alert(1)' }).ok).toBe(false)
  })

  it('takes only https posters, which an https page can actually show', () => {
    expect(parseEventForm({ ...base, image_url: 'http://legion.ca/poster.jpg' }).ok).toBe(false)
    expect(valid({ ...base, image_url: 'https://legion.ca/poster.jpg' }).imageUrl).toBe('https://legion.ca/poster.jpg')
  })
})

describe('buildManualListing', () => {
  it('is a listing from the manual source, with an id that edits keep', () => {
    const listing = buildManualListing(valid(base), UUID)
    expect(listing.id).toBe(`manual:${UUID}`)
    expect([listing.sourceSlug, listing.sourceKind, listing.externalId]).toEqual(['manual', 'manual', UUID])
    expect(shortCode(listing.id)).toMatch(/^[0-9a-f]{7}$/)
  })

  it('reads the time as Simcoe County wall time, converting it once', () => {
    // 17:30 on 3 October is daylight time in Toronto, four hours behind UTC.
    const listing = buildManualListing(valid(base), UUID)
    expect([listing.localDate, listing.localTime, listing.startsAtUtc]).toEqual(['2026-10-03', '17:30', '2026-10-03T21:30:00.000Z'])
    expect(listing.allDay).toBe(false)
  })

  it('stores an all-day span the way the scrapers do: to 23:59 on its last day', () => {
    const listing = buildManualListing(valid({ title: 'Studio tour', date: '2026-10-02', end_date: '2026-10-04' }), UUID)
    expect([listing.allDay, listing.timePrecision]).toEqual([true, 'date-only'])
    // 23:59 Toronto on the 4th is 03:59 UTC on the 5th.
    expect(listing.endsAtUtc).toBe('2026-10-05T03:59:00.000Z')
    expect(buildManualListing(valid({ title: 'Fair', date: '2026-10-02' }), UUID).endsAtUtc).toBeNull()
  })

  it('does what the form says, not what the text suggests', () => {
    const listing = buildManualListing(
      valid({
        ...base,
        title: 'CANCELLED: Jazz night',
        description: 'Tickets $20 at the door. At the Barrie Legion.',
        address: '123 Main St, Barrie',
        municipality: '',
        category: 'music',
        cost: 'unknown',
        status: 'scheduled',
      }),
      UUID,
    )
    expect(listing.municipalitySlug).toBeNull()
    expect(listing.category).toBe('music')
    expect(listing.cost).toBe('unknown')
    expect(listing.status).toBe('scheduled')
  })

  it('keeps the line breaks that were typed, tidying spaces and extra blank lines', () => {
    const listing = buildManualListing(
      valid({ ...base, description: 'Registration  8:00am\nOpening ceremony 9am  \n\n\n\nBring a donation!' }),
      UUID,
    )
    expect(listing.description).toBe('Registration 8:00am\nOpening ceremony 9am\n\nBring a donation!')
    // The hash sees the breaks too, so adding one is an edit.
    const flat = buildManualListing(valid({ ...base, description: 'Registration 8:00am Opening ceremony 9am' }), UUID)
    const broken = buildManualListing(valid({ ...base, description: 'Registration 8:00am\nOpening ceremony 9am' }), UUID)
    expect(flat.contentHash).not.toBe(broken.contentHash)
  })

  it('still classifies the category from the title when asked to', () => {
    expect(buildManualListing(valid({ ...base, title: 'Farmers market', category: 'auto' }), UUID).category).toBe('markets')
  })

  it('stores no link as an empty url, which the schema requires and dedup cannot match', () => {
    expect(buildManualListing(valid(base), UUID).url).toBe('')
  })

  /* Dedup caches its pair verdicts by content hash. An edit that only moves an event to
     another town changes the municipality gate, so it must look like a change. */
  it('changes its content hash when only a form choice changes', () => {
    const tay = buildManualListing(valid({ ...base, municipality: 'tay' }), UUID)
    const barrie = buildManualListing(valid({ ...base, municipality: 'barrie' }), UUID)
    const again = buildManualListing(valid({ ...base, municipality: 'tay' }), UUID)
    expect(tay.contentHash).not.toBe(barrie.contentHash)
    expect(tay.contentHash).toBe(again.contentHash)
  })
})

describe('overridesFromForm', () => {
  const filled = { title: 'Fair', date: '2099-10-03', start_time: '10:00', image_url: 'http://calendar.tay.ca/p.jpg', cost: 'unknown', status: 'scheduled', category: 'community' }
  const withOriginals = (form: Record<string, string>) => ({ ...form, ...Object.fromEntries(Object.entries(filled).map(([k, v]) => [`orig_${k}`, v])) })

  it('changes nothing when nothing was edited, even if a source value fails the form', () => {
    expect(overridesFromForm(withOriginals(filled), {})).toEqual({ ok: true, overrides: {}, changed: [] })
  })

  it('adds the edited group to what was already pinned', () => {
    const result = overridesFromForm(withOriginals({ ...filled, cost: 'free' }), { title: 'Earlier edit' })
    expect(result).toEqual({ ok: true, overrides: { title: 'Earlier edit', cost: 'free' }, changed: ['cost'] })
  })

  it('reads line endings and surrounding space as no change', () => {
    const form = { ...withOriginals(filled), title: '  Fair\r\n' }
    expect(overridesFromForm(form, {})).toMatchObject({ changed: [] })
  })
})

describe('editedGroups and withoutGroups', () => {
  it('names the groups an override pins and takes them out again, leaving hidden alone', () => {
    const overrides = { title: 'X', localTime: '11:00', active: false }
    expect(editedGroups(overrides)).toEqual(['title', 'when'])
    expect(withoutGroups(overrides, ['title'])).toEqual({ localTime: '11:00', active: false })
    expect(withoutGroups(overrides, 'all')).toEqual({ active: false })
  })
})
