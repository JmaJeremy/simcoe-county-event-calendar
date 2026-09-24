import { describe, expect, it } from 'vitest'
import worker, { type Env } from '../src/worker.ts'
import { sha256hex } from '../src/auth/session.ts'
import { safeNext } from '../src/auth/routes.ts'
import { openFlow, sealFlow } from '../src/auth/google.ts'
import { D1_MAX_PARAMS, MAX_FILTERS } from '../src/account/store.ts'

/**
 * Pins, saved views, the account page and /api/me (SCEC-106), driven through worker.fetch.
 *
 * Two fakes, one per database, and both THROW on SQL they do not recognise, so a query sent
 * to the wrong database fails here instead of passing. The events fake also records every
 * bind, because the one constraint the application-side join must respect — D1's ceiling of
 * 100 bound parameters — is invisible to a fake that does not check it.
 */

const HOST = 'outinsimcoe.ca'
const SITE = `https://${HOST}`
const TOKEN = 'session-token-for-tests'
const NOW = new Date('2026-10-01T16:00:00Z')

interface EventRow {
  id: string; short_code: string; title: string; local_date: string; local_time: string; all_day: number
  time_precision: string; ends_at_utc: string | null; status: string; active: number; municipality_name: string | null
}

const event = (id: string, over: Partial<EventRow> = {}): EventRow => ({
  id, short_code: `c${id}`, title: `Event ${id}`, local_date: '2026-10-10', local_time: '19:00', all_day: 0,
  time_precision: 'exact', ends_at_utc: null, status: 'scheduled', active: 1, municipality_name: 'Barrie', ...over,
  // The rest of an events row, for the feeds, which build whole events from it.
  ...({ starts_at_utc: `${over.local_date ?? '2026-10-10'}T23:00:00.000Z`, timezone: 'America/Toronto', municipality_slug: 'barrie', category: 'music', cost: 'free', url: 'https://example.invalid', listing_ids: '[]', source_slugs: '[]', representative_id: id } as object),
})

async function harness(events: EventRow[] = []) {
  const users = [
    { id: 'u1', email: 'reader@example.org', email_verified_at: NOW.toISOString(), display_name: null },
    { id: 'u2', email: 'other@example.org', email_verified_at: NOW.toISOString(), display_name: null },
  ]
  const sessions = [{ token_hash: await sha256hex(TOKEN), user_id: 'u1', last_seen_at: NOW.toISOString(), expires_at: '2027-01-01T00:00:00Z' }]
  let pins: Array<{ user_id: string; event_id: string; title: string; local_date: string; short_code: string; pinned_at: string }> = []
  let filters: Array<{ id: string; user_id: string; label: string; query: string; created_at: string }> = []
  const binds: number[] = []
  const calendars: Array<{ user_id: string; calendar_id: string; feed_generation: number; share_slug: string | null }> = []

  const accounts = (sql: string, v: unknown[] = []): any => ({
    bind: (...b: unknown[]) => accounts(sql, b),
    first: async () => {
      if (sql.includes('FROM user_sessions s JOIN users u')) {
        const s = sessions.find((s) => s.token_hash === v[0])
        if (!s) return null
        const u = users.find((u) => u.id === s.user_id)!
        return { user_id: s.user_id, last_seen_at: s.last_seen_at, expires_at: s.expires_at, email: u.email, email_verified_at: u.email_verified_at, display_name: null }
      }
      if (sql.includes('COUNT(*) AS n FROM calendar_pins')) return { n: pins.filter((p) => p.user_id === v[0]).length }
      if (sql.includes('SELECT 1 AS x FROM calendar_pins')) return pins.some((p) => p.user_id === v[0] && p.event_id === v[1]) ? { x: 1 } : null
      if (sql.includes('SELECT id FROM calendar_filters WHERE user_id = ? AND query = ?')) {
        const f = filters.find((f) => f.user_id === v[0] && f.query === v[1])
        return f ? { id: f.id } : null
      }
      if (sql.includes('COUNT(*) AS n FROM calendar_filters')) return { n: filters.filter((f) => f.user_id === v[0]).length }
      if (sql.includes('FROM user_calendars WHERE user_id = ?')) return calendars.find((c) => c.user_id === v[0]) ?? null
      if (sql.includes('FROM user_calendars WHERE calendar_id = ?')) return calendars.find((c) => c.calendar_id === v[0]) ?? null
      if (sql.includes('SELECT user_id FROM user_calendars WHERE share_slug = ?')) {
        const c = calendars.find((c) => c.share_slug !== null && c.share_slug === v[0])
        return c ? { user_id: c.user_id } : null
      }
      throw new Error(`ACCOUNTS: unhandled first(): ${sql}`)
    },
    all: async () => {
      if (sql.includes('FROM calendar_pins WHERE user_id')) {
        return { results: pins.filter((p) => p.user_id === v[0]).sort((a, b) => a.local_date.localeCompare(b.local_date)) }
      }
      if (sql.includes('FROM calendar_filters WHERE user_id')) return { results: filters.filter((f) => f.user_id === v[0]) }
      throw new Error(`ACCOUNTS: unhandled all(): ${sql}`)
    },
    run: async () => {
      if (sql.includes('INSERT INTO calendar_pins')) {
        const existing = pins.find((p) => p.user_id === v[0] && p.event_id === v[1])
        if (existing) Object.assign(existing, { title: v[2], local_date: v[3], short_code: v[4] })
        else pins.push({ user_id: v[0] as string, event_id: v[1] as string, title: v[2] as string, local_date: v[3] as string, short_code: v[4] as string, pinned_at: v[5] as string })
        return {}
      }
      if (sql.includes('DELETE FROM calendar_pins')) {
        pins = pins.filter((p) => !(p.user_id === v[0] && p.event_id === v[1]))
        return {}
      }
      if (sql.includes('UPDATE calendar_pins SET title')) {
        Object.assign(pins.find((p) => p.user_id === v[3] && p.event_id === v[4])!, { title: v[0], local_date: v[1], short_code: v[2] })
        return {}
      }
      if (sql.includes('INSERT INTO calendar_filters')) {
        if (!filters.some((f) => f.user_id === v[1] && f.query === v[3])) {
          filters.push({ id: v[0] as string, user_id: v[1] as string, label: v[2] as string, query: v[3] as string, created_at: v[4] as string })
        }
        return {}
      }
      if (sql.includes('DELETE FROM calendar_filters')) {
        filters = filters.filter((f) => !(f.user_id === v[0] && f.id === v[1]))
        return {}
      }
      if (sql.includes('UPDATE user_sessions SET last_seen_at')) return {}
      if (sql.includes('INSERT INTO user_calendars')) {
        if (!calendars.some((c) => c.user_id === v[0])) calendars.push({ user_id: v[0] as string, calendar_id: v[1] as string, feed_generation: 1, share_slug: null })
        return {}
      }
      if (sql.includes('UPDATE user_calendars SET feed_generation = feed_generation + 1')) {
        const c = calendars.find((c) => c.user_id === v[1])!
        c.feed_generation += 1
        return {}
      }
      if (sql.includes('UPDATE user_calendars SET share_slug = ?')) {
        calendars.find((c) => c.user_id === v[2])!.share_slug = v[0] as string | null
        return {}
      }
      throw new Error(`ACCOUNTS: unhandled run(): ${sql}`)
    },
  })

  const db = (sql: string, v: unknown[] = []): any => ({
    bind: (...b: unknown[]) => {
      binds.push(b.length)
      return db(sql, b)
    },
    all: async () => {
      if (sql.includes('WHERE e.id IN (')) {
        if (v.length > D1_MAX_PARAMS) throw new Error(`D1: too many SQL variables (${v.length})`)
        return { results: events.filter((e) => v.includes(e.id)) }
      }
      if (sql.includes('FROM events e') && sql.includes('ORDER BY e.starts_at_utc')) return { results: [] }
      throw new Error(`DB: unhandled all(): ${sql}`)
    },
    first: async () => {
      throw new Error(`DB: unhandled first(): ${sql}`)
    },
    run: async () => {
      throw new Error(`DB: no write is ever expected: ${sql}`)
    },
  })

  const env = {
    DB: { prepare: (sql: string) => db(sql) },
    ACCOUNTS: { prepare: (sql: string) => accounts(sql) },
    ASSETS: { fetch: async () => new Response('asset') },
    CANONICAL_HOST: HOST,
    PASSWORD_PEPPER: 'pepper',
    FEED_TOKEN_KEY: 'feed-key',
  } as unknown as Env

  const cookie = `__Host-session=${TOKEN}`
  const get = (path: string, signedIn = true, host = HOST) =>
    worker.fetch(new Request(`https://${host}${path}`, { headers: signedIn ? { Cookie: cookie } : {} }), env)
  const post = (path: string, fields: Record<string, string>, opts: { signedIn?: boolean; sameOrigin?: boolean } = {}) =>
    worker.fetch(
      new Request(`${SITE}${path}`, {
        method: 'POST',
        body: new URLSearchParams(fields),
        headers: {
          ...(opts.signedIn === false ? {} : { Cookie: cookie }),
          ...(opts.sameOrigin === false ? { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' } : { Origin: SITE, 'Sec-Fetch-Site': 'same-origin' }),
        },
      }),
      env,
    )
  return { env, get, post, binds, calendars, pins: () => pins, filters: () => filters, setFilters: (f: typeof filters) => (filters = f), setPins: (p: typeof pins) => (pins = p) }
}

describe('/api/me', () => {
  it('is private and uncached, while /api/events stays public — the two helpers, side by side', async () => {
    const h = await harness()
    const me = await h.get('/api/me')
    expect(me.headers.get('Cache-Control')).toBe('private, no-store')
    expect(me.headers.get('Access-Control-Allow-Origin')).toBeNull()
    const events = await h.get('/api/events')
    expect(events.headers.get('Cache-Control')).toMatch(/^public, /)
    expect(events.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  it('says signed out without a session, and on any host but the canonical one', async () => {
    const h = await harness()
    expect(await (await h.get('/api/me', false)).json()).toEqual({ signedIn: false })
    expect(await (await h.get('/api/me', true, 'scec-web.thejeremy-net.workers.dev')).json()).toEqual({ signedIn: false })
  })

  it('lists pins and saved views, and never the address', async () => {
    const h = await harness([event('e1')])
    await h.post('/api/me/pins', { event: 'e1' })
    await h.post('/api/me/filters', { label: 'Music', query: 'cat=music' })
    const body = await (await h.get('/api/me')).json()
    expect(body).toMatchObject({ signedIn: true, pins: ['e1'], filters: [{ label: 'Music', query: 'cat=music' }] })
    expect(JSON.stringify(body)).not.toContain('@')
  })
})

describe('pinning', () => {
  it('pins a live event with a snapshot, and unpins it', async () => {
    const h = await harness([event('e1', { title: 'Santa Claus Parade', local_date: '2026-11-21' })])
    const res = await h.post('/api/me/pins', { event: 'e1' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ pinned: true })
    expect(h.pins()[0]).toMatchObject({ event_id: 'e1', title: 'Santa Claus Parade', local_date: '2026-11-21', short_code: 'ce1' })
    expect(await (await h.post('/api/me/pins', { event: 'e1', pinned: '0' })).json()).toEqual({ pinned: false })
    expect(h.pins()).toEqual([])
  })

  it('refuses a cross-site write, a signed-out one, and an event that is not live', async () => {
    const h = await harness([event('gone', { active: 0 })])
    expect((await h.post('/api/me/pins', { event: 'e1' }, { sameOrigin: false })).status).toBe(403)
    expect((await h.post('/api/me/pins', { event: 'e1' }, { signedIn: false })).status).toBe(401)
    expect((await h.post('/api/me/pins', { event: 'nope' })).status).toBe(404)
    expect((await h.post('/api/me/pins', { event: 'gone' })).status).toBe(404)
    expect(h.pins()).toEqual([])
  })

  it('unpins an event that no longer exists, without asking the events database', async () => {
    const h = await harness()
    h.setPins([{ user_id: 'u1', event_id: 'gone', title: 'Old', local_date: '2026-10-05', short_code: 'x', pinned_at: '' }])
    expect((await h.post('/api/me/pins', { event: 'gone', pinned: '0' })).status).toBe(200)
    expect(h.pins()).toEqual([])
    expect(h.binds).toEqual([])
  })
})

describe('saving a view', () => {
  it('keeps what the view selects, in canonical form, and nothing about how it was shown', async () => {
    const h = await harness()
    const res = await h.post('/api/me/filters', { label: '  Music   nights ', query: 'view=calendar&month=2026-10&cat=music,bogus&m=orillia,barrie,nowhere&past=1' })
    expect(await res.json()).toMatchObject({ saved: true, query: 'm=barrie%2Corillia&cat=music' })
    expect(h.filters()[0]).toMatchObject({ label: 'Music nights', query: 'm=barrie%2Corillia&cat=music' })
  })

  it('saves the same view once, refuses an empty or long label, and stops at the cap', async () => {
    const h = await harness()
    const a = await (await h.post('/api/me/filters', { label: 'A', query: 'cat=music' })).json()
    const b = await (await h.post('/api/me/filters', { label: 'B', query: 'cat=music' })).json()
    expect(b.id).toBe(a.id)
    expect(h.filters()).toHaveLength(1)
    expect((await h.post('/api/me/filters', { label: ' ', query: 'cat=arts' })).status).toBe(400)
    expect((await h.post('/api/me/filters', { label: 'x'.repeat(61), query: 'cat=arts' })).status).toBe(400)
    h.setFilters(Array.from({ length: MAX_FILTERS }, (_, i) => ({ id: `f${i}`, user_id: 'u1', label: 'x', query: `from=2026-10-${String(i + 1).padStart(2, '0')}`, created_at: '' })))
    expect((await h.post('/api/me/filters', { label: 'One more', query: 'cat=arts' })).status).toBe(409)
  })
})

describe('the account page', () => {
  it('shows upcoming pins, withdrawn ones by their snapshot, and past ones folded away', async () => {
    const h = await harness([event('live', { title: 'Fall Fair' }), event('old', { title: 'Summer Show', local_date: '2026-08-01' })])
    h.setPins([
      { user_id: 'u1', event_id: 'live', title: 'Fall Fair', local_date: '2026-10-10', short_code: 'clive', pinned_at: '' },
      { user_id: 'u1', event_id: 'moved', title: 'Harvest Supper', local_date: '2026-10-20', short_code: 'x', pinned_at: '' },
      { user_id: 'u1', event_id: 'old', title: 'Summer Show', local_date: '2026-08-01', short_code: 'cold', pinned_at: '' },
    ])
    const res = await h.get('/account')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const html = await res.text()
    expect(html).toContain('<a href="/e/clive">Fall Fair</a>')
    expect(html).toMatch(/No longer listed<\/h3>[\s\S]*Harvest Supper/)
    expect(html).toMatch(/<details class="pin-past"><summary>Past \(1\)<\/summary>[\s\S]*Summer Show/)
  })

  it('refreshes a snapshot whose event changed, so a later withdrawal names it correctly', async () => {
    const h = await harness([event('e1', { title: 'Parade (new route)', local_date: '2026-11-22' })])
    h.setPins([{ user_id: 'u1', event_id: 'e1', title: 'Parade', local_date: '2026-11-21', short_code: 'ce1', pinned_at: '' }])
    await h.get('/account')
    expect(h.pins()[0]).toMatchObject({ title: 'Parade (new route)', local_date: '2026-11-22' })
  })

  it('joins two hundred pins in chunks the events database will accept', async () => {
    const ids = Array.from({ length: 230 }, (_, i) => `e${i}`)
    const h = await harness(ids.map((id) => event(id)))
    h.setPins(ids.map((id) => ({ user_id: 'u1', event_id: id, title: `Event ${id}`, local_date: '2026-10-10', short_code: `c${id}`, pinned_at: '' })))
    const html = await (await h.get('/account')).text()
    expect(h.binds.length).toBe(3)
    expect(Math.max(...h.binds)).toBeLessThanOrEqual(D1_MAX_PARAMS)
    for (const id of ids) expect(html).toContain(`/e/c${id}"`)
  })

  it('escapes a saved view’s label, and describes what it selects', async () => {
    const h = await harness()
    h.setFilters([{ id: 'f1', user_id: 'u1', label: '<script>x</script>', query: 'm=barrie&cat=music&cost=free&from=2026-10-01', created_at: '' }])
    const html = await (await h.get('/account')).text()
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('Barrie · Music · Free only · from ')
  })

  it('removes a pin and a saved view from its own forms — only the reader’s own', async () => {
    const h = await harness()
    h.setPins([{ user_id: 'u1', event_id: 'e1', title: 'A', local_date: '2026-10-10', short_code: 'c', pinned_at: '' }])
    h.setFilters([
      { id: 'mine', user_id: 'u1', label: 'Mine', query: 'cat=arts', created_at: '' },
      { id: 'theirs', user_id: 'u2', label: 'Theirs', query: 'cat=arts', created_at: '' },
    ])
    expect((await h.post('/account/pins/remove', { event: 'e1' })).headers.get('Location')).toBe('/account?notice=unpinned')
    await h.post('/account/filters/remove', { id: 'theirs' })
    await h.post('/account/filters/remove', { id: 'mine' })
    expect(h.pins()).toEqual([])
    expect(h.filters().map((f) => f.id)).toEqual(['theirs'])
  })
})

describe('coming back after signing in', () => {
  it('accepts only a path on this site', () => {
    expect(safeNext('/e/abc?m=barrie')).toBe('/e/abc?m=barrie')
    expect(safeNext('/')).toBe('/')
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'e/abc', '/a b', '/a\nb', '', null, `/${'x'.repeat(600)}`]) {
      expect(safeNext(bad), String(bad)).toBeNull()
    }
  })

  it('carries the return path in the sign-in form and through Google’s sealed flow', async () => {
    const h = await harness()
    const html = await (await h.get('/account/signin?next=%2Fe%2Fabc', false)).text()
    expect(html).toContain('<input type="hidden" name="next" value="/e/abc">')
    expect(await (await h.get('/account/signin?next=%2F%2Fevil.example', false)).text()).not.toContain('name="next"')
    const flow = { state: 's', nonce: 'n', verifier: 'v', expires: 10, next: '/e/abc?m=tay' }
    expect(await openFlow(await sealFlow(flow, 'k'), 'k', 0)).toEqual(flow)
  })

  it('sends a signed-in reader straight on', async () => {
    const h = await harness()
    expect((await h.get('/account/signin?next=%2Fe%2Fabc')).headers.get('Location')).toBe('/e/abc')
  })
})

describe('your calendar: the private feed and the share link', () => {
  const feedUrlFrom = (html: string) => /id="feed-url" type="text" readonly value="([^"]+)"/.exec(html)?.[1]
  const shareUrlFrom = (html: string) => /id="share-url" type="text" readonly value="([^"]+)"/.exec(html)?.[1]
  const pinned = (h: Awaited<ReturnType<typeof harness>>, ...ids: string[]) =>
    h.setPins(ids.map((id) => ({ user_id: 'u1', event_id: id, title: `Event ${id}`, local_date: '2026-10-10', short_code: `c${id}`, pinned_at: '' })))

  it('shows the same private feed link on every visit, and serves the live pins through it', async () => {
    const h = await harness([event('e1', { title: 'Fall Fair' }), event('gone', { active: 0 })])
    pinned(h, 'e1', 'gone')
    const first = feedUrlFrom(await (await h.get('/account')).text())!
    expect(first).toMatch(/^https:\/\/outinsimcoe\.ca\/calendar\/[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\.ics$/)
    expect(feedUrlFrom(await (await h.get('/account')).text())).toBe(first)

    const res = await h.get(new URL(first).pathname, false)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/calendar')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
    const body = await res.text()
    expect(body.match(/BEGIN:VEVENT/g)).toHaveLength(1)
    expect(body).toContain('SUMMARY:Fall Fair')
    // The same UID the public feed gives the event, so a reader subscribed to both sees one.
    expect(body).toContain('UID:e1@outinsimcoe.ca')
  })

  it('opens nothing for a forged or stale token, and a new link retires the old one', async () => {
    const h = await harness([event('e1')])
    pinned(h, 'e1')
    const old = new URL(feedUrlFrom(await (await h.get('/account')).text())!).pathname
    const forged = old.replace(/\.([A-Za-z0-9_-])/, (_, c) => `.${c === 'A' ? 'B' : 'A'}`)
    expect((await h.get(forged, false)).status).toBe(404)
    expect((await h.get('/calendar/nonsense.ics', false)).status).toBe(404)

    const rotated = await h.post('/account/calendar/rotate', {})
    expect(rotated.headers.get('Location')).toBe('/account?notice=feed-rotated#calendar')
    expect((await h.get(old, false)).status).toBe(404)
    const fresh = new URL(feedUrlFrom(await (await h.get('/account')).text())!).pathname
    expect(fresh).not.toBe(old)
    expect((await h.get(fresh, false)).status).toBe(200)
  })

  it('offers no private feed without FEED_TOKEN_KEY, and serves none', async () => {
    const h = await harness([event('e1')])
    pinned(h, 'e1')
    ;(h.env as { FEED_TOKEN_KEY?: string }).FEED_TOKEN_KEY = undefined
    const html = await (await h.get('/account')).text()
    expect(feedUrlFrom(html)).toBeUndefined()
    expect(html).toContain('Calendar feeds are not available right now.')
  })

  it('shares the upcoming pins at a separate link, anonymously, and stops at once', async () => {
    const h = await harness([event('e1', { title: 'Fall Fair' }), event('old', { title: 'Summer Show', local_date: '2026-08-01' })])
    pinned(h, 'e1', 'old')
    expect(shareUrlFrom(await (await h.get('/account')).text())).toBeUndefined()

    await h.post('/account/calendar/share', { on: '1' })
    const html = await (await h.get('/account')).text()
    const share = shareUrlFrom(html)!
    const feed = feedUrlFrom(html)!
    expect(share).toMatch(/^https:\/\/outinsimcoe\.ca\/c\/[A-Za-z0-9_-]{16}$/)
    // The public link must carry nothing of the private one.
    const calendarId = new URL(feed).pathname.split('/')[2]!.split('.')[0]!
    expect(share).not.toContain(calendarId)

    const page = await h.get(new URL(share).pathname, false)
    expect(page.headers.get('Cache-Control')).toBe('private, no-store')
    expect(page.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
    const shown = await page.text()
    expect(shown).toContain('Fall Fair')
    expect(shown).not.toContain('Summer Show')
    expect(shown).not.toContain('reader@example.org')
    expect(shown).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/)
    expect((await h.get(`${new URL(share).pathname}.ics`, false)).headers.get('Content-Type')).toContain('text/calendar')

    await h.post('/account/calendar/share', { on: '0' })
    expect((await h.get(new URL(share).pathname, false)).status).toBe(404)
    expect((await h.get(`${new URL(share).pathname}.ics`, false)).status).toBe(404)
    await h.post('/account/calendar/share', { on: '1' })
    const again = shareUrlFrom(await (await h.get('/account')).text())!
    expect(again).not.toBe(share)
    expect((await h.get(new URL(share).pathname, false)).status).toBe(404)
  })

  it('refuses a cross-site request to change either link', async () => {
    const h = await harness()
    await h.get('/account')
    expect((await h.post('/account/calendar/share', { on: '1' }, { sameOrigin: false })).status).toBe(403)
    expect((await h.post('/account/calendar/rotate', {}, { sameOrigin: false })).status).toBe(403)
    expect(h.calendars[0]).toMatchObject({ feed_generation: 1, share_slug: null })
  })

  it('gives each saved view its public feed', async () => {
    const h = await harness()
    h.setFilters([{ id: 'f1', user_id: 'u1', label: 'Music', query: 'cat=music', created_at: '' }])
    expect(await (await h.get('/account')).text()).toContain('href="webcal://outinsimcoe.ca/calendar.ics?cat=music"')
  })
})
