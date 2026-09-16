import { describe, expect, it } from 'vitest'
import { decideCost, judgeCosts } from '../src/cost.ts'
import type { CostJudge } from '../src/cost-judge.ts'
import type { D1Like, D1Statement } from '../src/repository.ts'

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

/**
 * The gate in front of the judge. It can only ever return a sentence already in the
 * listing, and decideCost then requires that sentence to state a price, so a listing with
 * no sum in it has nothing to find. Measured over the first 1,463 readings: all 66 that
 * produced a price came from a listing containing money, and the other 1,371 came back
 * unclear without exception.
 */
describe('which listings are worth asking about', () => {
  const rows = [
    { id: 'a', title: 'Chili Cook-off', description: `Bowls are $5 at the door, ${'x'.repeat(60)}`, content_hash: 'h1', source_name: 'Severn' },
    { id: 'b', title: 'Academy Open House', description: `Admission and registration details to follow. ${'x'.repeat(60)}`, content_hash: 'h2', source_name: 'Barrie' },
  ]

  const stubDb = (): { db: D1Like; batched: number } => {
    const state = { batched: 0 }
    const statement: D1Statement = {
      bind: () => statement,
      all: async () => ({ results: rows }) as { results: never[] },
      run: async () => undefined,
      first: async () => ({ n: rows.length }) as never,
    }
    return { db: { prepare: () => statement, batch: async (s) => (state.batched += s.length) }, get batched() { return state.batched } }
  }

  it('asks only about the listing with a sum in it', async () => {
    const asked: string[] = []
    const judge: CostJudge = {
      name: 'test',
      read: async (items) => {
        asked.push(...items.map((i) => i.id))
        return items.map(() => ({ quote: 'Bowls are $5 at the door' }))
      },
    }
    const { db } = stubDb()
    const stats = await judgeCosts(db, judge, { budget: 10, now: '2026-09-16T00:00:00.000Z' })

    // "Academy" trips the SQL screen's '%cad%'; the money test is what actually decides.
    expect(asked).toEqual(['a'])
    expect(stats.read).toBe(1)
    expect(stats.paid).toBe(1)
  })

  it('spends nothing when nothing in the batch mentions money', async () => {
    let called = false
    const judge: CostJudge = { name: 'test', read: async () => ((called = true), []) }
    const onlyB = [rows[1]!]
    const statement: D1Statement = {
      bind: () => statement,
      all: async () => ({ results: onlyB }) as { results: never[] },
      run: async () => undefined,
      first: async () => ({ n: 1 }) as never,
    }
    const stats = await judgeCosts({ prepare: () => statement, batch: async () => undefined }, judge, { budget: 10 })
    expect(called).toBe(false)
    expect(stats.read).toBe(0)
  })
})
