import type { AccountsDb } from '../auth/db.ts'
import { rowToEvent, type PublicEvent, type Row } from '../query.ts'

/**
 * What an account owns — pins and saved views — and the one place their SQL lives. The
 * account page's forms and the /api/me endpoints both call these, so there is one unpin
 * and one delete, not two that drift.
 *
 * Every function names which database it touches by its parameter type. Pins point at
 * events in the OTHER database: `resolvePins` is the join, done here in the worker because
 * no query can span the two (see docs/user-accounts.md and CLAUDE.md).
 */

/** Enough for anyone planning a season; small enough that one reader cannot fill a table. */
export const MAX_PINS = 500
export const MAX_FILTERS = 25
export const MAX_LABEL = 60
/** D1 refuses a statement with more than 100 bound parameters. */
export const D1_MAX_PARAMS = 100

/** The minimal DB shape resolvePins needs, so a test can hand it a fake that counts binds. */
export interface EventsDb {
  prepare(query: string): { bind(...values: unknown[]): { all<T>(): Promise<{ results: T[] }> } }
}

export interface Pin {
  eventId: string
  title: string
  localDate: string
  shortCode: string
  pinnedAt: string
}

export interface SavedFilter {
  id: string
  label: string
  query: string
  createdAt: string
}

export async function listPins(db: AccountsDb, userId: string): Promise<Pin[]> {
  const { results } = await db
    .prepare('SELECT event_id, title, local_date, short_code, pinned_at FROM calendar_pins WHERE user_id = ? ORDER BY local_date, title')
    .bind(userId)
    .all<{ event_id: string; title: string; local_date: string; short_code: string; pinned_at: string }>()
  return results.map((r) => ({ eventId: r.event_id, title: r.title, localDate: r.local_date, shortCode: r.short_code, pinnedAt: r.pinned_at }))
}

export async function listFilters(db: AccountsDb, userId: string): Promise<SavedFilter[]> {
  const { results } = await db
    .prepare('SELECT id, label, query, created_at FROM calendar_filters WHERE user_id = ? ORDER BY created_at')
    .bind(userId)
    .all<{ id: string; label: string; query: string; created_at: string }>()
  return results.map((r) => ({ id: r.id, label: r.label, query: r.query, createdAt: r.created_at }))
}

export type PinResult = 'pinned' | 'full'

/** Pin with a snapshot of what the event is now. Pinning twice refreshes the snapshot. */
export async function pin(db: AccountsDb, userId: string, event: { id: string; title: string; localDate: string; shortCode: string }, now: Date): Promise<PinResult> {
  const count = await db.prepare('SELECT COUNT(*) AS n FROM calendar_pins WHERE user_id = ?').bind(userId).first<{ n: number }>()
  const already = await db.prepare('SELECT 1 AS x FROM calendar_pins WHERE user_id = ? AND event_id = ?').bind(userId, event.id).first()
  if (!already && (count?.n ?? 0) >= MAX_PINS) return 'full'
  await db
    .prepare(
      `INSERT INTO calendar_pins (user_id, event_id, title, local_date, short_code, pinned_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, event_id) DO UPDATE SET title = excluded.title, local_date = excluded.local_date, short_code = excluded.short_code`,
    )
    .bind(userId, event.id, event.title, event.localDate, event.shortCode, now.toISOString())
    .run()
  return 'pinned'
}

export async function unpin(db: AccountsDb, userId: string, eventId: string): Promise<void> {
  await db.prepare('DELETE FROM calendar_pins WHERE user_id = ? AND event_id = ?').bind(userId, eventId).run()
}

export type SaveResult = { ok: true; id: string } | { ok: false; reason: 'full' | 'label' }

/** Save a view; saving one already saved keeps the original and its label. */
export async function saveFilter(db: AccountsDb, userId: string, label: string, query: string, now: Date): Promise<SaveResult> {
  const clean = label.replace(/\s+/g, ' ').trim()
  if (!clean || clean.length > MAX_LABEL) return { ok: false, reason: 'label' }
  const existing = await db.prepare('SELECT id FROM calendar_filters WHERE user_id = ? AND query = ?').bind(userId, query).first<{ id: string }>()
  if (existing) return { ok: true, id: existing.id }
  const count = await db.prepare('SELECT COUNT(*) AS n FROM calendar_filters WHERE user_id = ?').bind(userId).first<{ n: number }>()
  if ((count?.n ?? 0) >= MAX_FILTERS) return { ok: false, reason: 'full' }
  const id = crypto.randomUUID()
  await db
    .prepare('INSERT INTO calendar_filters (id, user_id, label, query, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, query) DO NOTHING')
    .bind(id, userId, clean, query, now.toISOString())
    .run()
  return { ok: true, id }
}

/** Scoped to the user, so an id from someone else's account deletes nothing. */
export async function removeFilter(db: AccountsDb, userId: string, id: string): Promise<void> {
  await db.prepare('DELETE FROM calendar_filters WHERE user_id = ? AND id = ?').bind(userId, id).run()
}

/** What a pin's event is now, as far as the account page needs to know. */
export interface PinnedEvent {
  id: string
  shortCode: string
  title: string
  localDate: string
  localTime: string
  allDay: boolean
  timePrecision: string
  endsAtUtc: string | null
  status: string
  municipalityName: string | null
}

/**
 * The application-side join: pinned ids in ACCOUNTS, events in DB. The IN list is chunked
 * under D1's parameter ceiling, so a reader with two hundred pins is not the first to find
 * it. Every chunked read of events by id goes through here — the account page and both
 * feeds — so there is one chunker. Inactive rows come back too; callers decide what an
 * inactive row means (for a pin: withdrawn).
 */
export async function eventRowsById(db: EventsDb, eventIds: string[]): Promise<Row[]> {
  const rows: Row[] = []
  for (let i = 0; i < eventIds.length; i += D1_MAX_PARAMS) {
    const chunk = eventIds.slice(i, i + D1_MAX_PARAMS)
    const { results } = await db
      .prepare(
        `SELECT e.*, m.name AS municipality_name
           FROM events e LEFT JOIN municipalities m ON m.slug = e.municipality_slug
          WHERE e.id IN (${chunk.map(() => '?').join(',')})`,
      )
      .bind(...chunk)
      .all<Row>()
    rows.push(...results)
  }
  return rows
}

/** What each pin points at now, keyed by event id; absent means withdrawn. */
export async function resolvePins(db: EventsDb, eventIds: string[]): Promise<Map<string, PinnedEvent>> {
  const found = new Map<string, PinnedEvent>()
  for (const r of await eventRowsById(db, eventIds)) {
    // "Closed by dedup" and "gone" mean the same thing to a reader: the listing was withdrawn.
    if (r.active !== 1) continue
    found.set(r.id, {
      id: r.id, shortCode: r.short_code, title: r.title, localDate: r.local_date, localTime: r.local_time,
      allDay: r.all_day === 1, timePrecision: r.time_precision, endsAtUtc: r.ends_at_utc, status: r.status,
      municipalityName: r.municipality_name,
    })
  }
  return found
}

/**
 * A reader's pinned events that are still live, as full events for a feed or the shared
 * page. One row per event id by construction — the pins table's key is (user, event) and
 * the join returns each id once — which matters: two VEVENTs with one UID in a feed are
 * resolved differently, and badly, by every calendar app.
 */
export async function livePinnedEvents(events: EventsDb, accounts: AccountsDb, userId: string): Promise<PublicEvent[]> {
  const pins = await listPins(accounts, userId)
  if (!pins.length) return []
  const rows = await eventRowsById(events, pins.map((p) => p.eventId))
  return rows
    .filter((r) => r.active === 1)
    .map(rowToEvent)
    .sort((a, b) => a.startsAtUtc.localeCompare(b.startsAtUtc))
}

/** The event a pin request names, if it is live — a pin must start out pointing at something. */
export async function eventForPin(db: EventsDb, eventId: string): Promise<PinnedEvent | null> {
  return (await resolvePins(db, [eventId])).get(eventId) ?? null
}

/**
 * Keep a snapshot current when the account page finds its event changed — the snapshot is
 * only as useful as it is recent, since it is all a reader sees once the event is gone.
 */
export async function refreshSnapshot(db: AccountsDb, userId: string, event: PinnedEvent): Promise<void> {
  await db
    .prepare('UPDATE calendar_pins SET title = ?, local_date = ?, short_code = ? WHERE user_id = ? AND event_id = ?')
    .bind(event.title, event.localDate, event.shortCode, userId, event.id)
    .run()
}
