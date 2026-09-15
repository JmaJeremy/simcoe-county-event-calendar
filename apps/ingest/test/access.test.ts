import { describe, expect, it, beforeAll } from 'vitest'
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose'
import { isSameOriginWrite, verifyAccess } from '../src/access.ts'

/**
 * The console's only lock that holds on every hostname. Tokens are signed here with a
 * local key pair and verified against a local key set, so none of this touches the
 * network — but the checks are the real ones: signature, issuer, audience, expiry.
 */

const TEAM = 'https://example-team.cloudflareaccess.com'
const AUD = 'aud-tag-for-the-console'
const settings = { teamDomain: TEAM, audience: AUD }

/** jose's own key type; the ES lib this project compiles against has no CryptoKey. */
type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

let keys: JWTVerifyGetKey
let sign: (claims?: Record<string, unknown>, options?: { issuer?: string; audience?: string; expiresIn?: string | number; key?: PrivateKey }) => Promise<string>
let strangerKey: PrivateKey

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  const stranger = await generateKeyPair('RS256')
  strangerKey = stranger.privateKey
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' }
  keys = createLocalJWKSet({ keys: [jwk] })
  sign = (claims = { email: 'jeremy@example.com' }, options = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(options.issuer ?? TEAM)
      .setAudience(options.audience ?? [AUD])
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? '5m')
      .sign(options.key ?? pair.privateKey)
})

const request = (token?: string) =>
  new Request('https://console.example.ca/', token ? { headers: { 'Cf-Access-Jwt-Assertion': token } } : {})

describe('verifyAccess', () => {
  it('accepts a token Access signed for this application, and says who it is', async () => {
    expect(await verifyAccess(request(await sign()), settings, keys)).toEqual({ ok: true, email: 'jeremy@example.com' })
  })

  it('refuses a request with no token at all', async () => {
    expect(await verifyAccess(request(), settings, keys)).toMatchObject({ ok: false, reason: 'no-token' })
  })

  it('refuses a token for a different Access application', async () => {
    const token = await sign(undefined, { audience: 'some-other-app' })
    expect((await verifyAccess(request(token), settings, keys)).ok).toBe(false)
  })

  it('refuses a token from a different team', async () => {
    const token = await sign(undefined, { issuer: 'https://someone-else.cloudflareaccess.com' })
    expect((await verifyAccess(request(token), settings, keys)).ok).toBe(false)
  })

  it('refuses an expired token', async () => {
    const token = await sign(undefined, { expiresIn: Math.floor(Date.now() / 1000) - 60 })
    expect((await verifyAccess(request(token), settings, keys)).ok).toBe(false)
  })

  it('refuses a token signed by any key but the team’s', async () => {
    const token = await sign(undefined, { key: strangerKey })
    expect((await verifyAccess(request(token), settings, keys)).ok).toBe(false)
  })

  it('refuses a well-formed token with no email, since the console acts for a person', async () => {
    const token = await sign({ common_name: 'a-service-token' })
    expect(await verifyAccess(request(token), settings, keys)).toMatchObject({ ok: false, reason: 'no-email' })
  })

  it('refuses everything when the worker was deployed without its Access settings', async () => {
    const token = await sign()
    expect(await verifyAccess(request(token), { teamDomain: TEAM }, keys)).toMatchObject({ ok: false, reason: 'access-not-configured' })
    expect(await verifyAccess(request(token), {}, keys)).toMatchObject({ ok: false, reason: 'access-not-configured' })
  })

  it('refuses garbage in the header', async () => {
    expect((await verifyAccess(request('not.a.jwt'), settings, keys)).ok).toBe(false)
  })
})

describe('isSameOriginWrite', () => {
  const post = (headers: Record<string, string>) => new Request('https://console.example.ca/events', { method: 'POST', headers })

  it('allows a form posted from the console itself', () => {
    expect(isSameOriginWrite(post({ Origin: 'https://console.example.ca', 'Sec-Fetch-Site': 'same-origin' }), 'console.example.ca')).toBe(true)
  })

  /* The browser sends the Access cookie with a cross-site form, and Access turns it into a
     valid token — so the token alone cannot tell a real edit from a forged one. */
  it('refuses a form another site made the browser post, token or not', () => {
    expect(isSameOriginWrite(post({ Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }), 'console.example.ca')).toBe(false)
    expect(isSameOriginWrite(post({ Origin: 'https://console.example.ca', 'Sec-Fetch-Site': 'same-site' }), 'console.example.ca')).toBe(false)
  })

  it('refuses a write that says nothing about where it came from', () => {
    expect(isSameOriginWrite(post({}), 'console.example.ca')).toBe(false)
  })
})
