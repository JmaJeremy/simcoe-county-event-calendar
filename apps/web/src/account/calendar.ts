import type { AccountsDb } from '../auth/db.ts'
import { timingSafeEqual } from '../auth/password.ts'
import { randomToken } from '../auth/session.ts'

/**
 * A reader's own calendar: the private feed of their pins (SCEC-107) and the public link
 * that can share them (SCEC-108). Both are capabilities in a URL, because a calendar app
 * cannot send a cookie. Why the private one is an HMAC rather than a stored hash, and why
 * the public one is a separate value, is in migrations/0003_user_calendars.sql.
 */

export interface UserCalendar {
  userId: string
  calendarId: string
  feedGeneration: number
  shareSlug: string | null
}

type CalendarRow = { user_id: string; calendar_id: string; feed_generation: number; share_slug: string | null }

const toCalendar = (r: CalendarRow): UserCalendar => ({
  userId: r.user_id,
  calendarId: r.calendar_id,
  feedGeneration: r.feed_generation,
  shareSlug: r.share_slug,
})

const COLUMNS = 'user_id, calendar_id, feed_generation, share_slug'

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

async function mac(key: string, calendarId: string, generation: number): Promise<string> {
  const k = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', k, encoder.encode(`feed:${calendarId}:${generation}`)))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

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
