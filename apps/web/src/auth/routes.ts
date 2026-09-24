import { MAIL_FROM, sendMail, type SendEmail } from '../mail.ts'
import { accountHome } from '../account/page.ts'
import { listFilters, listPins, refreshSnapshot, removeFilter, resolvePins, unpin, type EventsDb } from '../account/store.ts'
import { TURNSTILE_FIELD, verifyTurnstile } from '../suggest.ts'
import type { AccountsDb } from './db.ts'
import { OAUTH_COOKIE, clearFlowCookie, exchangeCode, openFlow, startFlow, userForIdentity, type GoogleSettings } from './google.ts'
import { existingAccountMail, resetMail, verificationMail } from './mail.ts'
import {
  ACCOUNT_TURNSTILE_ACTION,
  accountPage,
  resetConfirmForm,
  resetRequestForm,
  signInForm,
  signUpForm,
} from './pages.ts'
import { hashPassword, verifyPassword } from './password.ts'
import {
  clearSessionCookie,
  cookieValue,
  createSession,
  destroyAllSessions,
  destroySession,
  isSameOriginWrite,
  sessionCookie,
  sessionUser,
  sha256hex,
} from './session.ts'
import { consumeToken, mintToken } from './tokens.ts'

/**
 * The account routes: everything under /account. Server-rendered forms, POST, 303 on
 * success; every response is no-store and noindex, because nothing here is for a cache or
 * a crawler. The design these routes implement is docs/user-accounts.md; the shape they
 * copy is the console's.
 */
export interface AuthEnv {
  ACCOUNTS: AccountsDb
  /** The public events database, read ONLY to show what pins point at (the account page's
   * application-side join). Nothing under /account writes it. */
  DB: EventsDb
  EMAIL?: SendEmail
  TURNSTILE_SECRET_KEY?: string
  PASSWORD_PEPPER?: string
  CANONICAL_HOST?: string
  /** All three or nothing: with any missing, the Google button is not rendered and the
   * routes answer 404, the posture Turnstile and Access already take. */
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  OAUTH_STATE_KEY?: string
}

const googleSettings = (env: AuthEnv): GoogleSettings | null =>
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.OAUTH_STATE_KEY
    ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, stateKey: env.OAUTH_STATE_KEY }
    : null

/** Attempts allowed per rolling hour. Per IP AND per account: per-IP alone does nothing
 * against a distributed attempt on one address, per-account alone lets one host walk a
 * list. Ten per account is generous for a person mistyping and useless for a cracker. */
const ATTEMPTS_PER_IP = 30
const ATTEMPTS_PER_ACCOUNT = 10
const HOUR_MS = 60 * 60 * 1000
/** More form than anyone types by hand; anything larger is not a person. */
const MAX_BODY_BYTES = 16_384
const MIN_PASSWORD = 8
const MAX_PASSWORD = 200

/** Post-redirect notices, whitelisted so the query string can never put words in our mouth. */
const NOTICES: Record<string, string> = {
  'check-email': 'If that address can receive mail from us, a message is on its way. It may take a minute.',
  verified: 'Your email is confirmed. Sign in to get started.',
  reset: 'Your password is changed, and every signed-in device was signed out. Sign in with the new one.',
  'signed-out': 'Signed out.',
  unverified: 'Your email is not confirmed yet. We have sent the confirmation link again — it works for 24 hours.',
  unpinned: 'Unpinned.',
  'view-removed': 'Saved view removed.',
}

/**
 * Where to go after signing in, when a page sent the reader here (the Pin button on an
 * event, signed out). Only a path on this site: it must start with one slash, never two or
 * a backslash — `//evil.example` and `/\evil.example` are other hosts to a browser — and
 * carry no whitespace or control characters. Anything else means /account.
 */
export function safeNext(value: string | null | undefined): string | null {
  if (!value || value.length > 512) return null
  return /^\/(?![\/\\])[^\s\\\x00-\x1f\x7f]*$/.test(value) ? value : null
}


const page = (html: string, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Security-Policy': "form-action 'self'",
      ...headers,
    },
  })

const redirect = (to: string, headers: Record<string, string> = {}): Response =>
  new Response(null, { status: 303, headers: { Location: to, 'Cache-Control': 'no-store', ...headers } })

const emailOk = (value: string): boolean => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)

export async function readForm(request: Request): Promise<Record<string, string> | null> {
  const length = Number(request.headers.get('Content-Length') ?? '0')
  if (length > MAX_BODY_BYTES) return null
  try {
    const data = await request.formData()
    const out: Record<string, string> = {}
    for (const [key, value] of data) if (typeof value === 'string') out[key] = value
    return out
  } catch {
    return null
  }
}

/**
 * True when this attempt is over either limit; records the attempt either way. Old rows
 * are swept opportunistically so the table stays the size of one busy hour.
 */
async function throttled(db: AccountsDb, ipHash: string, accountKey: string, now: Date): Promise<boolean> {
  const hourAgo = new Date(now.getTime() - HOUR_MS).toISOString()
  const [byIp, byAccount] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS n FROM auth_attempts WHERE ip_hash = ? AND created_at > ?').bind(ipHash, hourAgo).first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM auth_attempts WHERE account_key = ? AND created_at > ?').bind(accountKey, hourAgo).first<{ n: number }>(),
  ])
  await db.prepare('INSERT INTO auth_attempts (ip_hash, account_key, created_at) VALUES (?, ?, ?)').bind(ipHash, accountKey, now.toISOString()).run()
  await db.prepare('DELETE FROM auth_attempts WHERE created_at < ?').bind(new Date(now.getTime() - 2 * HOUR_MS).toISOString()).run()
  return (byIp?.n ?? 0) >= ATTEMPTS_PER_IP || (byAccount?.n ?? 0) >= ATTEMPTS_PER_ACCOUNT
}

/** The suggestion form's day-salted hash, so an address is never stored raw here either. */
async function callerHash(request: Request, now: Date): Promise<string> {
  const ip = request.headers.get('CF-Connecting-IP')
  return sha256hex(`${now.toISOString().slice(0, 10)}:${ip ?? 'unknown'}`)
}

interface UserRow {
  id: string
  email: string
  email_verified_at: string | null
}

const userByEmail = (db: AccountsDb, email: string) =>
  db.prepare('SELECT id, email, email_verified_at FROM users WHERE email = ?').bind(email).first<UserRow>()

async function sendVerification(env: AuthEnv, origin: string, userId: string, email: string, now: Date): Promise<void> {
  const token = await mintToken(env.ACCOUNTS, userId, 'verify', now)
  await sendMail(env.EMAIL, { to: email, from: MAIL_FROM, ...verificationMail(`${origin}/account/verify?token=${token}`) })
}

export async function handleAccount(request: Request, url: URL, env: AuthEnv, now = new Date()): Promise<Response> {
  // One cookie jar: the site also answers on www (301 elsewhere) and on workers.dev, and a
  // cookie set there is a different cookie. Account routes live on the canonical host only.
  if (env.CANONICAL_HOST && url.hostname !== env.CANONICAL_HOST) {
    const there = new URL(url)
    there.hostname = env.CANONICAL_HOST
    return new Response(null, { status: request.method === 'GET' ? 302 : 307, headers: { Location: there.toString() } })
  }
  const origin = url.origin

  // Fail closed without the pepper: no route here can do its job, and a sign-in that
  // quietly hashed without it would strand every password the moment it was set.
  if (!env.PASSWORD_PEPPER) {
    return page(accountPage({ title: 'Accounts unavailable', heading: 'Accounts are not available right now', origin, body: '<p class="lead">Please try again later.</p>' }), 503)
  }
  const pepper = env.PASSWORD_PEPPER

  const path = url.pathname
  const notice = NOTICES[url.searchParams.get('notice') ?? '']
  const google = googleSettings(env)

  if (request.method === 'GET') {
    if (path === '/account') {
      const user = await sessionUser(env.ACCOUNTS, request, now)
      if (!user) return redirect('/account/signin')
      const [pins, filters] = await Promise.all([listPins(env.ACCOUNTS, user.userId), listFilters(env.ACCOUNTS, user.userId)])
      // The join the two databases cannot do: pinned ids from ACCOUNTS, events from DB.
      // Skipped outright with nothing pinned, so a new account's page never touches DB.
      const live = pins.length ? await resolvePins(env.DB, pins.map((p) => p.eventId)) : new Map()
      for (const p of pins) {
        const e = live.get(p.eventId)
        if (e && (e.title !== p.title || e.localDate !== p.localDate || e.shortCode !== p.shortCode)) await refreshSnapshot(env.ACCOUNTS, user.userId, e)
      }
      const today = now.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
      return page(accountPage({ title: 'Your account', heading: 'Your account', origin, notice, body: accountHome({ email: user.email, pins, live, filters, today }) }))
    }
    if (path === '/account/signin') {
      const next = safeNext(url.searchParams.get('next'))
      if (await sessionUser(env.ACCOUNTS, request, now)) return redirect(next ?? '/account')
      return page(accountPage({ title: 'Sign in', heading: 'Sign in', origin, notice, body: signInForm(undefined, !!google, next ?? '') }))
    }
    if (path === '/account/signup') {
      if (await sessionUser(env.ACCOUNTS, request, now)) return redirect('/account')
      return page(accountPage({ title: 'Create an account', heading: 'Create an account', origin, notice, body: signUpForm(undefined, !!google) }))
    }
    if (path === '/account/reset') {
      return page(accountPage({ title: 'Reset your password', heading: 'Reset your password', origin, notice, body: resetRequestForm() }))
    }
    if (path === '/account/reset/confirm') {
      const token = url.searchParams.get('token') ?? ''
      return page(accountPage({ title: 'Choose a new password', heading: 'Choose a new password', origin, body: resetConfirmForm(token) }))
    }
    if (path === '/account/check-email') {
      return page(accountPage({ title: 'Check your inbox', heading: 'Check your inbox', origin, notice: NOTICES['check-email'], body: '<p class="account-links"><a href="/account/signin">Back to sign in</a></p>' }))
    }
    if (path === '/account/google/start') {
      if (!google) return page(accountPage({ title: 'Not available', heading: 'Google sign-in is not available', origin, body: '<p class="account-links"><a href="/account/signin">Back to sign in</a></p>' }), 404)
      const flow = await startFlow(origin, google, now.getTime(), safeNext(url.searchParams.get('next')) ?? undefined)
      return new Response(null, { status: 302, headers: { Location: flow.location, 'Set-Cookie': flow.cookie, 'Cache-Control': 'no-store' } })
    }
    if (path === '/account/google/callback') {
      if (!google) return page(accountPage({ title: 'Not available', heading: 'Google sign-in is not available', origin, body: '' }), 404)
      const flow = await openFlow(cookieValue(request, OAUTH_COOKIE), google.stateKey, now.getTime())
      const fail = (why: string) => {
        console.warn('google sign-in refused:', why)
        return page(
          accountPage({ title: 'Sign in', heading: 'Sign in', origin, isError: true, notice: 'Google sign-in did not complete. Please try again.', body: signInForm(undefined, true, safeNext(flow?.next) ?? '') }),
          400,
          { 'Set-Cookie': clearFlowCookie() },
        )
      }
      const state = url.searchParams.get('state')
      const code = url.searchParams.get('code')
      // The cookie binds the flow to the browser that started it; the state ties this
      // response to that flow; both must hold before the code is worth exchanging.
      if (!flow || !state || state !== flow.state) return fail('state-mismatch-or-stale')
      if (!code) return fail(url.searchParams.get('error') ?? 'no-code')
      const identity = await exchangeCode(code, flow, origin, google)
      if (!identity.ok) return fail(identity.reason)
      const userId = await userForIdentity(env.ACCOUNTS, identity, now)
      const token = await createSession(env.ACCOUNTS, userId, now)
      const headers = new Headers({ Location: safeNext(flow.next) ?? '/account', 'Cache-Control': 'no-store' })
      headers.append('Set-Cookie', sessionCookie(token))
      headers.append('Set-Cookie', clearFlowCookie())
      return new Response(null, { status: 303, headers })
    }
    if (path === '/account/verify') {
      // A GET that changes state, knowingly: mail scanners prefetch links, and the only
      // effect here is marking verified an address the link was delivered to — which is
      // itself the proof the token exists to establish.
      const userId = await consumeToken(env.ACCOUNTS, url.searchParams.get('token') ?? '', 'verify', now)
      if (!userId) {
        return page(accountPage({ title: 'Link expired', heading: 'That link has expired', origin, isError: true, notice: 'Confirmation links work once, for 24 hours. Sign in with your password to get a fresh one.', body: signInForm(undefined, !!google) }), 410)
      }
      await env.ACCOUNTS.prepare('UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ? AND email_verified_at IS NULL').bind(now.toISOString(), now.toISOString(), userId).run()
      return redirect('/account/signin?notice=verified')
    }
    return page(accountPage({ title: 'Not found', heading: 'No such page', origin, body: '<p class="account-links"><a href="/account">Your account</a></p>' }), 404)
  }

  if (request.method !== 'POST') return page(accountPage({ title: 'Not allowed', heading: 'Not allowed', origin, body: '' }), 405)

  // Every write must come from our own pages. SameSite=Lax covers the cookie; this covers
  // the top-level form posts Lax allows.
  if (!isSameOriginWrite(request, url.hostname)) {
    return page(accountPage({ title: 'Refused', heading: 'That request came from another site', origin, isError: true, notice: 'Please use the forms on this site.', body: signInForm() }), 403)
  }

  const form = await readForm(request)
  if (!form) return page(accountPage({ title: 'Refused', heading: 'That did not look like a form', origin, body: '' }), 400)

  const email = (form.email ?? '').trim().toLowerCase()
  const password = form.password ?? ''
  const ipHash = await callerHash(request, now)

  const formError = (title: string, message: string, body: string, status = 400) =>
    page(accountPage({ title, heading: title, origin, isError: true, notice: message, body }), status)

  // Turnstile guards the two routes where abuse is free — and deliberately not sign-in,
  // which must keep working with JavaScript off; the rate limiter covers stuffing.
  const checkTurnstile = async (): Promise<{ error: string; status: number } | null> => {
    if (!env.TURNSTILE_SECRET_KEY) return { error: 'Accounts are not available right now. Please try again later.', status: 503 }
    const human = await verifyTurnstile(
      form[TURNSTILE_FIELD],
      { secret: env.TURNSTILE_SECRET_KEY, remoteip: request.headers.get('CF-Connecting-IP'), hostname: url.hostname, action: ACCOUNT_TURNSTILE_ACTION },
    )
    return human.ok ? null : { error: human.error, status: human.status }
  }

  if (path === '/account/signup') {
    if (!emailOk(email)) return formError('Create an account', 'That does not look like an email address.', signUpForm())
    if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD)
      return formError('Create an account', `Passwords are ${MIN_PASSWORD} to ${MAX_PASSWORD} characters.`, signUpForm(email))
    const refused = await checkTurnstile()
    if (refused) return formError('Create an account', refused.error, signUpForm(email), refused.status)
    if (await throttled(env.ACCOUNTS, ipHash, email, now))
      return formError('Create an account', 'Too many tries from here for now. Please wait an hour.', signUpForm(email), 429)

    const existing = await userByEmail(env.ACCOUNTS, email)
    if (existing) {
      // The response never says the address is taken — the mail to its owner does.
      await sendMail(env.EMAIL, { to: email, from: MAIL_FROM, ...existingAccountMail(`${origin}/account/reset`) })
      return redirect('/account/check-email')
    }
    const userId = crypto.randomUUID()
    const stamp = now.toISOString()
    // Hash BEFORE the first insert. When the PBKDF2 ceiling threw, the user row was
    // already written, and the address was stranded: registered, no password, and a retry
    // told its owner they already had an account.
    const encoded = await hashPassword(password, pepper)
    await env.ACCOUNTS.prepare('INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)').bind(userId, email, stamp, stamp).run()
    await env.ACCOUNTS.prepare('INSERT INTO user_passwords (user_id, encoded, changed_at) VALUES (?, ?, ?)').bind(userId, encoded, stamp).run()
    await sendVerification(env, origin, userId, email, now)
    return redirect('/account/check-email')
  }

  if (path === '/account/signin') {
    if (!emailOk(email) || !password) return formError('Sign in', 'Email or password did not match.', signInForm(email, !!google, safeNext(form.next) ?? ''))
    if (await throttled(env.ACCOUNTS, ipHash, email, now))
      return formError('Sign in', 'Too many tries for now. Please wait an hour, or reset your password.', signInForm(email, !!google, safeNext(form.next) ?? ''), 429)

    const user = await userByEmail(env.ACCOUNTS, email)
    const stored = user
      ? await env.ACCOUNTS.prepare('SELECT encoded FROM user_passwords WHERE user_id = ?').bind(user.id).first<{ encoded: string }>()
      : null
    if (!user || !stored) {
      // Burn the same time an honest check costs, so response time never says whether an
      // account exists.
      await hashPassword(password, pepper)
      return formError('Sign in', 'Email or password did not match.', signInForm(email, !!google, safeNext(form.next) ?? ''))
    }
    const result = await verifyPassword(password, pepper, stored.encoded)
    if (!result.ok) return formError('Sign in', 'Email or password did not match.', signInForm(email, !!google, safeNext(form.next) ?? ''))
    if (!user.email_verified_at) {
      // The right password proves it is the owner asking; the mail still only goes to the
      // address itself.
      await sendVerification(env, origin, user.id, user.email, now)
      return redirect('/account/signin?notice=unverified')
    }
    if (result.rehash) {
      await env.ACCOUNTS.prepare('UPDATE user_passwords SET encoded = ?, changed_at = ? WHERE user_id = ?').bind(await hashPassword(password, pepper), now.toISOString(), user.id).run()
    }
    const token = await createSession(env.ACCOUNTS, user.id, now)
    return redirect(safeNext(form.next) ?? '/account', { 'Set-Cookie': sessionCookie(token) })
  }

  // What an account owns, removed from the account page's own forms. The fetch API
  // (account/api.ts) calls the same store functions; there is one unpin, not two.
  if (path === '/account/pins/remove' || path === '/account/filters/remove') {
    const user = await sessionUser(env.ACCOUNTS, request, now)
    if (!user) return redirect('/account/signin')
    if (path === '/account/pins/remove') {
      if (form.event) await unpin(env.ACCOUNTS, user.userId, form.event)
      return redirect('/account?notice=unpinned')
    }
    if (form.id) await removeFilter(env.ACCOUNTS, user.userId, form.id)
    return redirect('/account?notice=view-removed')
  }

  if (path === '/account/signout') {
    const user = await sessionUser(env.ACCOUNTS, request, now)
    if (user) await destroySession(env.ACCOUNTS, user.tokenHash)
    return redirect('/account/signin?notice=signed-out', { 'Set-Cookie': clearSessionCookie() })
  }

  if (path === '/account/reset') {
    if (!emailOk(email)) return formError('Reset your password', 'That does not look like an email address.', resetRequestForm())
    const refused = await checkTurnstile()
    if (refused) return formError('Reset your password', refused.error, resetRequestForm(email), refused.status)
    if (await throttled(env.ACCOUNTS, ipHash, email, now))
      return formError('Reset your password', 'Too many tries from here for now. Please wait an hour.', resetRequestForm(email), 429)
    const user = await userByEmail(env.ACCOUNTS, email)
    if (user) {
      const token = await mintToken(env.ACCOUNTS, user.id, 'reset', now)
      await sendMail(env.EMAIL, { to: user.email, from: MAIL_FROM, ...resetMail(`${origin}/account/reset/confirm?token=${token}`) })
    }
    // The answer is the same whether the address has an account or not.
    return redirect('/account/check-email')
  }

  if (path === '/account/reset/confirm') {
    const token = form.token ?? ''
    if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD)
      return formError('Choose a new password', `Passwords are ${MIN_PASSWORD} to ${MAX_PASSWORD} characters.`, resetConfirmForm(token))
    const userId = await consumeToken(env.ACCOUNTS, token, 'reset', now)
    if (!userId) {
      return formError('Choose a new password', 'That link has expired — reset links work once, for an hour. Ask for a fresh one.', resetRequestForm(), 410)
    }
    const stamp = now.toISOString()
    await env.ACCOUNTS.prepare(
      'INSERT INTO user_passwords (user_id, encoded, changed_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET encoded = excluded.encoded, changed_at = excluded.changed_at',
    ).bind(userId, await hashPassword(password, pepper), stamp).run()
    // Following the mailed link proves control of the mailbox — the same proof verification
    // asks for — and changing the password signs out every device, including a thief's.
    await env.ACCOUNTS.prepare('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?').bind(stamp, stamp, userId).run()
    await destroyAllSessions(env.ACCOUNTS, userId)
    return redirect('/account/signin?notice=reset', { 'Set-Cookie': clearSessionCookie() })
  }

  return page(accountPage({ title: 'Not found', heading: 'No such page', origin, body: '' }), 404)
}

