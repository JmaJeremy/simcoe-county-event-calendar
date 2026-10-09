import { describe, expect, it } from 'vitest'
import {
  MAX_EVENTS,
  MAX_SEARCH_LENGTH,
  UNPLACED,
  buildQuery,
  listUrlFrom,
  matchesSearch,
  parseFilters,
  savedQueryFrom,
  searchTerms,
  selectEvents,
  type PublicEvent,
} from '../src/query.ts'

const filtersFor = (query: string) => parseFilters(new URL(`https://example.invalid/api/events${query}`))
const queryFor = (query: string) => buildQuery(filtersFor(query))

describe('municipality filter', () => {
  it('binds a plain municipality rather than interpolating it', () => {
    const { sql, bindings } = queryFor('?m=tay')
    expect(sql).toContain('e.municipality_slug IN (?)')
    expect(bindings).toContain('tay')
    expect(sql).not.toContain('tay')
  })

  it('turns the unspecified option into an IS NULL test, with nothing bound', () => {
    const { sql, bindings } = queryFor(`?m=${UNPLACED}`)
    expect(sql).toContain('e.municipality_slug IS NULL')
    expect(sql).not.toContain('municipality_slug IN')
    expect(bindings).not.toContain(UNPLACED)
  })

  it('combines unspecified with real municipalities instead of replacing them', () => {
    const { sql, bindings } = queryFor(`?m=tay,${UNPLACED},barrie`)
    expect(sql).toContain('(e.municipality_slug IN (?,?) OR e.municipality_slug IS NULL)')
    expect(bindings.slice(0, 2)).toEqual(['tay', 'barrie'])
  })

  it('keeps bindings in the order the clauses appear once other filters follow', () => {
    const { sql, bindings } = queryFor(`?m=${UNPLACED},tay&cat=music&from=2026-01-01`)
    const order = [...sql.matchAll(/municipality_slug IN|e\.category IN|local_date >=/g)].map((m) => m[0])
    expect(order).toEqual(['municipality_slug IN', 'e.category IN', 'local_date >='])
    expect(bindings).toEqual(['tay', 'music', '2026-01-01'])
  })

  it('leaves the municipality out of the query entirely when none is chosen', () => {
    expect(queryFor('').sql).not.toContain('municipality_slug IN')
    expect(queryFor('').sql).not.toContain('municipality_slug IS NULL')
  })
})

describe('the way back from an event page', () => {
  const back = (query: string) => listUrlFrom(new URL(`https://example.invalid/e/abc123${query}`))

  it('returns to a plain list when the link carried nothing', () => {
    expect(back('')).toBe('/')
  })

  it('restores the filters, the dates, the view and the month', () => {
    expect(
      back('?m=tay,barrie&cat=music&cost=free&civic=1&past=1&from=2026-09-20&to=2026-09-21&view=calendar&month=2026-10'),
    ).toBe(
      '/?m=tay%2Cbarrie&cat=music&cost=free&civic=1&past=1&from=2026-09-20&to=2026-09-21&view=calendar&month=2026-10',
    )
  })

  it('drops a date that is not a date', () => {
    expect(back('?from=%3Cscript%3E&to=2026-13-99&m=tay')).toBe('/?m=tay')
  })

  it('rebuilds rather than echoes, dropping anything it does not recognise', () => {
    expect(back('?m=tay&evil=%3Cscript%3E&cost=bogus&view=grid&month=nope')).toBe('/?m=tay')
  })

  it('encodes a hostile municipality instead of letting it out raw', () => {
    const href = back('?m=" onmouseover="alert(1)')
    expect(href).not.toContain('"')
    expect(href).not.toContain('<')
  })
})

describe('cost filter', () => {
  it('keeps free and unpriced events by default', () => {
    expect(queryFor('').sql).toContain(`e.cost <> 'paid'`)
  })

  it('narrows to free only', () => {
    expect(queryFor('?cost=free').sql).toContain(`e.cost = 'free'`)
  })

  it('narrows to paid only', () => {
    const { sql } = queryFor('?cost=paid')
    expect(sql).toContain(`e.cost = 'paid'`)
    expect(sql).not.toContain(`e.cost <> 'paid'`)
  })

  it('drops every cost clause when everything is asked for', () => {
    expect(queryFor('?cost=all').sql).not.toContain('e.cost')
  })

  it('falls back to the default for a value it does not know', () => {
    expect(filtersFor('?cost=cheap').cost).toBe('default')
  })

  it('carries paid back from an event page', () => {
    expect(listUrlFrom(new URL('https://x.invalid/e/abc?cost=paid'))).toBe('/?cost=paid')
  })
})

describe('search', () => {
  const event = (over: Partial<PublicEvent>): PublicEvent =>
    ({ title: '', description: null, venueName: null, address: null, organizer: null, municipalityName: null, ...over }) as PublicEvent
  const finds = (q: string, over: Partial<PublicEvent>) => matchesSearch(event(over), searchTerms(q))

  it('splits a search into words and quoted phrases, each once, and stops at five', () => {
    expect(searchTerms('  Pickleball   "Farmers Market" pickleball ')).toEqual(['pickleball', 'farmers market'])
    expect(searchTerms('a b c d e f g')).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(searchTerms('""  "')).toEqual([])
    expect(searchTerms(undefined)).toEqual([])
  })

  it('ignores case and accents, both ways round', () => {
    expect(finds('cafe', { title: 'Café Concert' })).toBe(true)
    expect(finds('CAFÉ', { title: 'cafe concert' })).toBe(true)
    expect(finds('noel', { description: 'Marché de Noël' })).toBe(true)
    expect(finds('MÉTIS', { title: 'Metis Nation gathering' })).toBe(true)
  })

  it('reads a phone’s curly quotes as straight ones, in the search and in the event', () => {
    expect(finds("children's", { title: 'Children’s Story Time' })).toBe(true)
    expect(finds('children’s', { title: "Children's Story Time" })).toBe(true)
    // Smart quotes around a phrase still make it a phrase.
    expect(searchTerms('“farmers market”')).toEqual(['farmers market'])
  })

  it('needs every term, keeps a phrase whole, and never matches across two fields', () => {
    const fair = { title: 'Fall Fair', venueName: 'Fairgrounds', municipalityName: 'Township of Tay' }
    expect(finds('fall tay', fair)).toBe(true)
    expect(finds('fall barrie', fair)).toBe(false)
    expect(finds('"fall fair"', fair)).toBe(true)
    expect(finds('"fair fall"', fair)).toBe(false)
    expect(finds('"fair fairgrounds"', fair)).toBe(false)
  })

  it('takes wildcard characters literally', () => {
    expect(finds('100%', { title: '100% Local Market' })).toBe(true)
    expect(finds('100%', { title: '1000 Islands' })).toBe(false)
    expect(finds('a_b', { title: 'axb' })).toBe(false)
  })

  it('is left out of the SQL, which cannot fold accents, and applied to its results', async () => {
    expect(queryFor('?q=cafe').sql).not.toMatch(/LIKE|cafe/)
    const rows = ['Café Concert', 'Tea Dance', 'Cafe Crawl', 'Internet café night'].map((title, i) => ({ id: `e${i}`, title, listing_ids: '[]', source_slugs: '[]' }))
    let limit = ''
    const db = { prepare: (sql: string) => ((limit = /LIMIT (\d+)/.exec(sql)![1]!), { bind: () => ({ all: async () => ({ results: rows as never[] }) }) }) }
    // The limit is applied to the matches, not to what the search reads.
    expect((await selectEvents(db, filtersFor('?q=cafe'), 2)).map((e) => e.title)).toEqual(['Café Concert', 'Cafe Crawl'])
    // One more than the cap each time: the extra row is how a cut is noticed.
    expect(limit).toBe(String(MAX_EVENTS + 1))
    await selectEvents(db, filtersFor(''), 2)
    expect(limit).toBe('3')
  })

  it('adds nothing for an empty search, and caps a long one', () => {
    expect(filtersFor('?q=+++').q).toBeUndefined()
    expect(filtersFor(`?q=${'x'.repeat(300)}`).q).toHaveLength(MAX_SEARCH_LENGTH)
  })

  it('rides back from an event page and into a saved view, as typed', () => {
    expect(listUrlFrom(new URL('https://x.invalid/e/abc?q=%20%20jazz%20%20night%20&m=tay'))).toBe('/?m=tay&q=jazz+night')
    expect(savedQueryFrom(new URLSearchParams('q=  Café   Night &view=calendar&cat=music'))).toBe('cat=music&q=Caf%C3%A9+Night')
  })
})
