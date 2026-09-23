/**
 * The minimal shape of the ACCOUNTS binding, matching Env's in worker.ts. Its own name so
 * every auth signature says which database it touches — the one thing a reader here must
 * always know, since a query sent to DB by mistake is the bug the split exists to prevent.
 */
export interface AccountsStatement {
  all<T>(): Promise<{ results: T[] }>
  first<T>(): Promise<T | null>
  run(): Promise<unknown>
}

export interface AccountsDb {
  prepare(query: string): AccountsStatement & { bind(...values: unknown[]): AccountsStatement }
}
