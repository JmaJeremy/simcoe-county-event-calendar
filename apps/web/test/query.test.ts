import { describe, expect, it } from 'vitest'
import { UNPLACED, buildQuery, listUrlFrom, parseFilters } from '../src/query.ts'

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

  it('restores the filters, the view and the month', () => {
    expect(back('?m=tay,barrie&cat=music&cost=free&civic=1&past=1&view=calendar&month=2026-10')).toBe(
      '/?m=tay%2Cbarrie&cat=music&cost=free&civic=1&past=1&view=calendar&month=2026-10',
    )
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
