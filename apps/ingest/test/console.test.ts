import { beforeAll, describe, expect, it } from 'vitest'
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose'
import { shortCode } from '@scec/core'
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
  /** Which db.batch call it arrived in; -1 for a lone run(). */
  batch: number
}

/** Answers the console's reads from the rows given, and records every write. */
function fakeDb(
  listings: Array<Record<string, unknown>> = [],
  events: Array<Record<string, unknown>> = [],
  suggestions: Array<Record<string, unknown>> = [],
  staged: Array<Record<string, unknown>> = [],
) {
  const executed: Executed[] = []
  let batches = 0
  const answer = (sql: string, values: unknown[]): unknown[] => {
    if (sql.includes('LEFT JOIN event_overrides o') && sql.includes('WHERE e.short_code = ?')) return events.filter((e) => e.short_code === values[0])
    if (sql.includes('LEFT JOIN event_overrides o')) return events
    if (sql.startsWith('SELECT * FROM listings WHERE id IN')) return listings.filter((l) => values.includes(l.id))
    if (sql.includes('FROM suggestions s') && sql.includes('WHERE s.id = ?')) return suggestions.filter((s) => s.id === values[0])
    if (sql.includes('FROM suggestions s') && sql.includes('ORDER BY s.created_at')) return suggestions
    if (sql.includes('COUNT(*) AS n FROM suggestions')) return [{ n: suggestions.filter((s) => !s.handled_at).length }]
    if (sql.includes('FROM staged_events s') && sql.includes('WHERE s.id = ?')) return staged.filter((s) => s.id === values[0])
    if (sql.includes('FROM staged_events s')) return staged
    if (sql.includes('COUNT(*) AS n FROM staged_events')) return [{ n: staged.filter((s) => !s.handled_at).length }]
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
      executed.push({ sql, values, batch: -1 })
      return {}
    },
  })
  const db: ConsoleEnv['DB'] = {
    prepare: (sql: string) => statement(sql),
    // Every statement this fake hands out carries its sql and values.
    batch: async (statements: any[]) => {
      const batch = batches++
      for (const s of statements) executed.push({ sql: s.sql, values: s.values, batch })
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

/** A stand-in for the Email Service binding that keeps what it was asked to send. */
function mailer() {
  const sent: any[] = []
  return { sent, EMAIL: { send: async (message: unknown) => void sent.push(message) } }
}

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
    expect(body).toContain(`action="/suggestions/${SUGGESTION_ID}/accept"`)
    expect(body).toContain('emails them to say so')
    expect(body).toContain(`<img class="poster" src="/suggestions/${SUGGESTION_ID}/poster"`)
    expect(body).toContain('My kid’s school runs it')
    expect(body).toContain('Sam &lt;sam@example.com&gt;')
    expect(body).not.toContain('<script')
  })

  it('offer an event for a website suggestion too, noting it may be a source instead', async () => {
    const body = await (await handleConsole(get(`/suggestions/${SUGGESTION_ID}`), env(fakeDb([], [], [suggestionRow({ kind: 'website' })]).db), keys)).text()
    expect(body).toContain(`href="/new?from=${SUGGESTION_ID}"`)
    expect(body).toContain('to plan it as a source, accept it without an event')
  })

  it('offer no event once dismissed, only the way back', async () => {
    const dismissed = suggestionRow({ handled_at: '2026-09-15T04:51:34.112Z', handled_as: 'dismissed' })
    const body = await (await handleConsole(get(`/suggestions/${SUGGESTION_ID}`), env(fakeDb([], [], [dismissed]).db), keys)).text()
    expect(body).not.toContain('/new?from=')
    expect(body).toContain(`action="/suggestions/${SUGGESTION_ID}/reopen"`)
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
    const outbox = mailer()
    const res = await handleConsole(
      post('/events', { from: SUGGESTION_ID, title: 'Pumpkin walk', date: '2099-10-25', start_time: '18:30', image_url: `https://site.example.ca/posters/${POSTER_KEY}` }),
      env(db, { EMAIL: outbox.EMAIL }),
      keys,
    )
    expect(res.status).toBe(303)
    const location = res.headers.get('location')!
    expect(location).toMatch(/^\/\?saved=[0-9a-f-]{36}&suggestion=1&mail=sent$/)
    const uuid = location.match(/saved=([^&]+)/)![1]
    expect(writes('INSERT INTO listings')[0]!.values).toContain(`https://site.example.ca/posters/${POSTER_KEY}`)
    const [marked] = writes("UPDATE suggestions SET handled_at = ?, handled_as = 'event'")
    expect(marked!.values.slice(1)).toEqual([`manual:${uuid}`, SUGGESTION_ID])
    // One batch, one transaction: the event and the approval land together or not at all.
    expect(marked!.batch).toBe(writes('INSERT INTO listings')[0]!.batch)
    expect(marked!.batch).toBe(writes('INSERT INTO events')[0]!.batch)
    // Then the suggester hears, with a link that works because the event is already written.
    expect(outbox.sent).toHaveLength(1)
    expect(outbox.sent[0].to).toBe('sam@example.com')
    expect(outbox.sent[0].replyTo).toBe('contact@outinsimcoe.ca')
    expect(outbox.sent[0].text).toContain(`Pumpkin walk\nhttps://site.example.ca/e/${shortCode(`manual:${uuid}`)}`)
    expect(writes('SET accepted_mail')[0]!.values).toEqual(['sent', SUGGESTION_ID])
  })

  it('stay attached to a form sent back with problems, and stay waiting', async () => {
    const { db, writes } = fakeDb([], [], [suggestionRow()])
    const res = await handleConsole(post('/events', { from: SUGGESTION_ID, title: '', date: '2099-10-25' }), env(db), keys)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain(`name="from" value="${SUGGESTION_ID}"`)
    expect(writes('UPDATE suggestions')).toEqual([])
  })

  it('link an approved one to the public page of the event it became', async () => {
    const approved = suggestionRow({ handled_at: '2026-09-15T16:00:00.000Z', handled_as: 'event', handled_listing_id: LISTING_ID, event_code: 'abc1234' })
    for (const path of ['/suggestions', `/suggestions/${SUGGESTION_ID}`]) {
      const body = await (await handleConsole(get(path), env(fakeDb([], [], [approved]).db), keys)).text()
      expect(body, path).toContain('<a class="flag ok" href="https://site.example.ca/e/abc1234" target="_blank" rel="noopener">Added as an event')
      expect(body, path).toContain(`href="/events/${UUID}"`)
    }
    // Before the event has a short code, the tag is plain text rather than a dead link.
    const pending = suggestionRow({ handled_at: '2026-09-15T16:00:00.000Z', handled_as: 'event', handled_listing_id: LISTING_ID, event_code: null })
    const body = await (await handleConsole(get('/suggestions'), env(fakeDb([], [], [pending]).db), keys)).text()
    expect(body).toContain('<span class="flag ok">Added as an event</span>')
  })

  it('can be accepted without an event, which emails the suggester without a link', async () => {
    const { db, writes } = fakeDb([], [], [suggestionRow()])
    const outbox = mailer()
    const res = await handleConsole(post(`/suggestions/${SUGGESTION_ID}/accept`, {}), env(db, { EMAIL: outbox.EMAIL }), keys)
    expect(res.headers.get('location')).toBe(`/suggestions/${SUGGESTION_ID}?accepted=1&mail=sent`)
    expect(writes("handled_as = 'accepted' WHERE id = ? AND handled_at IS NULL")[0]!.values[1]).toBe(SUGGESTION_ID)
    expect(outbox.sent).toHaveLength(1)
    expect(outbox.sent[0].subject).toBe('Your suggestion was accepted — Out in Simcoe')
    expect(outbox.sent[0].text).not.toContain('/e/')
    // Nothing the visitor typed: the address may not be theirs.
    for (const typed of ['Pumpkin walk', 'Sam', 'Carved pumpkins', 'My kid']) expect(outbox.sent[0].text).not.toContain(typed)
    expect(writes('SET accepted_mail')[0]!.values).toEqual(['sent', SUGGESTION_ID])
  })

  it('tell nobody when there is no address, and never email the same person twice', async () => {
    const none = fakeDb([], [], [suggestionRow({ email: null })])
    const noneBox = mailer()
    const res = await handleConsole(post(`/suggestions/${SUGGESTION_ID}/accept`, {}), env(none.db, { EMAIL: noneBox.EMAIL }), keys)
    expect(res.headers.get('location')).toContain('mail=skipped')
    expect(noneBox.sent).toEqual([])

    const again = fakeDb([], [], [suggestionRow({ accepted_mail: 'sent' })])
    const againBox = mailer()
    const second = await handleConsole(post(`/suggestions/${SUGGESTION_ID}/accept`, {}), env(again.db, { EMAIL: againBox.EMAIL }), keys)
    expect(second.headers.get('location')).toContain('mail=already')
    expect(againBox.sent).toEqual([])
    expect(again.writes('SET accepted_mail')).toEqual([])
  })

  it('stay accepted when the email fails, and keep the reason', async () => {
    const { db, writes } = fakeDb([], [], [suggestionRow()])
    const EMAIL = { send: async () => { throw new Error('destination not allowed') } }
    const res = await handleConsole(post(`/suggestions/${SUGGESTION_ID}/accept`, {}), env(db, { EMAIL }), keys)
    expect(res.headers.get('location')).toContain('mail=failed')
    expect(writes("handled_as = 'accepted'")).toHaveLength(1)
    expect(writes('SET accepted_mail')[0]!.values[0]).toBe('error: destination not allowed')
  })

  it('say what happened after accepting, and offer the way back', async () => {
    const accepted = suggestionRow({ handled_at: '2026-09-15T16:00:00.000Z', handled_as: 'accepted', accepted_mail: 'sent' })
    const body = await (await handleConsole(get(`/suggestions/${SUGGESTION_ID}?accepted=1&mail=sent`), env(fakeDb([], [], [accepted]).db), keys)).text()
    expect(body).toContain('Accepted. We emailed them to say so.')
    expect(body).toContain('<span class="flag ok">Accepted</span>')
    expect(body).toContain(`action="/suggestions/${SUGGESTION_ID}/reopen"`)
    expect(body).toContain('accepted: sent')
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
    expect(undo.writes("handled_as IN ('dismissed', 'accepted')")).toHaveLength(1)
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

describe('finding and editing any event', () => {
  const CODE = 'f00dcaf'
  const SCRAPED = 'tay:fair-2099'
  const scrapedListing = (overrides: Record<string, unknown> = {}) =>
    listingRow({
      id: SCRAPED,
      source_slug: 'tay',
      external_id: 'fair-2099',
      title: 'Waubaushene Fall Fair',
      // Untidy, as scraped text is, and an http poster the form itself would refuse.
      description: 'Rides  and pie.\nAll welcome',
      venue_name: 'Memorial Park',
      url: 'https://tay.ca/fair',
      image_url: 'http://calendar.tay.ca/poster.jpg',
      cost: 'free',
      cluster_id: SCRAPED,
      starts_at_utc: '2099-10-03T14:00:00.000Z',
      local_date: '2099-10-03',
      local_time: '10:00',
      ...overrides,
    })
  const scrapedEvent = (overrides: Record<string, unknown> = {}) => ({
    ...scrapedListing(),
    id: SCRAPED,
    short_code: CODE,
    representative_id: SCRAPED,
    listing_ids: JSON.stringify([SCRAPED]),
    source_slugs: '["tay"]',
    listing_count: 1,
    active: 1,
    created_at: '2026-09-01T00:00:00.000Z',
    override_fields: null,
    override_updated_at: null,
    override_updated_by: null,
    ...overrides,
  })

  const unescape = (value: string) =>
    value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

  /** What a browser would post from the edit form exactly as served. */
  function formFields(html: string): Record<string, string> {
    const start = html.indexOf('class="event-form"')
    const body = html.slice(start, html.indexOf('</form>', start))
    const out: Record<string, string> = {}
    for (const m of body.matchAll(/<input[^>]*\sname="([^"]+)"[^>]*>/g)) out[m[1]!] = unescape(m[0].match(/\svalue="([^"]*)"/)?.[1] ?? '')
    for (const m of body.matchAll(/<select[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
      out[m[1]!] = unescape(m[2]!.match(/<option value="([^"]*)" selected>/)?.[1] ?? m[2]!.match(/<option value="([^"]*)"/)?.[1] ?? '')
    }
    for (const m of body.matchAll(/<textarea[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) out[m[1]!] = unescape(m[2]!)
    return out
  }

  const editForm = async (db: ConsoleEnv['DB']) => formFields(await (await handleConsole(get(`/event/${CODE}`), env(db), keys)).text())

  it('finds events by title, linking each to its editor — a solo hand-entered one to its own', async () => {
    const manual = { ...eventRow(), representative_id: LISTING_ID, title: 'Harvest supper', override_fields: null, source_slugs: '["manual"]' }
    const { db } = fakeDb([scrapedListing(), listingRow()], [scrapedEvent(), manual])
    const body = await (await handleConsole(get('/find?q=fair'), env(db), keys)).text()
    expect(body).toContain(`href="/event/${CODE}"`)
    expect(body).toContain(`href="/events/${UUID}"`)
    expect(body).toContain('value="fair"')
    const pasted = await handleConsole(get(`/find?q=${encodeURIComponent(`https://outinsimcoe.ca/e/${CODE}`)}`), env(db), keys)
    expect(pasted.status).toBe(200)
  })

  it('opens an event with its listings, filled in from what the sources say', async () => {
    const body = await (await handleConsole(get(`/event/${CODE}`), env(fakeDb([scrapedListing()], [scrapedEvent()]).db), keys)).text()
    expect(body).toContain('Listed by')
    expect(body).toContain('href="https://tay.ca/fair"')
    expect(body).toContain('value="Waubaushene Fall Fair"')
    expect(body).toContain('<input type="hidden" name="orig_title" value="Waubaushene Fall Fair">')
    expect(body).toContain('Nothing edited yet')
    expect(body).not.toContain('<script')
  })

  it('sends a solo hand-entered event to its own editor, and answers 404 for an unknown code', async () => {
    const manual = { ...eventRow(), representative_id: LISTING_ID, override_fields: null }
    const res = await handleConsole(get('/event/abc1234'), env(fakeDb([listingRow()], [manual]).db), keys)
    expect(res.headers.get('location')).toBe(`/events/${UUID}`)
    expect((await handleConsole(get('/event/0000000'), env(fakeDb().db), keys)).status).toBe(404)
  })

  /* The discriminating test: a scraped event does not survive the form unchanged (its
     description is untidy, its poster is http), so anything but comparing with what the
     form was filled in with would pin fields nobody touched. */
  it('stores nothing when the form comes back unchanged', async () => {
    const { db, writes } = fakeDb([scrapedListing()], [scrapedEvent()])
    const res = await handleConsole(post(`/event/${CODE}`, await editForm(db)), env(db), keys)
    expect(res.headers.get('location')).toBe(`/event/${CODE}?unchanged=1`)
    expect(writes('event_overrides')).toEqual([])
    expect(writes('INSERT INTO events')).toEqual([])
  })

  it('pins only the field that was edited, and rebuilds the event with it in the same batch', async () => {
    const { db, writes } = fakeDb([scrapedListing()], [scrapedEvent()])
    const fields = await editForm(db)
    const res = await handleConsole(post(`/event/${CODE}`, { ...fields, title: 'Waubaushene Fall Fair 2099' }), env(db), keys)
    expect(res.headers.get('location')).toBe(`/event/${CODE}?saved=title`)
    const [stored] = writes('INSERT INTO event_overrides')
    expect(stored!.values[0]).toBe(SCRAPED)
    expect(JSON.parse(stored!.values[1] as string)).toEqual({ title: 'Waubaushene Fall Fair 2099' })
    expect(stored!.values[3]).toBe('jeremy@example.com')
    const [event] = writes('INSERT INTO events')
    expect(event!.values).toContain('Waubaushene Fall Fair 2099')
    // Everything else still comes from the listing, untidy description and http poster included.
    expect(event!.values).toContain('Memorial Park')
    expect(event!.values).toContain('http://calendar.tay.ca/poster.jpg')
    expect(event!.batch).toBe(stored!.batch)
  })

  it('pins the whole time when only the start time changes', async () => {
    const { db, writes } = fakeDb([scrapedListing()], [scrapedEvent()])
    await handleConsole(post(`/event/${CODE}`, { ...(await editForm(db)), start_time: '11:00' }), env(db), keys)
    const override = JSON.parse(writes('INSERT INTO event_overrides')[0]!.values[1] as string)
    expect(Object.keys(override).sort()).toEqual(['allDay', 'endsAtUtc', 'localDate', 'localTime', 'startsAtUtc', 'timePrecision'])
    expect([override.localTime, override.startsAtUtc]).toEqual(['11:00', '2099-10-03T15:00:00.000Z'])
  })

  it('still refuses a bad value in a field that was edited', async () => {
    const { db, writes } = fakeDb([scrapedListing()], [scrapedEvent()])
    const res = await handleConsole(post(`/event/${CODE}`, { ...(await editForm(db)), image_url: 'http://example.org/new.jpg' }), env(db), keys)
    expect(res.status).toBe(400)
    const body = await res.text()
    expect(body).toContain('Use an https:// image address.')
    expect(body).toContain('name="orig_image_url" value="http://calendar.tay.ca/poster.jpg"')
    expect(writes('event_overrides')).toEqual([])
  })

  it('marks edited fields, and undoes one edit or all of them', async () => {
    const edited = scrapedEvent({ override_fields: JSON.stringify({ title: 'Fair (edited)', venueName: 'Legion Hall' }) })
    const page = await (await handleConsole(get(`/event/${CODE}`), env(fakeDb([scrapedListing()], [edited]).db), keys)).text()
    expect(page).toContain('Edited by hand: Title')
    expect(page).toContain('Title <span class="flag edited">edited</span>')

    const one = fakeDb([scrapedListing()], [edited])
    const res = await handleConsole(post(`/event/${CODE}/clear`, { group: 'title' }), env(one.db), keys)
    expect(res.headers.get('location')).toBe(`/event/${CODE}?cleared=1`)
    expect(JSON.parse(one.writes('INSERT INTO event_overrides')[0]!.values[1] as string)).toEqual({ venueName: 'Legion Hall' })
    expect(one.writes('INSERT INTO events')[0]!.values).toContain('Waubaushene Fall Fair')

    const all = fakeDb([scrapedListing()], [edited])
    await handleConsole(post(`/event/${CODE}/clear`, { group: 'all' }), env(all.db), keys)
    expect(all.writes('DELETE FROM event_overrides')).toHaveLength(1)
  })

  it('hides an event the sources keep publishing, and shows it again', async () => {
    const hide = fakeDb([scrapedListing()], [scrapedEvent()])
    await handleConsole(post(`/event/${CODE}/hide`, {}), env(hide.db), keys)
    expect(JSON.parse(hide.writes('INSERT INTO event_overrides')[0]!.values[1] as string)).toEqual({ active: false })
    // `active` is bound just before listing_count, created_at and updated_at.
    expect(hide.writes('INSERT INTO events')[0]!.values.at(-4)).toBe(0)

    const show = fakeDb([scrapedListing()], [scrapedEvent({ override_fields: '{"active":false}' })])
    await handleConsole(post(`/event/${CODE}/show`, {}), env(show.db), keys)
    expect(show.writes('DELETE FROM event_overrides')).toHaveLength(1)
    expect(show.writes('INSERT INTO events')[0]!.values.at(-4)).toBe(1)
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

/* ------------------------------------------------------- events found in the news */

const STAGED_ID = 'c4e2a1b0-9d8c-4f7e-8a6b-5c4d3e2f1a09'

const stagedRow = (overrides: Record<string, unknown> = {}) => ({
  id: STAGED_ID,
  source_slug: 'barrietoday',
  article_url: 'https://www.barrietoday.com/local-news/baptism-by-fire-12792917',
  article_title: '‘Baptism by fire’: Barrie continues to honour pilots from Battle of Britain',
  article_published_at: '2026-09-19T17:45:00.000Z',
  article_hash: 'h1',
  title: 'Battle of Britain Commemoration',
  title_generated: 0,
  municipality_slug: 'barrie',
  local_date: '2099-09-20',
  local_time: '11:00',
  end_date: null,
  end_time: null,
  venue_name: 'General John Hayter Southshore Community Centre',
  address: null,
  description: null,
  organizer: 'RCAF Association 441 (Huronia) Wing',
  cost: 'unknown',
  cost_text: null,
  url: 'https://www.barrietoday.com/local-news/baptism-by-fire-12792917',
  image_url: null,
  evidence: JSON.stringify({
    date: 'scheduled to take place Sunday at the General John Hayter Southshore Community Centre',
    time: 'which will begin at 11 a.m.',
  }),
  confidence: 0.9,
  notes: 'Annual ceremony, 86th anniversary.',
  created_at: '2026-09-20T06:00:00.000Z',
  handled_at: null,
  handled_as: null,
  handled_listing_id: null,
  ...overrides,
})

describe('the news drafts inbox', () => {
  it('lists what is waiting, with the outlet it came from', async () => {
    const { db } = fakeDb([], [], [], [stagedRow()])
    const response = await handleConsole(get('/staged'), env(db), keys)
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).toContain('Battle of Britain Commemoration')
    expect(body).toContain('barrietoday')
    expect(body).toContain(`/staged/${STAGED_ID}`)
  })

  /**
   * The whole point of the review page: the quotes the scraper checked against the article,
   * and a way to open the article, so the reading can be checked rather than believed.
   */
  it('shows the supporting quotes and a link to the article', async () => {
    const { db } = fakeDb([], [], [], [stagedRow()])
    const body = await (await handleConsole(get(`/staged/${STAGED_ID}`), env(db), keys)).text()
    expect(body).toContain('will begin at 11 a.m.')
    expect(body).toContain('baptism-by-fire-12792917')
    expect(body).toContain(`/new?staged=${STAGED_ID}`)
  })

  it('warns when even the title’s words are nowhere in the article', async () => {
    const { db } = fakeDb([], [], [], [stagedRow({ title_generated: 1 })])
    const body = await (await handleConsole(get(`/staged/${STAGED_ID}`), env(db), keys)).text()
    expect(body).toContain('not in the article’s own words')
  })

  it('pre-fills the event form from a draft, every field of it', async () => {
    const { db } = fakeDb([], [], [], [stagedRow()])
    const body = await (await handleConsole(get(`/new?staged=${STAGED_ID}`), env(db), keys)).text()
    expect(body).toContain('value="Battle of Britain Commemoration"')
    expect(body).toContain('value="2099-09-20"')
    expect(body).toContain('value="11:00"')
    expect(body).toContain('General John Hayter Southshore Community Centre')
    expect(body).toContain('<option value="barrie" selected>')
    // The hidden field is what makes saving the form approve the draft.
    expect(body).toContain(`name="staged" value="${STAGED_ID}"`)
  })

  it('404s on a draft that does not exist', async () => {
    const { db } = fakeDb([], [], [], [])
    expect((await handleConsole(get(`/new?staged=${STAGED_ID}`), env(db), keys)).status).toBe(404)
    expect((await handleConsole(get(`/staged/${STAGED_ID}`), env(db), keys)).status).toBe(404)
  })

  /**
   * The draft and the event it became have to land together. If the listing were written
   * and the draft left waiting, the queue would offer something already on the site, and
   * approving it twice would make two events of one ceremony.
   */
  it('marks the draft done in the same batch as the listing it became', async () => {
    const { db, executed, writes } = fakeDb([], [], [], [stagedRow()])
    const response = await handleConsole(
      post('/events', {
        staged: STAGED_ID,
        title: 'Battle of Britain Commemoration',
        municipality: 'barrie',
        date: '2099-09-20',
        start_time: '11:00',
        venue: 'General John Hayter Southshore Community Centre',
      }),
      env(db),
      keys,
    )
    expect(response.status).toBe(303)
    expect(response.headers.get('Location')).toContain('staged=1')

    const approve = writes('UPDATE staged_events')
    expect(approve).toHaveLength(1)
    expect(approve[0]!.values[1]).toMatch(/^manual:/)
    const listing = executed.find((e) => e.sql.includes('INSERT INTO listings'))
    expect(listing).toBeDefined()
    expect(approve[0]!.batch).toBe(listing!.batch)
  })

  it('writes nothing when the form comes back invalid, and keeps the draft on screen', async () => {
    const { db, executed } = fakeDb([], [], [], [stagedRow()])
    const response = await handleConsole(
      post('/events', { staged: STAGED_ID, title: '', date: '2099-09-20' }),
      env(db),
      keys,
    )
    expect(response.status).toBe(400)
    expect(await response.text()).toContain(`name="staged" value="${STAGED_ID}"`)
    expect(executed.filter((e) => e.sql.includes('INSERT INTO listings'))).toHaveLength(0)
    expect(executed.filter((e) => e.sql.includes('UPDATE staged_events'))).toHaveLength(0)
  })

  it('dismisses a draft, and puts a dismissed one back', async () => {
    const { db, writes } = fakeDb([], [], [], [stagedRow()])
    const dismissed = await handleConsole(post(`/staged/${STAGED_ID}/dismiss`, {}), env(db), keys)
    expect(dismissed.status).toBe(303)
    expect(writes("handled_as = 'dismissed'")[0]!.sql).toContain('handled_at IS NULL')

    const reopened = await handleConsole(post(`/staged/${STAGED_ID}/reopen`, {}), env(db), keys)
    expect(reopened.status).toBe(303)
    // Only a dismissal or a duplicate can be undone: un-approving would orphan a live event.
    expect(writes('handled_at = NULL')[0]!.sql).toContain("handled_as IN ('dismissed', 'duplicate')")
  })

  it('refuses a cross-site dismissal, as it does every other write', async () => {
    const { db, executed } = fakeDb([], [], [], [stagedRow()])
    const request = new Request(`https://${HOST}/staged/${STAGED_ID}/dismiss`, {
      method: 'POST',
      headers: { 'Cf-Access-Jwt-Assertion': token, Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
    })
    expect((await handleConsole(request, env(db), keys)).status).toBe(403)
    expect(executed.filter((e) => e.sql.includes('UPDATE staged_events'))).toHaveLength(0)
  })
})
