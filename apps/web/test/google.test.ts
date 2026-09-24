import { existsSync } from 'node:fs'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import worker, { type Env } from '../src/worker.ts'
import { callbackUrl, openFlow, sealFlow, startFlow } from '../src/auth/google.ts'

/**
 * Google sign-in without Google: the token endpoint and the JWKS are both answered by a
 * stubbed global fetch, and the id_token is signed with a key pair generated here —
 * npm test is promised no network, and the route code runs exactly as deployed, remote
 * key set and all.
 */

const HOST = 'outinsimcoe.ca'
const SITE = `https://${HOST}`
const CLIENT_ID = 'test-client.apps.googleusercontent.com'

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']
let jwks: { keys: unknown[] }

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'g1', alg: 'RS256', use: 'sig' }] }
})

const idToken = (claims: Record<string, unknown>) =>
  new SignJWT({ email: 'reader@gmail.com', email_verified: true, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'g1' })
    .setIssuer('https://accounts.google.com')
    .setAudience(CLIENT_ID)
    .setSubject((claims.sub as string) ?? 'google-subject-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey)

/* The same in-memory idiom as auth.test.ts, covering the statements this flow issues. */
interface Tables {
  users: Array<{ id: string; email: string; email_verified_at: string | null; display_name: string | null }>
  identities: Array<{ provider: string; subject: string; user_id: string }>
  sessions: Array<{ token_hash: string; user_id: string }>
}

function accountsFake(t: Tables) {
  const statement = (sql: string, v: unknown[] = []): any => ({
    bind: (...bound: unknown[]) => statement(sql, bound),
    all: async () => ({ results: [] }),
    first: async () => {
      if (sql.includes('FROM user_identities WHERE provider')) {
        const row = t.identities.find((i) => i.provider === v[0] && i.subject === v[1])
        return row ? { user_id: row.user_id } : null
      }
      if (sql.includes('SELECT id, email_verified_at FROM users WHERE email')) {
        const u = t.users.find((u) => u.email === v[0])
        return u ? { id: u.id, email_verified_at: u.email_verified_at } : null
      }
      if (sql.includes('FROM user_sessions s JOIN users u')) {
        const s2 = t.sessions.find((s2) => s2.token_hash === v[0])
        if (!s2) return null
        const u = t.users.find((u) => u.id === s2.user_id)!
        return { user_id: u.id, last_seen_at: new Date().toISOString(), expires_at: '9999', email: u.email, email_verified_at: u.email_verified_at, display_name: null }
      }
      throw new Error(`google fake: unhandled first(): ${sql}`)
    },
    run: async () => {
      if (sql.includes('INSERT INTO users')) {
        t.users.push({ id: v[0] as string, email: v[1] as string, email_verified_at: v[2] as string, display_name: null })
        return {}
      }
      if (sql.includes('INSERT INTO user_identities')) {
        t.identities.push({ provider: v[0] as string, subject: v[1] as string, user_id: v[2] as string })
        return {}
      }
      if (sql.includes('DELETE FROM users')) {
        t.users = t.users.filter((u) => u.id !== v[0])
        return {}
      }
      if (sql.includes('INSERT INTO user_sessions')) {
        t.sessions.push({ token_hash: v[0] as string, user_id: v[1] as string })
        return {}
      }
      throw new Error(`google fake: unhandled run(): ${sql}`)
    },
  })
  return { prepare: (sql: string) => statement(sql) }
}

let tables: Tables
let tokenEndpoint: ReturnType<typeof vi.fn>
let env: Env
/** The nonce the route sent to Google, read off the start redirect by completeFlow, so
 * the stubbed token endpoint can sign an id_token that genuinely belongs to the flow. */
let currentNonce = ''

beforeEach(() => {
  tables = { users: [], identities: [], sessions: [] }
  currentNonce = ''
  tokenEndpoint = vi.fn(async () => Response.json({ id_token: await idToken({ nonce: currentNonce }) }))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const target = String(input instanceof Request ? input.url : input)
      if (target.includes('googleapis.com/oauth2/v3/certs')) return Response.json(jwks)
      if (target.includes('oauth2.googleapis.com/token')) return tokenEndpoint(input, init)
      throw new Error(`unexpected fetch in test: ${target}`)
    }),
  )
  env = {
    DB: { prepare: () => { throw new Error('google flow touched the public database') } },
    ACCOUNTS: accountsFake(tables),
    ASSETS: { fetch: async () => new Response('shell') },
    CANONICAL_HOST: HOST,
    PASSWORD_PEPPER: 'test-pepper',
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: 'test-secret',
    OAUTH_STATE_KEY: 'state-signing-key',
  } as unknown as Env
})
afterEach(() => vi.unstubAllGlobals())

const get = (path: string, cookie?: string) =>
  worker.fetch(new Request(`${SITE}${path}`, { headers: cookie ? { Cookie: cookie } : {} }), env)

/** Walk the start redirect, then come back the way Google would. */
async function completeFlow(overrides: { state?: string; dropCookie?: boolean } = {}) {
  const start = await get('/account/google/start')
  expect(start.status).toBe(302)
  const location = new URL(start.headers.get('Location')!)
  const cookie = start.headers.get('Set-Cookie')!.split(';')[0]!
  const state = overrides.state ?? location.searchParams.get('state')!
  currentNonce = location.searchParams.get('nonce')!
  return get(`/account/google/callback?code=fake-code&state=${state}`, overrides.dropCookie ? undefined : cookie)
}

describe('the sealed flow cookie', () => {
  const flow = { state: 's1', nonce: 'n1', verifier: 'v1', expires: 9_999_999_999_999 }

  it('round-trips, and refuses tampering, a wrong key and expiry', async () => {
    const sealed = await sealFlow(flow, 'k')
    expect(await openFlow(sealed, 'k', 0)).toEqual(flow)
    expect(await openFlow(sealed.replace('n1', 'n2'), 'k', 0)).toBeNull()
    expect(await openFlow(sealed, 'other-key', 0)).toBeNull()
    expect(await openFlow(await sealFlow({ ...flow, expires: 5 }, 'k'), 'k', 6)).toBeNull()
  })
})

describe('the start of the flow', () => {
  it('sends the browser to Google with PKCE, and keeps the secrets in a signed cookie', async () => {
    const { location, cookie } = await startFlow(SITE, { clientId: CLIENT_ID, clientSecret: 'x', stateKey: 'k' }, Date.now())
    const url = new URL(location)
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(callbackUrl(SITE))
    expect(url.searchParams.get('scope')).toBe('openid email')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(cookie).toContain('__Host-oauth=')
    expect(cookie).toContain('HttpOnly')
    // The verifier never appears in the URL; it travels only in the sealed cookie.
    expect(location).not.toContain((await openFlow(cookie.split(';')[0]!.split('=')[1]!, 'k', 0))!.verifier)
  })
})

describe('the callback', () => {
  it('signs a new Google user in, verified from birth', async () => {
    const res = await completeFlow()
    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('/account')
    expect(tables.users).toHaveLength(1)
    expect(tables.users[0]!.email).toBe('reader@gmail.com')
    expect(tables.users[0]!.email_verified_at).not.toBeNull()
    expect(tables.identities).toEqual([expect.objectContaining({ provider: 'google', subject: 'google-subject-1' })])
    expect(tables.sessions).toHaveLength(1)
    // The flow cookie is cleared alongside the session being set.
    expect(res.headers.getSetCookie().join('|')).toContain('__Host-oauth=;')
  })

  it('links to an existing VERIFIED account with the same address', async () => {
    tables.users.push({ id: 'u1', email: 'reader@gmail.com', email_verified_at: '2026-01-01', display_name: null })
    await completeFlow()
    expect(tables.users).toHaveLength(1)
    expect(tables.identities[0]!.user_id).toBe('u1')
  })

  it('deletes an UNVERIFIED account with the same address rather than link to it', async () => {
    // The takeover rule: that row proved nothing, and whoever registered it set its
    // password. Linking would hand them a way into this account.
    tables.users.push({ id: 'planted', email: 'reader@gmail.com', email_verified_at: null, display_name: null })
    await completeFlow()
    expect(tables.users.map((u) => u.id)).not.toContain('planted')
    expect(tables.users).toHaveLength(1)
    expect(tables.identities[0]!.user_id).toBe(tables.users[0]!.id)
  })

  it('recognises a returning identity even if its email changed', async () => {
    tables.users.push({ id: 'u1', email: 'old-address@gmail.com', email_verified_at: '2026-01-01', display_name: null })
    tables.identities.push({ provider: 'google', subject: 'google-subject-1', user_id: 'u1' })
    await completeFlow()
    expect(tables.users).toHaveLength(1)
    expect(tables.sessions).toHaveLength(1)
  })

  it('refuses a state that is not the cookie’s, and a missing cookie', async () => {
    expect((await completeFlow({ state: 'forged' })).status).toBe(400)
    expect((await completeFlow({ dropCookie: true })).status).toBe(400)
    expect(tables.sessions).toHaveLength(0)
  })

  it('refuses an id_token whose nonce is not this flow’s', async () => {
    tokenEndpoint.mockImplementation(async () => Response.json({ id_token: await idToken({ nonce: 'replayed' }) }))
    expect((await completeFlow()).status).toBe(400)
  })

  it('refuses an unverified Google address', async () => {
    tokenEndpoint.mockImplementation(async () => Response.json({ id_token: await idToken({ email_verified: false, nonce: currentNonce }) }))
    expect((await completeFlow()).status).toBe(400)
    expect(tables.users).toHaveLength(0)
  })

  it('refuses a token signed for another audience', async () => {
    tokenEndpoint.mockImplementation(async () =>
      Response.json({
        id_token: await new SignJWT({ email: 'reader@gmail.com', email_verified: true, nonce: currentNonce })
          .setProtectedHeader({ alg: 'RS256', kid: 'g1' })
          .setIssuer('https://accounts.google.com')
          .setAudience('someone-else')
          .setSubject('s')
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey),
      }),
    )
    expect((await completeFlow()).status).toBe(400)
  })

  it('answers 404 with no Google configured, and renders no Google button', async () => {
    delete (env as any).GOOGLE_CLIENT_ID
    expect((await get('/account/google/start')).status).toBe(404)
    expect(await (await get('/account/signin')).text()).not.toContain('google/start')
  })

  it('renders the button when configured', async () => {
    expect(await (await get('/account/signin')).text()).toContain('/account/google/start')
  })

  it('draws the button from Google’s artwork, every file of which ships', async () => {
    const html = await (await get('/account/signup')).text()
    const paths = [...html.matchAll(/\/google\/signin-[a-z@0-9]+\.png/g)].map((m) => m[0])
    expect(new Set(paths)).toEqual(new Set(['light', 'dark'].flatMap((t) => ['', '@2x', '@3x'].map((x) => `/google/signin-${t}${x}.png`))))
    for (const path of paths) expect(existsSync(new URL(`../public${path}`, import.meta.url)), path).toBe(true)
  })
})

