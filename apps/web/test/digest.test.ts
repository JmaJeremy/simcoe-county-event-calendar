import { describe, expect, it } from 'vitest'
import worker, { type Env } from '../src/worker.ts'
import { DIGESTS_PER_DAY, PER_VIEW, runDigests, sendDigest, siteClock } from '../src/account/digest.ts'
import { sha256hex } from '../src/auth/session.ts'
import { INGEST_MIGRATIONS, WEB_MIGRATIONS, sqliteD1 } from './d1-sqlite.ts'

/**
 * Email digests (SCEC-109), against real SQLite with both databases' real migrations: the
 * sender's eligibility query, its claim and its budget are SQL, and SQL is what these check.
 *
 * NOW is Thursday 15 October 2026, 12:10 UTC — 08:10 in Simcoe County (EDT).
 */
const NOW = new Date('2026-10-15T12:10:00Z')
const HOST = 'outinsimcoe.ca'
const STAMP = '2026-10-01T00:00:00Z'

interface Mail {
  to: string
  subject: string
  text: string
  headers?: Record<string, string>
}

function world() {
  const accounts = sqliteD1(WEB_MIGRATIONS)
  const events = sqliteD1(INGEST_MIGRATIONS)
  const mails: Mail[] = []
  events.exec(`INSERT OR IGNORE INTO municipalities (slug, name, short_name, level) VALUES ('barrie', 'City of Barrie', 'Barrie', 'city'), ('orillia', 'City of Orillia', 'Orillia', 'city')`)

  let n = 0
  const event = (over: { title: string; date?: string; m?: string; category?: string; cost?: string; active?: number }) => {
    const id = `ev${++n}`
    const date = over.date ?? '2026-10-15'
    events.exec(
      `INSERT INTO events (id, short_code, representative_id, listing_ids, source_slugs, municipality_slug, title, category,
                           starts_at_utc, local_date, local_time, timezone, url, cost, active, created_at, updated_at)
       VALUES (?, ?, ?, '[]', '["test"]', ?, ?, ?, ?, ?, '19:00', 'America/Toronto', 'https://example.invalid', ?, ?, ?, ?)`,
      id, `c${n}`, id, over.m ?? 'barrie', over.title, over.category ?? 'music', `${date}T23:00:00.000Z`, date, over.cost ?? 'free', over.active ?? 1, STAMP, STAMP,
    )
    return id
  }

  const user = (id: string, opts: { verified?: boolean; digest?: string; hour?: number; day?: number } = {}) => {
    accounts.exec(`INSERT INTO users (id, email, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      id, `${id}@example.org`, opts.verified === false ? null : STAMP, STAMP, STAMP)
    accounts.exec(`INSERT INTO user_calendars (user_id, calendar_id, created_at, updated_at, digest, digest_hour, digest_day) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, `${id}`.padEnd(22, 'x'), STAMP, STAMP, opts.digest ?? 'daily', opts.hour ?? 8, opts.day ?? 4)
  }
  const pin = (userId: string, eventId: string) =>
    accounts.exec(`INSERT INTO calendar_pins (user_id, event_id, title, local_date, short_code, pinned_at) VALUES (?, ?, 'snapshot', '2026-10-15', 'x', ?)`, userId, eventId, STAMP)
  const view = (userId: string, label: string, query: string) =>
    accounts.exec(`INSERT INTO calendar_filters (id, user_id, label, query, created_at) VALUES (?, ?, ?, ?, ?)`, `${userId}:${label}`, userId, label, query, STAMP)

  const env = {
    DB: events,
    ACCOUNTS: accounts,
    ASSETS: { fetch: async () => new Response('asset') },
    CANONICAL_HOST: HOST,
    PASSWORD_PEPPER: 'pepper',
    FEED_TOKEN_KEY: 'feed-key',
    EMAIL: { send: async (m: Mail) => void mails.push(m) },
  } as unknown as Env
  const sends = () => accounts.rows<{ user_id: string; period_key: string; outcome: string; event_count: number }>('SELECT user_id, period_key, outcome, event_count FROM digest_sends ORDER BY user_id')
  return { accounts, events, mails, env, event, user, pin, view, sends }
}

describe('the site clock', () => {
  it('reads Simcoe County time across daylight saving, and never calls midnight 24', () => {
    expect(siteClock(new Date('2026-07-01T12:00:00Z'))).toEqual({ date: '2026-07-01', hour: 8, weekday: 3 })
    expect(siteClock(new Date('2026-12-01T13:00:00Z'))).toEqual({ date: '2026-12-01', hour: 8, weekday: 2 })
    expect(siteClock(new Date('2026-07-02T04:30:00Z')).hour).toBe(0)
  })
})

describe('who gets a digest, and when', () => {
  it('sends to verified readers whose hour has come, once per period', async () => {
    const w = world()
    const fair = w.event({ title: 'Fall Fair' })
    for (const [id, opts] of [
      ['due', {}],
      ['later', { hour: 9 }],
      ['unverified', { verified: false }],
      ['off', { digest: 'none' }],
      ['weekly-thu', { digest: 'weekly', day: 4 }],
      ['weekly-mon', { digest: 'weekly', day: 1 }],
    ] as const) {
      w.user(id, opts)
      w.pin(id, fair)
    }
    const run = await runDigests(w.env, NOW)
    expect(run).toMatchObject({ due: 2, sent: 2 })
    expect(w.mails.map((m) => m.to).sort()).toEqual(['due@example.org', 'weekly-thu@example.org'])
    expect(w.sends().map((s) => `${s.user_id} ${s.period_key} ${s.outcome}`)).toEqual(['due d:2026-10-15 sent', 'weekly-thu w:2026-10-15 sent'])

    // The same hour again: nothing twice.
    expect(await runDigests(w.env, NOW)).toMatchObject({ due: 0, sent: 0 })
    // Two hours on, the 9 o'clock reader is caught up — due once their hour HAS COME.
    expect(await runDigests(w.env, new Date('2026-10-15T14:10:00Z'))).toMatchObject({ due: 1, sent: 1 })
    expect(w.mails.at(-1)!.to).toBe('later@example.org')
    expect(w.mails).toHaveLength(3)
  })

  it('records an empty window and sends nothing', async () => {
    const w = world()
    w.user('quiet')
    w.pin('quiet', w.event({ title: 'Next week', date: '2026-10-22' }))
    expect(await runDigests(w.env, NOW)).toMatchObject({ due: 1, sent: 0, empty: 1 })
    expect(w.mails).toEqual([])
    expect(w.sends()[0]).toMatchObject({ outcome: 'skipped-empty' })
  })

  it('stops at the daily budget, which leaves room for mail people are waiting for', async () => {
    const w = world()
    const fair = w.event({ title: 'Fall Fair' })
    w.user('filler', { digest: 'none' })
    for (let i = 0; i < DIGESTS_PER_DAY - 2; i++) {
      w.accounts.exec(`INSERT INTO digest_sends (user_id, period_key, outcome, created_at) VALUES ('filler', ?, 'sent', ?)`, `d${i}:2026-10-15`, '2026-10-15T05:00:00.000Z')
    }
    // Yesterday's sends, by the Simcoe County day, spend none of today's budget.
    w.accounts.exec(`INSERT INTO digest_sends (user_id, period_key, outcome, created_at) VALUES ('filler', 'd:2026-10-14', 'sent', '2026-10-15T01:00:00.000Z')`)
    for (const id of ['a', 'b', 'c', 'd']) {
      w.user(id)
      w.pin(id, fair)
    }
    expect(await runDigests(w.env, NOW)).toMatchObject({ sent: 2 })
    expect(await runDigests(w.env, new Date('2026-10-15T13:10:00Z'))).toMatchObject({ skipped: 'daily budget spent' })
    expect(w.mails).toHaveLength(2)
  })

  it('sends nothing without the key that signs the unsubscribe link', async () => {
    const w = world()
    w.user('a')
    w.pin('a', w.event({ title: 'Fall Fair' }))
    ;(w.env as { FEED_TOKEN_KEY?: string }).FEED_TOKEN_KEY = undefined
    expect(await runDigests(w.env, NOW)).toMatchObject({ skipped: 'not configured' })
    expect(w.mails).toEqual([])
  })
})

describe('what a digest says', () => {
  it('lists pins first, each event once, a saved view’s overflow as a link, and no address anywhere', async () => {
    const w = world()
    const fair = w.event({ title: 'Fall Fair' })
    for (let i = 0; i < PER_VIEW + 3; i++) w.event({ title: `Orillia concert ${i}`, m: 'orillia' })
    w.event({ title: 'Barrie jazz' })
    w.event({ title: 'Ticketed gala', cost: 'paid' })
    w.event({ title: 'Withdrawn show', active: 0 })
    w.user('reader')
    w.pin('reader', fair)
    w.view('reader', 'Barrie music', 'm=barrie&cat=music')
    w.view('reader', 'Orillia', 'm=orillia')
    await runDigests(w.env, NOW)

    const [mail] = w.mails
    expect(mail!.subject).toBe('Today on Out in Simcoe: Thursday, October 15, 2026')
    const text = mail!.text
    expect(text.indexOf('YOUR PINNED EVENTS')).toBeLessThan(text.indexOf('BARRIE MUSIC'))
    // Pinned, and also a Barrie music event: listed once, under the pins.
    expect(text.match(/Fall Fair/g)).toHaveLength(1)
    expect(text).toContain('Barrie jazz')
    expect(text).not.toContain('Ticketed gala')
    expect(text).not.toContain('Withdrawn show')
    expect(text.match(/Orillia concert/g)).toHaveLength(PER_VIEW)
    expect(text).toContain('See all: https://outinsimcoe.ca/?m=orillia&from=2026-10-15&to=2026-10-15')
    expect(text).toMatch(/https:\/\/outinsimcoe\.ca\/e\/c1\b/)
    expect(text).not.toContain('@')
    expect(w.sends()[0]!.event_count).toBe(2 + PER_VIEW)
  })

  it('carries a one-click unsubscribe the mail provider can POST to, and a link that does the same', async () => {
    const w = world()
    w.user('reader')
    w.pin('reader', w.event({ title: 'Fall Fair' }))
    await runDigests(w.env, NOW)
    const { headers, text } = w.mails[0]!
    expect(headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    const url = /^<(https:\/\/outinsimcoe\.ca\/unsubscribe\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43})>$/.exec(headers!['List-Unsubscribe']!)![1]!
    expect(text).toContain(`Unsubscribe with one click: ${url}`)

    // The provider's POST: no Origin, no session.
    const post = await worker.fetch(new Request(url, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }), w.env)
    expect(post.status).toBe(200)
    expect(w.accounts.rows<{ digest: string }>(`SELECT digest FROM user_calendars WHERE user_id = 'reader'`)[0]!.digest).toBe('none')

    // The link in the body works too, and says so; a forged one does nothing.
    w.accounts.exec(`UPDATE user_calendars SET digest = 'daily' WHERE user_id = 'reader'`)
    const forged = url.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))
    expect((await worker.fetch(new Request(forged), w.env)).status).toBe(404)
    expect(w.accounts.rows<{ digest: string }>(`SELECT digest FROM user_calendars WHERE user_id = 'reader'`)[0]!.digest).toBe('daily')
    const page = await worker.fetch(new Request(url), w.env)
    expect(page.status).toBe(200)
    expect(page.headers.get('Cache-Control')).toBe('no-store')
    expect(await page.text()).toContain('You are unsubscribed')
    expect(w.accounts.rows<{ digest: string }>(`SELECT digest FROM user_calendars WHERE user_id = 'reader'`)[0]!.digest).toBe('none')
  })

  it('does not send once the reader has unsubscribed, even if they were already due', async () => {
    const w = world()
    w.user('reader')
    w.pin('reader', w.event({ title: 'Fall Fair' }))
    w.accounts.exec(`UPDATE user_calendars SET digest = 'none' WHERE user_id = 'reader'`)
    expect(await runDigests(w.env, NOW)).toMatchObject({ due: 0, sent: 0 })
    // And past the query: the claim itself re-checks the setting, so an unsubscribe landing
    // between the sender's SELECT and its send still wins.
    const reader = { userId: 'reader', calendarId: 'reader'.padEnd(22, 'x'), email: 'reader@example.org' }
    expect(await sendDigest(w.env as never, reader, 'daily', 'd:2026-10-15', '2026-10-15', NOW, `https://${HOST}`)).toBe('already')
    expect(w.mails).toEqual([])
    expect(w.sends()).toEqual([])
  })
})

describe('the account page’s digest controls', () => {
  async function signedIn(w: ReturnType<typeof world>) {
    w.user('reader', { digest: 'none' })
    w.accounts.exec(`INSERT INTO user_sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, 'reader', ?, ?, '2099-01-01T00:00:00Z')`,
      await sha256hex('tok'), new Date().toISOString(), new Date().toISOString())
    return (path: string, fields?: Record<string, string>) =>
      worker.fetch(
        new Request(`https://${HOST}${path}`, fields
          ? { method: 'POST', body: new URLSearchParams(fields), headers: { Cookie: '__Host-session=tok', Origin: `https://${HOST}`, 'Sec-Fetch-Site': 'same-origin' } }
          : { headers: { Cookie: '__Host-session=tok' } }),
        w.env,
      )
  }

  it('saves a cadence, hour and day, refusing values the form does not offer', async () => {
    const w = world()
    const go = await signedIn(w)
    expect((await go('/account/digest', { digest: 'weekly', hour: '7', day: '5' })).headers.get('Location')).toBe('/account?notice=digest-saved#digest')
    expect(w.accounts.rows(`SELECT digest, digest_hour, digest_day FROM user_calendars WHERE user_id = 'reader'`)[0]).toEqual({ digest: 'weekly', digest_hour: 7, digest_day: 5 })
    await go('/account/digest', { digest: 'hourly', hour: '3', day: '9' })
    expect(w.accounts.rows(`SELECT digest, digest_hour, digest_day FROM user_calendars WHERE user_id = 'reader'`)[0]).toEqual({ digest: 'none', digest_hour: 7, digest_day: 5 })
    const html = await (await go('/account')).text()
    expect(html).toContain('id="digest"')
    expect(html).toContain('<input type="radio" name="digest" value="none" checked>')
  })

  it('confirms a save inside the digest section, where the redirect lands — not at the top', async () => {
    const w = world()
    const go = await signedIn(w)
    const to = (await go('/account/digest', { digest: 'daily', hour: '7', day: '4' })).headers.get('Location')!
    const html = await (await go(to.replace(/#.*/, ''))).text()
    const section = html.slice(html.indexOf('id="digest"'), html.indexOf('</section>', html.indexOf('id="digest"')))
    expect(section).toMatch(/<p class="section-notice ok" role="status"><span class="tick"[^>]*>&#10003;<\/span> Saved\./)
    expect(section.indexOf('section-notice')).toBeLessThan(section.indexOf('<form'))
    expect(html.match(/Saved\. Your digest settings are updated\./g)).toHaveLength(1)
  })

  it('sends a preview once a day, even with digests off', async () => {
    const w = world()
    const go = await signedIn(w)
    w.pin('reader', w.event({ title: 'Fall Fair', date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }) }))
    expect((await go('/account/digest/preview', {})).headers.get('Location')).toBe('/account?notice=preview-sent#digest')
    expect((await go('/account/digest/preview', {})).headers.get('Location')).toBe('/account?notice=preview-used#digest')
    expect(w.mails).toHaveLength(1)
    expect(w.mails[0]!.to).toBe('reader@example.org')
  })
})
