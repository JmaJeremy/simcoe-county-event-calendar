import { beforeAll, describe, expect, it } from 'vitest'
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose'
import { handleConsole, type ConsoleEnv } from '../src/console.ts'
import ingest from '../src/worker.ts'

/**
 * The console handler end to end, against a database that records what it was asked to
 * do. Access tokens are minted with a local key pair; the checks on them are the real ones.
 */

const HOST = 'console.example.ca'
const TEAM = 'https://example-team.cloudflareaccess.com'
const AUD = 'console-aud'
const UUID = '6f1c1f57-0f7a-4c61-9a7e-0d5c1f2b3a44'
const LISTING_ID = `manual:${UUID}`

let keys: JWTVerifyGetKey
let token: string

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' }] })
  token = await new SignJWT({ email: 'jeremy@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(TEAM)
    .setAudience([AUD])
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(pair.privateKey)
})

const listingRow = (overrides: Record<string, unknown> = {}) => ({
  id: LISTING_ID,
  source_slug: 'manual',
  external_id: UUID,
  municipality_slug: 'tay',
  title: 'Harvest supper',
  description: null,
  category: 'community',
  source_categories: '[]',
  starts_at_utc: '2099-10-03T21:30:00.000Z',
  ends_at_utc: null,
  local_date: '2099-10-03',
  local_time: '17:30',
  timezone: 'America/Toronto',
  time_precision: 'exact',
  all_day: 0,
  venue_name: 'Legion Hall',
  address: null,
  cost: 'unknown',
  cost_text: null,
  organizer: null,
  image_url: null,
  url: '',
  status: 'scheduled',
  active: 1,
  removed_at: null,
  content_hash: 'abc',
  cluster_id: LISTING_ID,
  first_seen_at: '2026-09-15T00:00:00.000Z',
  last_seen_at: '2026-09-15T00:00:00.000Z',
  ...overrides,
})

const eventRow = (overrides: Record<string, unknown> = {}) => ({
  id: LISTING_ID,
  short_code: 'abc1234',
  created_at: '2026-09-15T00:00:00.000Z',
  listing_ids: JSON.stringify([LISTING_ID]),
  listing_count: 1,
  active: 1,
  ...overrides,
})

interface Executed {
  sql: string
  values: unknown[]
}

/** Answers the console's reads from the rows given, and records every write. */
function fakeDb(
  listings: Array<Record<string, unknown>> = [],
  events: Array<Record<string, unknown>> = [],
  suggestions: Array<Record<string, unknown>> = [],
) {
  const executed: Executed[] = []
  const answer = (sql: string, values: unknown[]): unknown[] => {
    if (sql.startsWith('SELECT * FROM suggestions WHERE id = ?')) return suggestions.filter((s) => s.id === values[0])
    if (sql.includes('FROM suggestions ORDER BY')) return suggestions
    if (sql.includes('COUNT(*) AS n FROM suggestions')) return [{ n: suggestions.filter((s) => !s.handled_at).length }]
    if (sql.includes('FROM listings l LEFT JOIN events e')) {
      return listings.map((l) => ({ ...l, event_code: 'abc1234', event_listings: events.find((e) => e.id === l.cluster_id)?.listing_count ?? 1 }))
    }
    if (sql.startsWith('SELECT * FROM listings WHERE id = ?')) return listings.filter((l) => l.id === values[0])
    if (sql.includes('FROM events WHERE id = ?')) return events.filter((e) => e.id === values[0])
    return []
  }
  const statement = (sql: string, values: unknown[] = []): any => ({
    sql,
    values,
    bind: (...bound: unknown[]) => statement(sql, bound),
    all: async () => ({ results: answer(sql, values) }),
    first: async () => answer(sql, values)[0] ?? null,
    run: async () => {
      executed.push({ sql, values })
      return {}
    },
  })
  const db: ConsoleEnv['DB'] = {
    prepare: (sql: string) => statement(sql),
    // Every statement this fake hands out carries its sql and values.
    batch: async (statements: any[]) => {
      for (const s of statements) executed.push({ sql: s.sql, values: s.values })
      return []
    },
  }
  const writes = (fragment: string) => executed.filter((e) => e.sql.includes(fragment))
  return { db, executed, writes }
}

const env = (db: ConsoleEnv['DB'], extra: Partial<ConsoleEnv> = {}): ConsoleEnv => ({
  DB: db,
  CONSOLE_HOST: HOST,
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  PUBLIC_ORIGIN: 'https://site.example.ca',
  ...extra,
})

const SUGGESTION_ID = '0b6c2d7e-5f4a-4e2b-9c1d-3a4b5c6d7e8f'
const POSTER_KEY = `${SUGGESTION_ID}/1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f.jpg`

const suggestionRow = (overrides: Record<string, unknown> = {}) => ({
  id: SUGGESTION_ID,
  kind: 'event',
  name: 'Sam',
  email: 'sam@example.com',
  title: 'Pumpkin walk',
  url: 'https://example.org/pumpkins',
  event_date: '2099-10-25',
  event_time: '18:30',
  description: 'Carved pumpkins along the trail.',
  comments: 'My kid’s school runs it',
  created_at: '2026-09-15T14:00:00.000Z',
  admin_mail: 'sent',
  user_mail: 'sent',
  poster_key: POSTER_KEY,
  poster_type: 'image/jpeg',
  poster_error: null,
  handled_at: null,
  handled_as: null,
  handled_listing_id: null,
  ...overrides,
})

const get = (path: string, headers: Record<string, string> = { 'Cf-Access-Jwt-Assertion': token }) =>
  new Request(`https://${HOST}${path}`, { headers })

const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(`https://${HOST}${path}`, {
    method: 'POST',
    headers: {
      'Cf-Access-Jwt-Assertion': token,
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: `https://${HOST}`,
      'Sec-Fetch-Site': 'same-origin',
      ...headers,
    },
    body: new URLSearchParams(fields),
  })

describe('the Access gate', () => {
  it('refuses a request that did not come through Access, and reads nothing', async () => {
    const { db, executed } = fakeDb([listingRow()])
    const res = await handleConsole(get('/', {}), env(db), keys)
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('Harvest supper')
    expect(executed).toEqual([])
  })

  /* A valid token is not enough for a write: the browser sends Access's cookie with a form
     another site posts, and Access dutifully turns it into a token. */
  it('refuses a cross-site write even with a valid token, and writes nothing', async () => {
    const { db, executed } = fakeDb()
    const res = await handleConsole(
      post('/events', { title: 'Forged', date: '2099-10-03' }, { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }),
      env(db),
      keys,
    )
    expect(res.status).toBe(403)
    expect(executed).toEqual([])
  })

  it('never caches a console page, never lets it be framed, and runs no scripts', async () => {
    const res = await handleConsole(get('/'), env(fakeDb().db), keys)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(await res.text()).not.toContain('<script')
  })
})

describe('creating an event', () => {
  it('stores a manual listing and the event dedup would make of it, then goes back to the list', async () => {
    const { db, writes } = fakeDb()
    const res = await handleConsole(
      post('/events', { title: 'Harvest supper', date: '2099-10-03', start_time: '17:30', municipality: 'tay', cost: 'free' }),
      env(db),
      keys,
    )
    expect(res.status).toBe(303)
    const location = res.headers.get('location')!
    expect(location).toMatch(/^\/\?saved=[0-9a-f-]{36}$/)
    const uuid = location.split('=')[1]!

    // The manual source is registered first: listings reference it and D1 enforces that.
    expect(writes('INSERT INTO sources')[0]!.values[0]).toBe('manual')
    const listing = writes('INSERT INTO listings')[0]!
    expect(listing.values[0]).toBe(`manual:${uuid}`)
    expect(listing.values).toContain('2099-10-03T21:30:00.000Z')
    // Under the listing's own id, so dedup keeps it as this cluster's id from now on.
    expect(writes('INSERT INTO events')[0]!.values[0]).toBe(`manual:${uuid}`)
    expect(writes('UPDATE listings SET cluster_id')[0]!.values).toEqual([`manual:${uuid}`, `manual:${uuid}`])
  })

  it('sends the form back with the problems marked, and writes nothing', async () => {
    const { db, executed } = fakeDb()
    const res = await handleConsole(post('/events', { title: '', date: '2099-10-03', venue: 'Legion Hall' }), env(db), keys)
    expect(res.status).toBe(400)
    const body = await res.text()
    expect(body).toContain('Give the event a title.')
    expect(body).toContain('value="Legion Hall"')
    expect(executed).toEqual([])
  })
})

describe('editing and removing', () => {
  it('rewrites a solo event under its existing id, so its short link never changes', async () => {
    const { db, writes } = fakeDb([listingRow()], [eventRow()])
    const res = await handleConsole(
      post(`/events/${UUID}`, { title: 'Harvest supper (moved)', date: '2099-10-04', start_time: '18:00', municipality: 'tay' }),
      env(db),
      keys,
    )
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`/?saved=${UUID}`)
    expect(writes('INSERT INTO listings')[0]!.values[0]).toBe(LISTING_ID)
    const event = writes('INSERT INTO events')[0]!
    expect(event.values[0]).toBe(LISTING_ID)
    expect(event.values).toContain('Harvest supper (moved)')
  })

  it('leaves a merged event to dedup, and says so', async () => {
    const merged = eventRow({ id: 'tay:99', listing_ids: JSON.stringify([LISTING_ID, 'tay:99']), listing_count: 2 })
    const { db, writes } = fakeDb([listingRow({ cluster_id: 'tay:99' })], [merged])
    const res = await handleConsole(post(`/events/${UUID}`, { title: 'Harvest supper', date: '2099-10-03' }), env(db), keys)
    expect(res.headers.get('location')).toBe(`/?saved=${UUID}&merged=1`)
    expect(writes('INSERT INTO listings')).toHaveLength(1)
    expect(writes('INSERT INTO events')).toEqual([])
  })

  it('keeps a removed event removed when it is edited', async () => {
    const { db, writes } = fakeDb([listingRow({ active: 0 })], [eventRow({ active: 0 })])
    await handleConsole(post(`/events/${UUID}`, { title: 'Harvest supper', date: '2099-10-03' }), env(db), keys)
    expect(writes('UPDATE listings SET active = 0')).toHaveLength(1)
    const event = writes('INSERT INTO events')[0]!
    // `active` is bound just before listing_count, created_at and updated_at.
    expect(event.values.at(-4)).toBe(0)
  })

  it('removes a solo event from the site at once, and restores it', async () => {
    const removed = fakeDb([listingRow()], [eventRow()])
    const res = await handleConsole(post(`/events/${UUID}/remove`, {}), env(removed.db), keys)
    expect(res.headers.get('location')).toBe(`/?removed=${UUID}`)
    expect(removed.writes('UPDATE listings SET active = 0')).toHaveLength(1)
    expect(removed.writes('UPDATE events SET active')[0]!.values.slice(0, 1)).toEqual([0])

    const restored = fakeDb([listingRow({ active: 0 })], [eventRow({ active: 0 })])
    await handleConsole(post(`/events/${UUID}/restore`, {}), env(restored.db), keys)
    expect(restored.writes('UPDATE listings SET active = 1')).toHaveLength(1)
    expect(restored.writes('UPDATE events SET active')[0]!.values.slice(0, 1)).toEqual([1])
  })

  it('lists hand-entered events with a way to edit, view and remove each', async () => {
    const res = await handleConsole(get(`/?saved=${UUID}`), env(fakeDb([listingRow()], [eventRow()]).db), keys)
    const body = await res.text()
    expect(body).toContain('Saved “Harvest supper”')
    expect(body).toContain(`href="/events/${UUID}"`)
    expect(body).toContain('href="https://site.example.ca/e/abc1234"')
    expect(body).toContain(`action="/events/${UUID}/remove"`)
  })

  it('fills the edit form from the stored listing', async () => {
    const res = await handleConsole(get(`/events/${UUID}`), env(fakeDb([listingRow()], [eventRow()]).db), keys)
    const body = await res.text()
    expect(body).toContain('value="Harvest supper"')
    expect(body).toContain('value="17:30"')
    expect(body).toContain('<option value="tay" selected>')
  })

  it('answers 404 for an id that is not a manual listing', async () => {
    expect((await handleConsole(get('/events/not-a-uuid'), env(fakeDb().db), keys)).status).toBe(404)
    expect((await handleConsole(get(`/events/${UUID}`), env(fakeDb().db), keys)).status).toBe(404)
  })
})

describe('suggestions', () => {
  const dismissedRow = suggestionRow({
    id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    title: 'Selling my car',
    poster_key: null,
    handled_at: '2026-09-15T15:00:00.000Z',
    handled_as: 'dismissed',
  })

  it('are counted on the console home page while any are waiting', async () => {
    const res = await handleConsole(get('/'), env(fakeDb([], [], [suggestionRow(), dismissedRow]).db), keys)
    const body = await res.text()
    expect(body).toContain('1 suggestion from the site waiting')
    expect(body).toContain('href="/suggestions"')
  })

  it('are listed waiting first, then done, with their kind and whether a poster came', async () => {
    const res = await handleConsole(get('/suggestions'), env(fakeDb([], [], [dismissedRow, suggestionRow()]).db), keys)
    const body = await res.text()
    expect(body.indexOf('Pumpkin walk')).toBeGreaterThan(body.indexOf('<h2>Waiting</h2>'))
    expect(body.indexOf('Selling my car')).toBeGreaterThan(body.indexOf('<h2>Done</h2>'))
    expect(body.indexOf('<h2>Done</h2>')).toBeGreaterThan(body.indexOf('Pumpkin walk'))
    expect(body).toContain(`href="/suggestions/${SUGGESTION_ID}"`)
    expect(body).toContain('<span class="flag">Poster</span>')
    expect(body).toContain('Dismissed')
  })

  it('open with the poster, everything that was sent, and a way to approve or dismiss', async () => {
    const res = await handleConsole(get(`/suggestions/${SUGGESTION_ID}`), env(fakeDb([], [], [suggestionRow()]).db), keys)
    const body = await res.text()
    expect(body).toContain(`href="/new?from=${SUGGESTION_ID}"`)
    expect(body).toContain(`action="/suggestions/${SUGGESTION_ID}/dismiss"`)
    expect(body).toContain(`<img class="poster" src="/suggestions/${SUGGESTION_ID}/poster"`)
    expect(body).toContain('My kid’s school runs it')
    expect(body).toContain('Sam &lt;sam@example.com&gt;')
    expect(body).not.toContain('<script')
  })

  it('offer no event for a website suggestion, which is a source to add instead', async () => {
    const res = await handleConsole(get(`/suggestions/${SUGGESTION_ID}`), env(fakeDb([], [], [suggestionRow({ kind: 'website' })]).db), keys)
    expect(await res.text()).not.toContain('/new?from=')
  })

  it('never link a stored address that is not a web page', async () => {
    const res = await handleConsole(get(`/suggestions/${SUGGESTION_ID}`), env(fakeDb([], [], [suggestionRow({ url: 'javascript:alert(1)' })]).db), keys)
    expect(await res.text()).not.toContain('href="javascript:')
  })

  it('fill the event form, poster included and comments left out', async () => {
    const res = await handleConsole(get(`/new?from=${SUGGESTION_ID}`), env(fakeDb([], [], [suggestionRow()]).db), keys)
    const body = await res.text()
    for (const value of ['Pumpkin walk', '2099-10-25', '18:30', 'https://example.org/pumpkins', `https://site.example.ca/posters/${POSTER_KEY}`]) {
      expect(body).toContain(`value="${value}"`)
    }
    expect(body).toContain(`<input type="hidden" name="from" value="${SUGGESTION_ID}">`)
    expect(body).toContain('>Carved pumpkins along the trail.</textarea>')
    expect(body).toContain('becomes public when you add this event')
  })

  it('answer 404 when the form is asked to start from one that does not exist', async () => {
    expect((await handleConsole(get(`/new?from=${SUGGESTION_ID}`), env(fakeDb().db), keys)).status).toBe(404)
    expect((await handleConsole(get('/new?from=nope'), env(fakeDb().db), keys)).status).toBe(404)
  })

  it('become an event when the form is saved, and are marked done with the listing they became', async () => {
    const { db, writes } = fakeDb([], [], [suggestionRow()])
    const res = await handleConsole(
      post('/events', { from: SUGGESTION_ID, title: 'Pumpkin walk', date: '2099-10-25', start_time: '18:30', image_url: `https://site.example.ca/posters/${POSTER_KEY}` }),
      env(db),
      keys,
    )
    expect(res.status).toBe(303)
    const location = res.headers.get('location')!
    expect(location).toMatch(/^\/\?saved=[0-9a-f-]{36}&suggestion=1$/)
    const uuid = location.match(/saved=([^&]+)/)![1]
    expect(writes('INSERT INTO listings')[0]!.values).toContain(`https://site.example.ca/posters/${POSTER_KEY}`)
    const [marked] = writes("UPDATE suggestions SET handled_at = ?, handled_as = 'event'")
    expect(marked!.values.slice(1)).toEqual([`manual:${uuid}`, SUGGESTION_ID])
  })

  it('stay attached to a form sent back with problems, and stay waiting', async () => {
    const { db, writes } = fakeDb([], [], [suggestionRow()])
    const res = await handleConsole(post('/events', { from: SUGGESTION_ID, title: '', date: '2099-10-25' }), env(db), keys)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain(`name="from" value="${SUGGESTION_ID}"`)
    expect(writes('UPDATE suggestions')).toEqual([])
  })

  it('can be dismissed, and the dismissal undone', async () => {
    const dismiss = fakeDb([], [], [suggestionRow()])
    const res = await handleConsole(post(`/suggestions/${SUGGESTION_ID}/dismiss`, {}), env(dismiss.db), keys)
    expect(res.headers.get('location')).toBe(`/suggestions?dismissed=${SUGGESTION_ID}`)
    const [dismissed] = dismiss.writes("handled_as = 'dismissed' WHERE id = ? AND handled_at IS NULL")
    expect(dismissed!.values[1]).toBe(SUGGESTION_ID)

    const undo = fakeDb([], [], [dismissedRow])
    await handleConsole(post(`/suggestions/${SUGGESTION_ID}/reopen`, {}), env(undo.db), keys)
    // Only a dismissal can be undone: an approved suggestion's event may be showing its poster.
    expect(undo.writes("WHERE id = ? AND handled_as = 'dismissed'")).toHaveLength(1)
  })

  it('show their poster from the private bucket to a signed-in admin, and never let it be cached', async () => {
    const asked: string[] = []
    const POSTERS = {
      get: async (key: string) => {
        asked.push(key)
        return { body: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])]).stream() }
      },
    }
    const db = fakeDb([], [], [suggestionRow()]).db

    const refused = await handleConsole(get(`/suggestions/${SUGGESTION_ID}/poster`, {}), env(db, { POSTERS }), keys)
    expect(refused.status).toBe(403)
    expect(asked).toEqual([])

    const res = await handleConsole(get(`/suggestions/${SUGGESTION_ID}/poster`), env(db, { POSTERS }), keys)
    expect(res.status).toBe(200)
    expect(asked).toEqual([POSTER_KEY])
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0xff, 0xd8, 0xff, 0xd9])
  })

  it('serve no poster when there is none, or when its stored type is not one of the four images', async () => {
    const POSTERS = { get: async () => ({ body: new Blob(['<html>']).stream() }) }
    const none = fakeDb([], [], [suggestionRow({ poster_key: null, poster_type: null })]).db
    expect((await handleConsole(get(`/suggestions/${SUGGESTION_ID}/poster`), env(none, { POSTERS }), keys)).status).toBe(404)
    const html = fakeDb([], [], [suggestionRow({ poster_type: 'text/html' })]).db
    expect((await handleConsole(get(`/suggestions/${SUGGESTION_ID}/poster`), env(html, { POSTERS }), keys)).status).toBe(404)
  })
})

describe('the ingest worker', () => {
  const ingestEnv = (db: ConsoleEnv['DB']) => ({ ...env(db), INGEST_TOKEN: 'secret' }) as any

  it('hands the console hostname to the console, which demands Access', async () => {
    const res = await ingest.fetch(new Request(`https://${HOST}/`), ingestEnv(fakeDb().db))
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('Cloudflare Access')
  })

  it('never serves the console anywhere else', async () => {
    const res = await ingest.fetch(
      new Request('https://scec-ingest.example.workers.dev/', { headers: { 'Cf-Access-Jwt-Assertion': 'anything' } }),
      ingestEnv(fakeDb().db),
    )
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('console')
  })

  it('still guards /run with the ingest token', async () => {
    const res = await ingest.fetch(new Request('https://scec-ingest.example.workers.dev/run', { method: 'POST' }), ingestEnv(fakeDb().db))
    expect(res.status).toBe(401)
  })
})
