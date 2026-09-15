import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker, { type Env } from '../src/worker.ts'

/**
 * A poster's whole path through the web worker: sent with a suggestion, judged by its
 * bytes, stripped, stored privately, linked from the admin email — and served publicly
 * only once the suggestion is approved. Turnstile's siteverify is stubbed to pass; the
 * database and bucket are fakes that remember what they were given.
 */

const SITE = 'https://outinsimcoe.ca'

/** A small JPEG whose EXIF block names a place, as a phone's would. */
const phoneJpeg = () => {
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))
  const app1 = [...ascii('Exif\0\0MM'), 0, 0x2a, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, ...ascii('GPS 44.6082N 79.4197W')]
  const scan = [1, 1, 0, 0, 63, 0]
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe1, 0, app1.length + 2, ...app1,
    0xff, 0xda, 0, scan.length + 2, ...scan,
    0x12, 0x34, 0x56,
    0xff, 0xd9,
  ])
}

interface Row {
  [column: string]: unknown
}

function harness(options: { putFails?: boolean } = {}) {
  const rows: Row[] = []
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>()
  const mails: Array<{ to: unknown; subject: string; text: string }> = []

  const statement = (sql: string, values: unknown[] = []): any => ({
    bind: (...bound: unknown[]) => statement(sql, bound),
    all: async () => ({ results: [] }),
    first: async () => {
      if (sql.includes('COUNT(*)')) return { n: 0 }
      if (sql.includes('FROM suggestions WHERE poster_key = ?')) {
        const row = rows.find((r) => r.poster_key === values[0] && r.handled_as === 'event')
        return row ? { poster_type: row.poster_type } : null
      }
      return null
    },
    run: async () => {
      if (sql.includes('INSERT INTO suggestions')) {
        const columns = sql.match(/\(([^)]+)\)\s*VALUES/)![1]!.split(',').map((c) => c.trim())
        rows.push(Object.fromEntries(columns.map((c, i) => [c, values[i]])))
      }
      return {}
    },
  })

  const env = {
    DB: { prepare: (sql: string) => statement(sql) },
    ASSETS: { fetch: async () => new Response('asset') },
    CANONICAL_HOST: 'outinsimcoe.ca',
    CONSOLE_ORIGIN: 'https://console.example.ca',
    TURNSTILE_SECRET_KEY: 'secret',
    EMAIL: { send: async (message: any) => void mails.push(message) },
    POSTERS: {
      put: async (key: string, value: Uint8Array, opts: { httpMetadata: { contentType: string } }) => {
        if (options.putFails) throw new Error('bucket unavailable')
        objects.set(key, { bytes: value, contentType: opts.httpMetadata.contentType })
      },
      get: async (key: string) => (objects.has(key) ? { body: new Blob([objects.get(key)!.bytes]).stream() } : null),
    },
  } as unknown as Env

  const submit = (fields: Record<string, string>, poster?: File) => {
    const form = new FormData()
    for (const [key, value] of Object.entries(fields)) form.set(key, value)
    form.set('cf-turnstile-response', 'token')
    if (poster) form.set('poster', poster)
    return worker.fetch(
      new Request(`${SITE}/api/suggest`, { method: 'POST', headers: { Accept: 'application/json', 'CF-Connecting-IP': '203.0.113.9' }, body: form }),
      env,
    )
  }
  const get = (path: string) => worker.fetch(new Request(`${SITE}${path}`), env)
  return { env, rows, objects, mails, submit, get }
}

let siteverify: ReturnType<typeof vi.fn>
beforeEach(() => {
  siteverify = vi.fn(async () => Response.json({ success: true, action: 'suggest', hostname: 'outinsimcoe.ca' }))
  vi.stubGlobal('fetch', siteverify)
})
afterEach(() => vi.unstubAllGlobals())

describe('a poster sent with a suggestion', () => {
  it('is kept without its metadata, typed by its bytes, and linked from the admin email', async () => {
    const h = harness()
    // Declared as a PNG with a PNG name; the bytes say JPEG, and the bytes win.
    const res = await h.submit({ kind: 'event', title: 'Pumpkin walk' }, new File([phoneJpeg()], 'poster.png', { type: 'image/png' }))
    expect(res.status).toBe(200)

    const [row] = h.rows
    expect(row!.poster_key).toMatch(new RegExp(`^${row!.id}/[0-9a-f-]{36}\\.jpg$`))
    expect(row!.poster_type).toBe('image/jpeg')
    expect(row!.poster_error).toBeNull()

    const stored = h.objects.get(row!.poster_key as string)!
    expect(stored.contentType).toBe('image/jpeg')
    expect(String.fromCharCode(...stored.bytes)).not.toContain('GPS')

    const admin = h.mails.find((m) => m.to === 'contact@outinsimcoe.ca')!
    expect(admin.text).toContain(`https://console.example.ca/suggestions/${row!.id}/poster`)
    expect(admin.text).toContain(`https://console.example.ca/suggestions/${row!.id}`)
  })

  it('is enough on its own to make a suggestion', async () => {
    const h = harness()
    expect((await h.submit({ kind: 'event' }, new File([phoneJpeg()], 'p.jpg'))).status).toBe(200)
    expect(h.rows).toHaveLength(1)
  })

  it('is refused when it is not an image, before the bot check is spent, and nothing is kept', async () => {
    const h = harness()
    const res = await h.submit({ kind: 'event', title: 'Fair' }, new File(['<svg onload="alert(1)"/>'], 'poster.jpg', { type: 'image/jpeg' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('JPEG, PNG, GIF or WebP')
    expect(siteverify).not.toHaveBeenCalled()
    expect(h.rows).toEqual([])
    expect(h.objects.size).toBe(0)
  })

  it('is refused when it is over 5 MB', async () => {
    const h = harness()
    const big = new Uint8Array(5 * 1024 * 1024 + 1)
    big.set([0xff, 0xd8, 0xff])
    const res = await h.submit({ kind: 'event', title: 'Fair' }, new File([big], 'huge.jpg'))
    expect(res.status).toBe(413)
    expect(siteverify).not.toHaveBeenCalled()
    expect(h.objects.size).toBe(0)
  })

  it('is ignored on a website suggestion', async () => {
    const h = harness()
    expect((await h.submit({ kind: 'website', url: 'example.org' }, new File([phoneJpeg()], 'p.jpg'))).status).toBe(200)
    expect(h.objects.size).toBe(0)
    expect(h.rows[0]!.poster_key).toBeNull()
  })

  it('costs only itself when storage fails: the suggestion is kept and the email says why', async () => {
    const h = harness({ putFails: true })
    expect((await h.submit({ kind: 'event', title: 'Fair' }, new File([phoneJpeg()], 'p.jpg'))).status).toBe(200)
    expect(h.rows[0]!.poster_key).toBeNull()
    expect(h.rows[0]!.poster_error).toContain('bucket unavailable')
    expect(h.mails.find((m) => m.to === 'contact@outinsimcoe.ca')!.text).toContain('could not be kept')
  })
})

describe('/posters/', () => {
  it('serves nothing until the suggestion is approved as an event, then the stored image', async () => {
    const h = harness()
    await h.submit({ kind: 'event', title: 'Pumpkin walk' }, new File([phoneJpeg()], 'p.jpg'))
    const key = h.rows[0]!.poster_key as string

    expect((await h.get(`/posters/${key}`)).status).toBe(404)

    h.rows[0]!.handled_as = 'dismissed'
    expect((await h.get(`/posters/${key}`)).status).toBe(404)

    h.rows[0]!.handled_as = 'event'
    const res = await h.get(`/posters/${key}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(h.objects.get(key)!.bytes)
  })

  it('answers 404 to anything not shaped like a poster key', async () => {
    const h = harness()
    for (const path of ['/posters/', '/posters/..%2Fsuggestions', '/posters/abc.jpg', '/posters/x/y.svg']) {
      expect((await h.get(path)).status, path).toBe(404)
    }
  })
})
