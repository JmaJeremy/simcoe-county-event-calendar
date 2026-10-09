import { describe, expect, it } from 'vitest'
import { MAX_SEARCH_LENGTH, UNPLACED, buildQuery, listUrlFrom, parseFilters, savedQueryFrom, searchTerms } from '../src/query.ts'

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
  it('splits a search into words and quoted phrases, each once, and stops at five', () => {
    expect(searchTerms('  pickleball   "farmers market" pickleball ')).toEqual(['pickleball', 'farmers market'])
    expect(searchTerms('a b c d e f g')).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(searchTerms('""  "')).toEqual([])
    expect(searchTerms(undefined)).toEqual([])
  })

  it('requires every term, bound and never interpolated, over the event’s own words', () => {
    const { sql, bindings } = queryFor('?q=pickleball+%22drop+in%22')
    expect(sql.match(/LIKE \? ESCAPE/g)).toHaveLength(2)
    expect(sql).toContain("COALESCE(e.title, '') || char(10) || COALESCE(e.description, '')")
    expect(sql).toContain("COALESCE(m.name, '')")
    expect(bindings.slice(-2)).toEqual(['%pickleball%', '%drop in%'])
    expect(sql).not.toContain('pickleball')
  })

  it('escapes LIKE’s wildcards instead of letting them match anything', () => {
    expect(queryFor('?q=100%25').bindings.at(-1)).toBe('%100\\%%')
    expect(queryFor('?q=a_b').bindings.at(-1)).toBe('%a\\_b%')
    expect(queryFor('?q=a%5Cb').bindings.at(-1)).toBe('%a\\\\b%')
  })

  it('adds nothing for an empty search, and caps a long one', () => {
    expect(queryFor('?q=+++').sql).not.toContain('LIKE')
    expect(filtersFor(`?q=${'x'.repeat(300)}`).q).toHaveLength(MAX_SEARCH_LENGTH)
  })

  it('rides back from an event page and into a saved view, cleaned', () => {
    expect(listUrlFrom(new URL('https://x.invalid/e/abc?q=%20%20jazz%20%20night%20&m=tay'))).toBe('/?m=tay&q=jazz+night')
    expect(savedQueryFrom(new URLSearchParams('q=  Jazz   Night &view=calendar&cat=music'))).toBe('cat=music&q=Jazz+Night')
  })
})
