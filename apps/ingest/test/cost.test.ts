import { describe, expect, it } from 'vitest'
import { decideCost } from '../src/cost.ts'

const listing = {
  title: 'Baytowne Big Band',
  description:
    'Baytowne is honoured to kick off Culture Days in the Rotunda of City Hall. ' +
    'Admission is free, and donations to the food bank are welcome. ' +
    'Last year the chapter raised $20,000 for local charities.',
}

/**
 * The model is a finder, not a decider. These are the two things that stand between what
 * it says and what the site shows: the words have to be in the listing, and the ordinary
 * cost rules have to read them as a price.
 */
describe('what a reading is allowed to change', () => {
  it('takes a quote that states admission', () => {
    expect(decideCost(listing, { quote: 'Admission is free' })).toMatchObject({ verdict: 'free' })
  })

  it('refuses words that are not in the listing, however plausible', () => {
    // The failure mode that matters: a model that helpfully writes the sentence it
    // expected to find rather than the one that is there.
    const decision = decideCost(listing, { quote: 'Tickets are $20 at the door' })
    expect(decision).toMatchObject({ verdict: 'unclear', rejected: 'unquoted' })
  })

  it('refuses a real sentence that is not about the price of getting in', () => {
    const decision = decideCost(listing, { quote: 'Last year the chapter raised $20,000 for local charities' })
    expect(decision).toMatchObject({ verdict: 'unclear', rejected: 'inconclusive' })
  })

  it('accepts a quote whose spacing or quote marks differ from the page', () => {
    const decision = decideCost(
      { title: 'Concert', description: 'Tickets are  $20\nat the door.' },
      { quote: 'Tickets are $20 at the door' },
    )
    expect(decision.verdict).toBe('paid')
  })

  it('treats no quote as the common answer, not a failure', () => {
    expect(decideCost(listing, { quote: null })).toMatchObject({ verdict: 'unclear', rejected: 'no-quote' })
    expect(decideCost(listing, null)).toMatchObject({ verdict: 'unclear', rejected: 'no-quote' })
  })

  it('reads the title too, since some listings put the price there', () => {
    const decision = decideCost(
      { title: 'Pancake Breakfast — $5 per person', description: 'Everyone welcome at the hall.' },
      { quote: '$5 per person' },
    )
    expect(decision.verdict).toBe('paid')
  })
})

describe('quotes the rules used to throw away', () => {
  const q = (description: string, quote: string) => decideCost({ title: 'Event', description }, { quote })

  it.each(['no fee', 'no fee, no registration required', 'Donations appreciated.', 'Admission is by donation'])(
    'reads %s as free',
    (quote) => {
      expect(q(`All welcome, ${quote} Everyone is invited.`, quote).verdict).toBe('free')
    },
  )

  it('accepts a price list the proximity rule cannot parse', () => {
    // A real one: a drumming workshop whose only price line is its own shorthand.
    const quote = 'AM (duns) or PM (djembes & full ensemble): $55 Full Day: $75'
    expect(q(`Workshop details. ${quote}`, quote).verdict).toBe('paid')
  })

  it('still refuses money that is being counted rather than charged', () => {
    const quote = 'Last year the chapter raised $20,000 for local charities'
    expect(q(`About us. ${quote}.`, quote)).toMatchObject({ verdict: 'unclear', rejected: 'inconclusive' })
  })

  it('refuses a whole paragraph, however many dollar signs it has', () => {
    const quote = 'x'.repeat(150) + ' $20'
    expect(q(quote, quote)).toMatchObject({ verdict: 'unclear' })
  })
})
