import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import type { AccountsDb } from './db.ts'
import { randomToken } from './session.ts'

/**
 * Google sign-in: Authorization Code with PKCE, implementing the design in
 * docs/user-accounts.md and modeled on the console's Access verifier
 * (apps/ingest/src/access.ts), down to the injectable key set that lets tests sign with a
 * local key pair — npm test is promised no network.
 *
 * The interesting problem is that `state`, `nonce` and the PKCE verifier must survive the
 * round trip to Google, and this stack has no KV. They travel in a short-lived
 * HMAC-signed HttpOnly cookie instead of a database row: no write per sign-in *attempt*
 * (every bot that finds the route would be one), no cleanup job, and the values are bound
 * to the browser that started the flow — which is the property `state` exists to provide.
 */

export interface GoogleSettings {
  clientId: string
  clientSecret: string
  /** Signs the round-trip cookie. Its own secret: rotating it only aborts in-flight sign-ins. */
  stateKey: string
}

export const OAUTH_COOKIE = '__Host-oauth'
/** Long enough to pick an account and answer a consent screen; short enough to be stale fast. */
const FLOW_TTL_MS = 10 * 60 * 1000

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs'
/** Google signs `iss` both ways, and its documentation says to accept both. */
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

const encoder = new TextEncoder()

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function hmac(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', k, encoder.encode(message))))
}

interface FlowState {
  state: string
  nonce: string
  verifier: string
  expires: number
}

/** `state.nonce.verifier.expires.signature`, every part base64url or a number. */
export async function sealFlow(flow: FlowState, stateKey: string): Promise<string> {
  const body = `${flow.state}.${flow.nonce}.${flow.verifier}.${flow.expires}`
  return `${body}.${await hmac(stateKey, body)}`
}

export async function openFlow(sealed: string | null, stateKey: string, now: number): Promise<FlowState | null> {
  if (!sealed) return null
  const parts = sealed.split('.')
  if (parts.length !== 5) return null
  const body = parts.slice(0, 4).join('.')
  if ((await hmac(stateKey, body)) !== parts[4]) return null
  const expires = Number(parts[3])
  if (!Number.isFinite(expires) || expires < now) return null
  return { state: parts[0]!, nonce: parts[1]!, verifier: parts[2]!, expires }
}

export const flowCookie = (sealed: string): string =>
  `${OAUTH_COOKIE}=${sealed}; Max-Age=${FLOW_TTL_MS / 1000}; Path=/; Secure; HttpOnly; SameSite=Lax`
export const clearFlowCookie = (): string => `${OAUTH_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`

/** The redirect Google answers to; one path, the host varying with the environment. */
export const callbackUrl = (origin: string): string => `${origin}/account/google/callback`

export async function startFlow(origin: string, settings: GoogleSettings, now: number): Promise<{ location: string; cookie: string }> {
  const flow: FlowState = { state: randomToken(), nonce: randomToken(), verifier: randomToken(), expires: now + FLOW_TTL_MS }
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(flow.verifier))))
  const params = new URLSearchParams({
    client_id: settings.clientId,
    redirect_uri: callbackUrl(origin),
    response_type: 'code',
    // openid + email is all the site wants to know. No profile: a display name can be
    // typed later, and asking for less is the point of the minimal-PII posture.
    scope: 'openid email',
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  })
  return { location: `${GOOGLE_AUTH}?${params}`, cookie: flowCookie(await sealFlow(flow, settings.stateKey)) }
}

/* One key set for the isolate's life, as access.ts keeps one per team: jose caches and
 * refetches on an unknown `kid`, which is how Google's key rotation is survived. */
let googleKeys: JWTVerifyGetKey | undefined
const remoteKeys = (): JWTVerifyGetKey => (googleKeys ??= createRemoteJWKSet(new URL(GOOGLE_JWKS)))

export type GoogleIdentity = { ok: true; subject: string; email: string } | { ok: false; reason: string }

type FetchLike = (input: string, init: { method: string; body: URLSearchParams }) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>

/**
 * Code → tokens → verified identity. Refuses anything but a Google-signed id_token whose
 * audience is this client, whose nonce is this flow's, and whose email Google itself has
 * verified — an unverified Google address is not proof of anything (the takeover rule).
 *
 * @param keys,fetchImpl Only for tests, which sign with a local pair and answer the token
 * endpoint themselves.
 */
export async function exchangeCode(
  code: string,
  flow: FlowState,
  origin: string,
  settings: GoogleSettings,
  keys?: JWTVerifyGetKey,
  fetchImpl: FetchLike = fetch,
): Promise<GoogleIdentity> {
  let idToken: string
  try {
    const response = await fetchImpl(GOOGLE_TOKEN, {
      method: 'POST',
      body: new URLSearchParams({
        code,
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
        redirect_uri: callbackUrl(origin),
        grant_type: 'authorization_code',
        code_verifier: flow.verifier,
      }),
    })
    if (!response.ok) return { ok: false, reason: `token-endpoint-${response.status}` }
    const body = (await response.json()) as { id_token?: string }
    if (typeof body.id_token !== 'string') return { ok: false, reason: 'no-id-token' }
    idToken = body.id_token
  } catch {
    return { ok: false, reason: 'token-endpoint-unreachable' }
  }

  try {
    const { payload } = await jwtVerify(idToken, keys ?? remoteKeys(), {
      issuer: GOOGLE_ISSUERS,
      audience: settings.clientId,
      algorithms: ['RS256'],
    })
    if (payload.nonce !== flow.nonce) return { ok: false, reason: 'nonce-mismatch' }
    if (payload.email_verified !== true) return { ok: false, reason: 'email-unverified' }
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
    const subject = typeof payload.sub === 'string' ? payload.sub : ''
    if (!email || !subject) return { ok: false, reason: 'claims-missing' }
    return { ok: true, subject, email }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? ((err as { code?: string }).code ?? err.name) : 'invalid-id-token' }
  }
}

/**
 * The user a verified Google identity signs in as, created or linked as needed.
 *
 * Order matters, and the middle case is the takeover rule doing its work:
 *  - the identity is already linked → that user, whatever their email says now;
 *  - the address belongs to a VERIFIED user → link the identity to them: both sides have
 *    proved the same mailbox;
 *  - the address belongs to an UNVERIFIED user → that row proved nothing and may have
 *    been planted by someone else entirely, so it is deleted — password and all — and the
 *    Google identity gets a fresh account. Linking instead would hand whoever registered
 *    it a password into this account;
 *  - nobody has the address → a fresh account, verified from birth, because Google's
 *    `email_verified` is the same proof our own mail loop establishes.
 */
export async function userForIdentity(db: AccountsDb, identity: { subject: string; email: string }, now: Date): Promise<string> {
  const stamp = now.toISOString()
  const linked = await db
    .prepare('SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?')
    .bind('google', identity.subject)
    .first<{ user_id: string }>()
  if (linked) return linked.user_id

  const existing = await db
    .prepare('SELECT id, email_verified_at FROM users WHERE email = ?')
    .bind(identity.email)
    .first<{ id: string; email_verified_at: string | null }>()

  if (existing && existing.email_verified_at) {
    await db
      .prepare('INSERT INTO user_identities (provider, subject, user_id, linked_at) VALUES (?, ?, ?, ?)')
      .bind('google', identity.subject, existing.id, stamp)
      .run()
    return existing.id
  }
  if (existing) {
    // Unverified: the row proved nothing. Cascades take its password, tokens and sessions.
    await db.prepare('DELETE FROM users WHERE id = ?').bind(existing.id).run()
  }

  const userId = crypto.randomUUID()
  await db
    .prepare('INSERT INTO users (id, email, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(userId, identity.email, stamp, stamp, stamp)
    .run()
  await db
    .prepare('INSERT INTO user_identities (provider, subject, user_id, linked_at) VALUES (?, ?, ?, ?)')
    .bind('google', identity.subject, userId, stamp)
    .run()
  return userId
}

