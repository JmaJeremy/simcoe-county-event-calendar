import type { AccountsDb } from './db.ts'

/**
 * Sessions are opaque 256-bit tokens, stored as their SHA-256 hash — never the token, so
 * a dump of user_sessions signs nobody in — and stateful on purpose: revocation and
 * "sign out everywhere" must actually work, which a stateless signed cookie cannot do.
 * The cost is one indexed read per signed-in request, on a small table.
 *
 * The cookie's __Host- prefix is a browser-enforced contract: Secure, Path=/, no Domain,
 * so it cannot be set from a subdomain or shadowed on one. SameSite=Lax plus the
 * same-origin write check (see routes.ts) is the CSRF defence, the same pair the console
 * relies on — no CSRF tokens to mint or verify.
 */
export const SESSION_COOKIE = '__Host-session'

/** A session ends after this long unused, whatever its age... */
export const IDLE_DAYS = 30
/** ...and at this age regardless of use, so an unattended sign-in cannot live forever. */
export const ABSOLUTE_DAYS = 180
/** last_seen_at rolls forward at most this often, so a busy reader is one write an hour. */
const TOUCH_MS = 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

export const randomToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function sha256hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export const sessionCookie = (token: string): string =>
  `${SESSION_COOKIE}=${token}; Max-Age=${IDLE_DAYS * 24 * 60 * 60}; Path=/; Secure; HttpOnly; SameSite=Lax`

export const clearSessionCookie = (): string => `${SESSION_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`

export function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

export interface SessionUser {
  userId: string
  email: string
  emailVerifiedAt: string | null
  displayName: string | null
  tokenHash: string
}

export async function createSession(db: AccountsDb, userId: string, now: Date): Promise<string> {
  const token = randomToken()
  const expires = new Date(now.getTime() + ABSOLUTE_DAYS * DAY_MS).toISOString()
  await db
    .prepare('INSERT INTO user_sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256hex(token), userId, now.toISOString(), now.toISOString(), expires)
    .run()
  return token
}

/** The signed-in user, or null. Rolls last_seen_at forward at most once an hour. */
export async function sessionUser(db: AccountsDb, request: Request, now: Date): Promise<SessionUser | null> {
  const token = cookieValue(request, SESSION_COOKIE)
  if (!token) return null
  const tokenHash = await sha256hex(token)
  const row = await db
    .prepare(
      `SELECT s.user_id, s.last_seen_at, s.expires_at, u.email, u.email_verified_at, u.display_name
         FROM user_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
    )
    .bind(tokenHash)
    .first<{ user_id: string; last_seen_at: string; expires_at: string; email: string; email_verified_at: string | null; display_name: string | null }>()
  if (!row) return null

  const idleCutoff = new Date(now.getTime() - IDLE_DAYS * DAY_MS).toISOString()
  if (row.expires_at <= now.toISOString() || row.last_seen_at <= idleCutoff) {
    await db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').bind(tokenHash).run()
    return null
  }
  if (new Date(row.last_seen_at).getTime() + TOUCH_MS < now.getTime()) {
    await db.prepare('UPDATE user_sessions SET last_seen_at = ? WHERE token_hash = ?').bind(now.toISOString(), tokenHash).run()
  }
  return {
    userId: row.user_id,
    email: row.email,
    emailVerifiedAt: row.email_verified_at,
    displayName: row.display_name,
    tokenHash,
  }
}

export async function destroySession(db: AccountsDb, tokenHash: string): Promise<void> {
  await db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').bind(tokenHash).run()
}

/** "Sign out everywhere": every session for the user, including the caller's own. */
export async function destroyAllSessions(db: AccountsDb, userId: string): Promise<void> {
  await db.prepare('DELETE FROM user_sessions WHERE user_id = ?').bind(userId).run()
}
