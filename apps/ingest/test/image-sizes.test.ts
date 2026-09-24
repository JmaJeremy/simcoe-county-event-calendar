import { describe, expect, it } from 'vitest'
import { measureImageSizes, measurePoster } from '../src/image-sizes.ts'
import type { D1Like, D1Statement } from '../src/repository.ts'

/** A 1200x630 PNG header — the first 24 bytes are all the size lives in. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
  0x49, 0x48, 0x44, 0x52, 0, 0, 4, 176, 0, 0, 2, 118,
])

const stubDb = (urls: string[]) => {
  const written: Array<unknown[]> = []
  const statement = (): D1Statement => {
    let bound: unknown[] = []
    const self: D1Statement = {
      bind: (...args: unknown[]) => {
        bound = args
        return self
      },
      all: async () => ({ results: urls.map((url) => ({ url, n: 1 })) }) as never,
      run: async () => ({}),
      first: async () => null as never,
      get bound() {
        return bound
      },
    } as D1Statement & { bound: unknown[] }
    return self
  }
  const db: D1Like = {
    prepare: () => statement(),
    batch: async (statements) => {
      written.push(...statements.map((s) => (s as unknown as { bound: unknown[] }).bound))
    },
  }
  return { db, written }
}

describe('measureImageSizes', () => {
  it('reads a poster from a ranged request and records its size', async () => {
    const asked: Array<{ url: string; range: string | null }> = []
    const { db, written } = stubDb(['https://cdn.example.org/poster.png'])
    const stats = await measureImageSizes(db, {
      budget: 10,
      now: 'T',
      fetchImpl: (async (url: string, init: RequestInit) => {
        asked.push({ url, range: new Headers(init.headers).get('Range') })
        return new Response(PNG, { status: 206 })
      }) as unknown as typeof fetch,
    })
    expect(stats).toEqual({ measured: 1, unreadable: 0, remaining: 0 })
    // Only the head of the file: a poster's full megabyte never crosses the wire.
    expect(asked[0]!.range).toBe('bytes=0-65535')
    expect(written[0]).toEqual(['https://cdn.example.org/poster.png', 1200, 630, 'T'])
  })

  it('records an unreadable image too, so it is not retried every run', async () => {
    const { db, written } = stubDb(['https://cdn.example.org/art.svg'])
    const stats = await measureImageSizes(db, {
      budget: 10,
      now: 'T',
      fetchImpl: (async () => new Response('<svg/>', { status: 200 })) as unknown as typeof fetch,
    })
    expect(stats).toEqual({ measured: 0, unreadable: 1, remaining: 0 })
    expect(written[0]).toEqual(['https://cdn.example.org/art.svg', null, null, 'T'])
  })

  it('survives a host that refuses, and counts what is left over the budget', async () => {
    const { db, written } = stubDb(['a', 'b', 'c'])
    const stats = await measureImageSizes(db, {
      budget: 2,
      now: 'T',
      fetchImpl: (async () => {
        throw new Error('403')
      }) as unknown as typeof fetch,
    })
    expect(stats).toEqual({ measured: 0, unreadable: 2, remaining: 1 })
    expect(written).toHaveLength(2)
  })
})

describe('measurePoster, for a poster a console save just put on an event', () => {
  const db = (known: { width: number | null } | null, opts: { throws?: boolean } = {}) => {
    const written: unknown[][] = []
    const stmt = (sql: string, values: unknown[] = []): any => ({
      bind: (...v: unknown[]) => stmt(sql, v),
      first: async () => {
        if (opts.throws) throw new Error('D1 is down')
        return sql.includes('FROM image_sizes') ? known : null
      },
      run: async () => {
        written.push(values)
        return {}
      },
    })
    return { db: { prepare: (sql: string) => stmt(sql), batch: async () => [] } as unknown as D1Like, written }
  }
  const png = async () => new Response(PNG, { status: 206 })

  it('reads the size and records it', async () => {
    const d = db(null)
    await measurePoster(d.db, 'https://example.org/p.png', { now: 'now', fetchImpl: png as never })
    expect(d.written).toEqual([['https://example.org/p.png', 1200, 630, 'now']])
  })

  it('leaves a measured poster alone, but tries one recorded as unreadable again', async () => {
    let asked = 0
    const counting = (async () => (asked++, new Response(PNG, { status: 206 }))) as never
    await measurePoster(db({ width: 1200 }).db, 'https://example.org/p.png', { fetchImpl: counting })
    expect(asked).toBe(0)
    await measurePoster(db({ width: null }).db, 'https://example.org/p.png', { fetchImpl: counting })
    expect(asked).toBe(1)
  })

  it('skips what can never be a share image, and never throws', async () => {
    let asked = 0
    const counting = (async () => (asked++, new Response(PNG, { status: 206 }))) as never
    await measurePoster(db(null).db, null, { fetchImpl: counting })
    // A govStack calendar host 403s crawlers, so its posters are never share images.
    await measurePoster(db(null).db, 'https://calendar.midland.ca/images/x.jpg', { fetchImpl: counting })
    expect(asked).toBe(0)
    await expect(measurePoster(db(null, { throws: true }).db, 'https://example.org/p.png', { fetchImpl: counting })).resolves.toBeUndefined()
    const refused = db(null)
    await measurePoster(refused.db, 'https://example.org/p.png', { now: 'now', fetchImpl: (async () => new Response('no', { status: 403 })) as never })
    expect(refused.written).toEqual([['https://example.org/p.png', null, null, 'now']])
  })
})
