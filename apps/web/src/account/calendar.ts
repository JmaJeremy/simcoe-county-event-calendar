import type { AccountsDb } from '../auth/db.ts'
import { timingSafeEqual } from '../auth/password.ts'
import { randomToken } from '../auth/session.ts'

/**
 * A reader's own calendar: the private feed of their pins (SCEC-107) and the public link
 * that can share them (SCEC-108). Both are capabilities in a URL, because a calendar app
 * cannot send a cookie. Why the private one is an HMAC rather than a stored hash, and why
 * the public one is a separate value, is in migrations/0003_user_calendars.sql.
 */

export type DigestCadence = 'none' | 'daily' | 'weekly'

export interface UserCalendar {
  userId: string
  calendarId: string
  feedGeneration: number
  shareSlug: string | null
  /** Email digest settings (0004): hour and day in America/Toronto, day 0 = Sunday. */
  digest: DigestCadence
  digestHour: number
  digestDay: number
}

type CalendarRow = {
  user_id: string; calendar_id: string; feed_generation: number; share_slug: string | null
  digest?: string; digest_hour?: number; digest_day?: number
}

const toCalendar = (r: CalendarRow): UserCalendar => ({
  userId: r.user_id,
  calendarId: r.calendar_id,
  feedGeneration: r.feed_generation,
  shareSlug: r.share_slug,
  digest: r.digest === 'daily' || r.digest === 'weekly' ? r.digest : 'none',
  digestHour: r.digest_hour ?? 8,
  digestDay: r.digest_day ?? 4,
})

const COLUMNS = 'user_id, calendar_id, feed_generation, share_slug, digest, digest_hour, digest_day'

/** The reader's calendar row, made on first sight. */
export async function calendarFor(db: AccountsDb, userId: string, now: Date): Promise<UserCalendar> {
  const existing = await db.prepare(`SELECT ${COLUMNS} FROM user_calendars WHERE user_id = ?`).bind(userId).first<CalendarRow>()
  if (existing) return toCalendar(existing)
  await db
    .prepare('INSERT INTO user_calendars (user_id, calendar_id, feed_generation, created_at, updated_at) VALUES (?, ?, 1, ?, ?) ON CONFLICT(user_id) DO NOTHING')
    .bind(userId, randomToken().slice(0, 22), now.toISOString(), now.toISOString())
    .run()
  // Read back rather than trust what was written: a second tab may have won the insert.
  return toCalendar((await db.prepare(`SELECT ${COLUMNS} FROM user_calendars WHERE user_id = ?`).bind(userId).first<CalendarRow>())!)
}

const encoder = new TextEncoder()

/**
 * One key signs two kinds of link, told apart by the message's prefix — `feed:` for the
 * private feed, `unsub:` for a digest's unsubscribe link — so neither can stand in for the
 * other: a leaked feed URL cannot unsubscribe anyone, and an unsubscribe link opens no feed.
 */
async function hmac(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', k, encoder.encode(message)))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const mac = (key: string, calendarId: string, generation: number) => hmac(key, `feed:${calendarId}:${generation}`)

/** The private feed's token, `{calendarId}.{mac}` — recomputed, never stored. */
export async function feedToken(key: string, calendar: UserCalendar): Promise<string> {
  return `${calendar.calendarId}.${await mac(key, calendar.calendarId, calendar.feedGeneration)}`
}

/** Whose feed a token opens, or null. Constant-time on the MAC, like every secret here. */
export async function userForFeedToken(db: AccountsDb, key: string, token: string): Promise<string | null> {
  const match = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(token)
  if (!match) return null
  const row = await db.prepare(`SELECT ${COLUMNS} FROM user_calendars WHERE calendar_id = ?`).bind(match[1]).first<CalendarRow>()
  if (!row) return null
  const expected = await mac(key, row.calendar_id, row.feed_generation)
  return timingSafeEqual(encoder.encode(expected), encoder.encode(match[2]!)) ? row.user_id : null
}

/**
 * A digest's unsubscribe token, `{calendarId}.{mac}`. Not rotated with the feed: a digest
 * already in someone's inbox must keep its unsubscribe link working.
 */
export async function unsubscribeToken(key: string, calendarId: string): Promise<string> {
  return `${calendarId}.${await hmac(key, `unsub:${calendarId}`)}`
}

export async function userForUnsubscribeToken(db: AccountsDb, key: string, token: string): Promise<string | null> {
  const match = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(token)
  if (!match) return null
  const expected = await hmac(key, `unsub:${match[1]}`)
  if (!timingSafeEqual(encoder.encode(expected), encoder.encode(match[2]!))) return null
  const row = await db.prepare('SELECT user_id FROM user_calendars WHERE calendar_id = ?').bind(match[1]).first<{ user_id: string }>()
  return row?.user_id ?? null
}

/** "Make a new link": every earlier feed URL stops matching at once. */
export async function rotateFeed(db: AccountsDb, userId: string, now: Date): Promise<void> {
  await db.prepare('UPDATE user_calendars SET feed_generation = feed_generation + 1, updated_at = ? WHERE user_id = ?').bind(now.toISOString(), userId).run()
}

/** On mints a fresh slug every time; off forgets it, so the old link is dead for good. */
export async function setSharing(db: AccountsDb, userId: string, on: boolean, now: Date): Promise<void> {
  await db
    .prepare('UPDATE user_calendars SET share_slug = ?, updated_at = ? WHERE user_id = ?')
    .bind(on ? randomToken().slice(0, 16) : null, now.toISOString(), userId)
    .run()
}

export const SHARE_SLUG = /^[A-Za-z0-9_-]{16}$/

export async function userForShareSlug(db: AccountsDb, slug: string): Promise<string | null> {
  if (!SHARE_SLUG.test(slug)) return null
  const row = await db.prepare('SELECT user_id FROM user_calendars WHERE share_slug = ?').bind(slug).first<{ user_id: string }>()
  return row?.user_id ?? null
}
