import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker, { type Env } from '../src/worker.ts'
import { PBKDF2_ITERATIONS, hashPassword, timingSafeEqual, verifyPassword } from '../src/auth/password.ts'

/**
 * The whole password-auth surface, driven through worker.fetch like a browser would.
 *
 * The ACCOUNTS fake implements exactly the statements the auth module issues, over
 * in-memory tables, and THROWS on any statement it does not recognise — drift between the
 * code's SQL and the fake's fails loudly. The DB fake throws on any use at all: no
 * account route may ever touch the public database, and this harness is the proof.
 */

const HOST = 'outinsimcoe.ca'
const SITE = `https://${HOST}`

interface Tables {
  users: Array<{ id: string; email: string; email_verified_at: string | null; display_name: string | null; created_at: string; updated_at: string }>
  passwords: Array<{ user_id: string; encoded: string; changed_at: string }>
  sessions: Array<{ token_hash: string; user_id: string; created_at: string; last_seen_at: string; expires_at: string }>
  tokens: Array<{ token_hash: string; user_id: string; purpose: string; created_at: string; expires_at: string; used_at: string | null }>
  attempts: Array<{ ip_hash: string; account_key: string; created_at: string }>
}

function accountsFake(t: Tables) {
  const calendars = new Map<string, unknown>()
  const statement = (sql: string, v: unknown[] = []): any => ({
    bind: (...bound: unknown[]) => statement(sql, bound),
    all: async () => ({ results: [] }),
    first: async () => {
      if (sql.includes('FROM users WHERE email')) {
        const u = t.users.find((u) => u.email === v[0])
        return u ? { id: u.id, email: u.email, email_verified_at: u.email_verified_at } : null
      }
      if (sql.includes('SELECT encoded FROM user_passwords')) {
        const p = t.passwords.find((p) => p.user_id === v[0])
        return p ? { encoded: p.encoded } : null
      }
      if (sql.includes('FROM user_sessions s JOIN users u')) {
        const s = t.sessions.find((s) => s.token_hash === v[0])
        if (!s) return null
        const u = t.users.find((u) => u.id === s.user_id)!
        return { user_id: s.user_id, last_seen_at: s.last_seen_at, expires_at: s.expires_at, email: u.email, email_verified_at: u.email_verified_at, display_name: u.display_name }
      }
      if (sql.includes('SELECT user_id FROM user_tokens')) {
        const row = t.tokens.find((k) => k.token_hash === v[0])
        return row ? { user_id: row.user_id } : null
      }
      // The account page makes each reader's calendar row on first sight (account/calendar.ts).
      if (sql.includes('FROM user_calendars WHERE user_id')) {
        return calendars.get(v[0] as string) ?? null
      }
      if (sql.includes('COUNT(*) AS n FROM auth_attempts WHERE ip_hash')) {
        return { n: t.attempts.filter((a) => a.ip_hash === v[0] && a.created_at > (v[1] as string)).length }
      }
      if (sql.includes('COUNT(*) AS n FROM auth_attempts WHERE account_key')) {
        return { n: t.attempts.filter((a) => a.account_key === v[0] && a.created_at > (v[1] as string)).length }
      }
      throw new Error(`accountsFake: unhandled first(): ${sql}`)
    },
    run: async () => {
      if (sql.includes('INSERT INTO user_calendars')) {
        if (!calendars.has(v[0] as string)) calendars.set(v[0] as string, { user_id: v[0], calendar_id: v[1], feed_generation: 1, share_slug: null })
        return {}
      }
      if (sql.includes('INSERT INTO users')) {
        t.users.push({ id: v[0] as string, email: v[1] as string, email_verified_at: null, display_name: null, created_at: v[2] as string, updated_at: v[3] as string })
        return {}
      }
      if (sql.includes('INSERT INTO user_passwords') && sql.includes('ON CONFLICT')) {
        const existing = t.passwords.find((p) => p.user_id === v[0])
        if (existing) Object.assign(existing, { encoded: v[1], changed_at: v[2] })
        else t.passwords.push({ user_id: v[0] as string, encoded: v[1] as string, changed_at: v[2] as string })
        return {}
      }
      if (sql.includes('INSERT INTO user_passwords')) {
        t.passwords.push({ user_id: v[0] as string, encoded: v[1] as string, changed_at: v[2] as string })
        return {}
      }
      if (sql.includes('UPDATE user_passwords SET encoded')) {
        Object.assign(t.passwords.find((p) => p.user_id === v[2])!, { encoded: v[0], changed_at: v[1] })
        return {}
      }
      if (sql.includes('INSERT INTO user_sessions')) {
        t.sessions.push({ token_hash: v[0] as string, user_id: v[1] as string, created_at: v[2] as string, last_seen_at: v[3] as string, expires_at: v[4] as string })
        return {}
      }
      if (sql.includes('DELETE FROM user_sessions WHERE token_hash')) {
        t.sessions = t.sessions.filter((s) => s.token_hash !== v[0])
        return {}
      }
      if (sql.includes('DELETE FROM user_sessions WHERE user_id')) {
        t.sessions = t.sessions.filter((s) => s.user_id !== v[0])
        return {}
      }
      if (sql.includes('UPDATE user_sessions SET last_seen_at')) {
        Object.assign(t.sessions.find((s) => s.token_hash === v[1])!, { last_seen_at: v[0] })
        return {}
      }
      if (sql.includes('INSERT INTO user_tokens')) {
        t.tokens.push({ token_hash: v[0] as string, user_id: v[1] as string, purpose: v[2] as string, created_at: v[3] as string, expires_at: v[4] as string, used_at: null })
        return {}
      }
      if (sql.includes('UPDATE user_tokens SET used_at')) {
        const row = t.tokens.find((k) => k.token_hash === v[1] && k.purpose === v[2] && k.used_at === null && k.expires_at > (v[3] as string))
        if (row) row.used_at = v[0] as string
        return { meta: { changes: row ? 1 : 0 } }
      }
      if (sql.includes('UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ? AND email_verified_at IS NULL')) {
        const u = t.users.find((u) => u.id === v[2])!
        if (u.email_verified_at === null) Object.assign(u, { email_verified_at: v[0], updated_at: v[1] })
        return {}
      }
      if (sql.includes('UPDATE users SET email_verified_at = COALESCE')) {
        const u = t.users.find((u) => u.id === v[2])!
        Object.assign(u, { email_verified_at: u.email_verified_at ?? (v[0] as string), updated_at: v[1] })
        return {}
      }
      if (sql.includes('INSERT INTO auth_attempts')) {
        t.attempts.push({ ip_hash: v[0] as string, account_key: v[1] as string, created_at: v[2] as string })
        return {}
      }
      if (sql.includes('DELETE FROM auth_attempts')) {
        t.attempts = t.attempts.filter((a) => a.created_at >= (v[0] as string))
        return {}
      }
      throw new Error(`accountsFake: unhandled run(): ${sql}`)
    },
  })
  return { prepare: (sql: string) => statement(sql) }
}

let tables: Tables
let mails: Array<{ to: unknown; subject: string; text: string }>
let siteverify: ReturnType<typeof vi.fn>
let env: Env

const linkToken = (text: string, path: string): string => {
  const m = text.match(new RegExp(`${path}\\?token=([A-Za-z0-9_-]+)`))
  if (!m) throw new Error(`no ${path} link in: ${text}`)
  return m[1]!
}

beforeEach(() => {
  tables = { users: [], passwords: [], sessions: [], tokens: [], attempts: [] }
  mails = []
  siteverify = vi.fn(async () => Response.json({ success: true, action: 'account', hostname: HOST }))
  vi.stubGlobal('fetch', siteverify)
  env = {
    DB: {
      prepare: () => {
        throw new Error('an account route touched the public database')
      },
    },
    ACCOUNTS: accountsFake(tables),
    ASSETS: { fetch: async () => new Response('shell') },
    EMAIL: { send: async (m: any) => void mails.push({ to: m.to, subject: m.subject, text: m.text }) },
    CANONICAL_HOST: HOST,
    PASSWORD_PEPPER: 'test-pepper',
    TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
  } as unknown as Env
})
afterEach(() => vi.unstubAllGlobals())

const request = (path: string, options: { method?: string; form?: Record<string, string>; cookie?: string; crossSite?: boolean } = {}) => {
  const headers: Record<string, string> = { 'CF-Connecting-IP': '203.0.113.9' }
  let body: BodyInit | undefined
  if (options.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    headers['Origin'] = options.crossSite ? 'https://evil.example' : SITE
    headers['Sec-Fetch-Site'] = options.crossSite ? 'cross-site' : 'same-origin'
    body = new URLSearchParams(options.form).toString()
  }
  if (options.cookie) headers['Cookie'] = options.cookie
  return worker.fetch(new Request(`${SITE}${path}`, { method: options.method ?? (options.form ? 'POST' : 'GET'), headers, body }), env)
}

const signUp = (email = 'reader@example.com', password = 'a fine passphrase') =>
  request('/account/signup', { form: { email, password, 'cf-turnstile-response': 'tok' } })

const verifyByMail = async () => {
  const token = linkToken(mails.at(-1)!.text, '/account/verify')
  return request(`/account/verify?token=${token}`)
}

const signIn = (email = 'reader@example.com', password = 'a fine passphrase') =>
  request('/account/signin', { form: { email, password } })

const sessionCookieOf = (res: Response): string => {
  const header = res.headers.get('Set-Cookie') ?? ''
  expect(header).toContain('__Host-session=')
  expect(header).toContain('HttpOnly')
  expect(header).toContain('SameSite=Lax')
  return header.split(';')[0]!
}

describe('password hashing', () => {
  it('never asks for more iterations than workerd will run', () => {
    // These tests run in Node, which happily derives any count; the deployed runtime
    // refuses anything above 100,000 with a NotSupportedError, which surfaced as error
    // 1101 on the first real registration. This is the only guard that spans the gap.
    expect(PBKDF2_ITERATIONS).toBeLessThanOrEqual(100_000)
  })

  it('round-trips, refuses a wrong password and a wrong pepper', async () => {
    const encoded = await hashPassword('open sesame', 'pepper')
    expect(encoded).toMatch(new RegExp(`^pbkdf2\\$sha256\\$${PBKDF2_ITERATIONS}\\$`))
    expect((await verifyPassword('open sesame', 'pepper', encoded)).ok).toBe(true)
    expect((await verifyPassword('open sesame!', 'pepper', encoded)).ok).toBe(false)
    expect((await verifyPassword('open sesame', 'other', encoded)).ok).toBe(false)
  })

  it('asks for a re-hash when the stored count is below the floor, honouring the stored one', async () => {
    const old = await hashPassword('pw', 'p', 1_000)
    expect(await verifyPassword('pw', 'p', old)).toEqual({ ok: true, rehash: true })
  })

  it('compares in constant shape', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true)
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false)
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false)
  })
})

describe('sign-up and verification', () => {
  it('creates an unverified account, mails the link, and says only "check your inbox"', async () => {
    const res = await signUp()
    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('/account/check-email')
    expect(tables.users).toHaveLength(1)
    expect(tables.users[0]!.email_verified_at).toBeNull()
    expect(mails).toHaveLength(1)
    expect(mails[0]!.to).toBe('reader@example.com')
    expect(mails[0]!.text).toContain('/account/verify?token=')
  })

  it('will not sign an unverified account in; it re-sends the link instead', async () => {
    await signUp()
    const res = await signIn()
    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('/account/signin?notice=unverified')
    expect(res.headers.get('Set-Cookie')).toBeNull()
    expect(mails).toHaveLength(2)
  })

  it('verifies through the mailed link exactly once', async () => {
    await signUp()
    const token = linkToken(mails[0]!.text, '/account/verify')
    const first = await request(`/account/verify?token=${token}`)
    expect(first.status).toBe(303)
    expect(tables.users[0]!.email_verified_at).not.toBeNull()
    const second = await request(`/account/verify?token=${token}`)
    expect(second.status).toBe(410)
  })

  it('answers a taken address exactly like a new one, and tells the owner by mail', async () => {
    await signUp()
    mails.length = 0
    const res = await signUp('reader@example.com', 'another password')
    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('/account/check-email')
    expect(tables.users).toHaveLength(1)
    expect(mails[0]!.subject).toContain('already has an account')
  })

  it('refuses a Turnstile token minted for another action', async () => {
    siteverify.mockResolvedValue(Response.json({ success: true, action: 'suggest', hostname: HOST }))
    const res = await signUp()
    expect(res.status).toBe(403)
    expect(tables.users).toHaveLength(0)
  })
})

describe('sign-in, session, sign-out', () => {
  beforeEach(async () => {
    await signUp()
    await verifyByMail()
    mails.length = 0
  })

  it('signs in, carries the session in a __Host- cookie, and shows the account page', async () => {
    const res = await signIn()
    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('/account')
    const cookie = sessionCookieOf(res)
    expect(tables.sessions).toHaveLength(1)
    // The token itself is never stored — only its hash.
    expect(tables.sessions[0]!.token_hash).not.toBe(cookie.split('=')[1])

    const account = await request('/account', { cookie })
    expect(account.status).toBe(200)
    expect(await account.text()).toContain('reader@example.com')
    expect(account.headers.get('Cache-Control')).toBe('no-store')
    expect(account.headers.get('X-Robots-Tag')).toContain('noindex')
  })

  it('says the same words for a wrong password and a missing account', async () => {
    const wrong = await signIn('reader@example.com', 'not the passphrase')
    const missing = await signIn('nobody@example.com', 'not the passphrase')
    expect(wrong.status).toBe(400)
    expect(missing.status).toBe(400)
    // The typed address rides back in the form's value attribute; with it stripped, the
    // two refusals must be byte-identical, or the response says which addresses exist.
    const strip = (s: string) => s.replace(/value="[^"]*"/g, '')
    const wrongText = strip(await wrong.text())
    const missingText = strip(await missing.text())
    expect(wrongText).toContain('did not match')
    expect(missingText).toBe(wrongText)
  })

  it('signs out: the row is gone and the cookie cleared', async () => {
    const cookie = sessionCookieOf(await signIn())
    const out = await request('/account/signout', { form: {}, cookie })
    expect(out.status).toBe(303)
    expect(out.headers.get('Set-Cookie')).toContain('Max-Age=0')
    expect(tables.sessions).toHaveLength(0)
    const after = await request('/account', { cookie })
    expect(after.status).toBe(303)
  })

  it('refuses a write that came from another site, even with a valid session', async () => {
    const cookie = sessionCookieOf(await signIn())
    const res = await request('/account/signout', { form: {}, cookie, crossSite: true })
    expect(res.status).toBe(403)
    expect(tables.sessions).toHaveLength(1)
  })
})

describe('password reset', () => {
  beforeEach(async () => {
    await signUp()
    await verifyByMail()
    mails.length = 0
  })

  it('resets through the mailed link, signs out every device, and retires the old password', async () => {
    const oldCookie = sessionCookieOf(await signIn())
    await request('/account/reset', { form: { email: 'reader@example.com', 'cf-turnstile-response': 'tok' } })
    const token = linkToken(mails.at(-1)!.text, '/account/reset/confirm')
    const res = await request('/account/reset/confirm', { form: { token, password: 'an even finer one' } })
    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('/account/signin?notice=reset')
    expect(tables.sessions).toHaveLength(0)
    expect((await request('/account', { cookie: oldCookie })).status).toBe(303)
    expect((await signIn()).status).toBe(400)
    expect((await signIn('reader@example.com', 'an even finer one')).status).toBe(303)
  })

  it('answers an unknown address exactly like a known one, and mails nobody', async () => {
    const res = await request('/account/reset', { form: { email: 'nobody@example.com', 'cf-turnstile-response': 'tok' } })
    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('/account/check-email')
    expect(mails).toHaveLength(0)
  })
})

describe('limits and posture', () => {
  it('throttles an account after ten tries in an hour, whoever is asking', async () => {
    await signUp()
    await verifyByMail()
    for (let i = 0; i < 10; i++) await signIn('reader@example.com', 'wrong')
    const res = await signIn()
    expect(res.status).toBe(429)
  })

  it('303s to the canonical host from anywhere else, so there is one cookie jar', async () => {
    const res = await worker.fetch(new Request('https://scec-web.thejeremy-net.workers.dev/account/signin'), env)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe(`${SITE}/account/signin`)
  })

  it('answers 503 on every account route without the pepper', async () => {
    delete (env as any).PASSWORD_PEPPER
    expect((await request('/account/signin')).status).toBe(503)
    expect((await request('/account')).status).toBe(503)
  })
})
