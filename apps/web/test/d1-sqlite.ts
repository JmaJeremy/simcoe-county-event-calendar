import { readFileSync, readdirSync } from 'node:fs'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'

// Loaded at run time: the version of Vite under vitest does not know node:sqlite is a
// built-in, and tries to resolve it as a package called "sqlite".
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType }

/**
 * A D1 binding backed by a real in-memory SQLite, with a directory's real migrations
 * applied. For code whose SQL is the point — the digest sender's join, NOT EXISTS and
 * conditional claim — where a hand-written fake would only test the fake. Node 24 ships
 * node:sqlite, so `npm test` still needs no network and no install.
 *
 * Only the D1 surface this repo uses: prepare → bind → first / all / run, with run()
 * answering `{ meta: { changes } }` as D1 does. Foreign keys are on, as D1 enforces them.
 */
export function sqliteD1(migrations: URL) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  for (const file of readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, migrations), 'utf8'))
  }
  const params = (values: unknown[]) =>
    values.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v)) as Array<string | number | null>
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...bound: unknown[]) => statement(sql, bound),
    first: async <T>() => ((db.prepare(sql).get(...params(values)) as T | undefined) ?? null),
    all: async <T>() => ({ results: db.prepare(sql).all(...params(values)) as T[] }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...params(values)).changes) } }),
  })
  return {
    prepare: (sql: string) => statement(sql),
    /** For a test's own setup and assertions. */
    exec: (sql: string, ...values: unknown[]) => db.prepare(sql).run(...params(values)),
    rows: <T>(sql: string, ...values: unknown[]) => db.prepare(sql).all(...params(values)) as T[],
  }
}

export const WEB_MIGRATIONS = new URL('../migrations/', import.meta.url)
export const INGEST_MIGRATIONS = new URL('../../ingest/migrations/', import.meta.url)
