import type { AccountsDb } from './db.ts'
import { randomToken, sha256hex } from './session.ts'

/**
 * Email-verification and password-reset tokens: 256-bit capabilities that travel in a
 * link, stored hashed like sessions, single-use, short-lived. Consuming one is a
 * conditional UPDATE that claims the row — used_at IS NULL AND not expired — so a link
 * followed twice, or raced from two tabs, works exactly once.
 */
export type TokenPurpose = 'verify' | 'reset'

/** A verification link has a day; a reset link has an hour to be misused, so it gets less. */
export const TOKEN_TTL_MS: Record<TokenPurpose, number> = {
  verify: 24 * 60 * 60 * 1000,
  reset: 60 * 60 * 1000,
}

export async function mintToken(db: AccountsDb, userId: string, purpose: TokenPurpose, now: Date): Promise<string> {
  const token = randomToken()
  await db
    .prepare('INSERT INTO user_tokens (token_hash, user_id, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(
      await sha256hex(token),
      userId,
      purpose,
      now.toISOString(),
      new Date(now.getTime() + TOKEN_TTL_MS[purpose]).toISOString(),
    )
    .run()
  return token
}

/** The user the token belongs to, claiming it in the same statement — or null. */
export async function consumeToken(db: AccountsDb, raw: string, purpose: TokenPurpose, now: Date): Promise<string | null> {
  if (!raw || raw.length > 64) return null
  const tokenHash = await sha256hex(raw)
  // Claim before read: the UPDATE is the atomic step, and a second caller finds used_at set.
  const claimed = (await db
    .prepare('UPDATE user_tokens SET used_at = ? WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?')
    .bind(now.toISOString(), tokenHash, purpose, now.toISOString())
    .run()) as { meta?: { changes?: number } }
  if (!claimed?.meta || claimed.meta.changes !== 1) return null
  const row = await db.prepare('SELECT user_id FROM user_tokens WHERE token_hash = ?').bind(tokenHash).first<{ user_id: string }>()
  return row?.user_id ?? null
}
