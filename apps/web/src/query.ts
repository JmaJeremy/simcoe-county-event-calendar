import { MUNICIPALITIES, type Category, type Event } from '@scec/core'

/**
 * The `m` value standing for "no municipality resolved" — mostly news-site listings that
 * name no address. It rides the same parameter as a real slug so the two combine, and no
 * municipality is named this. Mirrored as UNPLACED in public/app.js.
 */
export const UNPLACED = 'unspecified'

export interface EventFilters {
  municipalities: string[]
  categories: string[]
  /** 'free' → free only; 'paid' → paid only; 'all' → everything; default → free + unknown. */
  cost: 'free' | 'paid' | 'default' | 'all'
  sources: string[]
  statuses: string[]
  includeCivic: boolean
  from?: string
  to?: string
  /** Free-text search, already cleaned by cleanSearch; '' or absent means none. */
  q?: string
  /**
   * How the home page loads the calendar in two halves, split at one date: `since` is
   * everything still running on or after it, `before` is everything over by then. They
   * are transport, not part of a view — never saved, never echoed into a link.
   */
  since?: string
  before?: string
}

/** A search is capped: it rides in URLs, saved views and SQL, and nobody types more. */
export const MAX_SEARCH_LENGTH = 80
export const MAX_SEARCH_TERMS = 5

/** What a reader typed, as it is kept: one line, single spaces, bounded. */
export const cleanSearch = (raw: string | null | undefined): string =>
  (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_SEARCH_LENGTH).trim()

/**
 * How text is compared in a search: without case, without accents, and with the curly
 * quotes a phone types read as straight ones — "cafe" finds "Café", and "children's" finds
 * "children’s" whichever apostrophe either side used. Applied to the search AND to the
 * event's words, so it is only ever like against like.
 */
export const foldSearch = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')

/**
 * A search as the folded terms that must ALL appear: words, and "quoted phrases" kept
 * whole. Matching is by substring. This rule exists twice: here, and as foldSearch /
 * searchTerms / matchesSearch in public/app.js, which is what actually filters the public
 * page. Change one, change the other — a saved view that shows 12 events on the page and
 * 9 in its feed is the bug that follows.
 */
export function searchTerms(q: string | undefined): string[] {
  const terms: string[] = []
  for (const match of foldSearch(cleanSearch(q)).matchAll(/"([^"]+)"|(\S+)/g)) {
    const term = (match[1] ?? match[2]!).replace(/"/g, '').trim()
    if (term && !terms.includes(term)) terms.push(term)
    if (terms.length === MAX_SEARCH_TERMS) break
  }
  return terms
}

/**
 * Whether an event's own words carry every term. The fields are joined by a newline, which
 * no term can contain, so a phrase never matches across two of them; app.js's searchText
 * joins the same fields in the same order.
 */
export function matchesSearch(event: PublicEvent, terms: string[]): boolean {
  if (!terms.length) return true
  const text = foldSearch(
    [event.title, event.description, event.venueName, event.address, event.organizer, event.municipalityName].map((v) => v ?? '').join('\n'),
  )
  return terms.every((term) => text.includes(term))
}

const isoDate = (value: string | null): string | undefined =>
  value && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value) ? value : undefined

/** Filters are read from the query string so every view is a shareable permalink. */
export function parseFilters(url: URL): EventFilters {
  const list = (key: string): string[] => {
    const raw = url.searchParams.get(key)
    return raw ? raw.split(',').map((v) => v.trim()).filter(Boolean) : []
  }
  const cost = url.searchParams.get('cost')
  return {
    municipalities: list('m'),
    categories: list('cat'),
    cost: cost === 'free' || cost === 'paid' || cost === 'all' ? cost : 'default',
    sources: list('src'),
    statuses: list('status'),
    // Council and committee meetings are civi-times' job; hidden unless asked for.
    includeCivic: url.searchParams.get('civic') === '1' || list('cat').includes('civic-meeting'),
    from: url.searchParams.get('from') ?? undefined,
    to: url.searchParams.get('to') ?? undefined,
    q: cleanSearch(url.searchParams.get('q')) || undefined,
    since: isoDate(url.searchParams.get('since')),
    before: isoDate(url.searchParams.get('before')),
  }
}

/**
 * Rebuild the list's own URL from whatever filters an event-page link carried, so
 * "All events" puts the reader back in the view they left rather than at the top of an
 * unfiltered list.
 *
 * Every key is re-derived and re-encoded here rather than echoed: the incoming query is
 * a stranger's text on its way into an href, and only these keys, in these shapes, may
 * come out the other side.
 */
export function listUrlFrom(url: URL): string {
  const filters = parseFilters(url)
  const out = new URLSearchParams()
  if (filters.municipalities.length) out.set('m', filters.municipalities.join(','))
  if (filters.categories.length) out.set('cat', filters.categories.join(','))
  const cost = url.searchParams.get('cost')
  if (cost === 'free' || cost === 'paid' || cost === 'all') out.set('cost', cost)
  for (const flag of ['civic', 'past']) {
    if (url.searchParams.get(flag) === '1') out.set(flag, '1')
  }
  // parseFilters passes from/to through untouched, so they are re-validated here: like
  // everything else in this function they are on their way into an href.
  for (const end of ['from', 'to'] as const) {
    const date = url.searchParams.get(end)
    if (date && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(date)) out.set(end, date)
  }
  if (filters.q) out.set('q', filters.q)
  // The view and month are the front end's own state; parseFilters knows nothing of them.
  if (url.searchParams.get('view') === 'calendar') out.set('view', 'calendar')
  const month = url.searchParams.get('month')
  if (month && /^\d{4}-\d{2}$/.test(month)) out.set('month', month)
  const query = out.toString()
  return query ? `/?${query}` : '/'
}

/** Every category the site has, for validating a query string that is about to be kept. */
export const CATEGORIES = [
  'arts', 'music', 'family', 'outdoors', 'markets', 'sports', 'community', 'education', 'civic-meeting', 'other',
] as const satisfies readonly Category[]

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

/**
 * The canonical form of a view someone saves to their account: what it SELECTS, in the
 * keys `/calendar.ics` reads, and nothing about how it was displayed (view, month, past).
 * Read with parseFilters, so a saved view is the site's own filter language and not a
 * second schema beside it. Unlike listUrlFrom, the values are checked against what exists —
 * this string is kept, and shown back on the account page, so an unknown slug is dropped
 * rather than stored. Returns '' for the default view.
 *
 * from/to are kept as the absolute dates they are. A saved "this weekend" is next
 * weekend's empty list; the account page shows the range so that is no surprise.
 */
export function savedQueryFrom(params: URLSearchParams): string {
  const filters = parseFilters(new URL(`https://x/?${params}`))
  const places = new Set<string>([...MUNICIPALITIES.map((m) => m.slug), UNPLACED])
  const known = new Set<string>(CATEGORIES)
  const out = new URLSearchParams()
  const m = [...new Set(filters.municipalities.filter((s) => places.has(s)))].sort()
  const cat = [...new Set(filters.categories.filter((c) => known.has(c)))].sort()
  if (m.length) out.set('m', m.join(','))
  if (cat.length) out.set('cat', cat.join(','))
  if (filters.cost !== 'default') out.set('cost', filters.cost)
  if (filters.includeCivic && !cat.includes('civic-meeting')) out.set('civic', '1')
  for (const end of ['from', 'to'] as const) {
    const date = filters[end]
    if (date && ISO_DATE.test(date)) out.set(end, date)
  }
  if (filters.q) out.set('q', filters.q)
  return out.toString()
}

export interface Row {
  id: string
  short_code: string
  representative_id: string
  listing_ids: string
  source_slugs: string
  municipality_slug: string | null
  municipality_name: string | null
  title: string
  description: string | null
  category: string
  starts_at_utc: string
  ends_at_utc: string | null
  local_date: string
  local_time: string
  timezone: string
  time_precision: string
  all_day: number
  venue_name: string | null
  address: string | null
  cost: string
  cost_text: string | null
  organizer: string | null
  image_url: string | null
  url: string
  status: string
  active: number
  listing_count: number
}

export type PublicEvent = Event & { municipalityName: string | null }

export function rowToEvent(row: Row): PublicEvent {
  return {
    id: row.id,
    shortCode: row.short_code,
    representativeId: row.representative_id,
    listingIds: JSON.parse(row.listing_ids || '[]') as string[],
    sourceSlugs: JSON.parse(row.source_slugs || '[]') as string[],
    municipalitySlug: row.municipality_slug,
    municipalityName: row.municipality_name,
    title: row.title,
    description: row.description,
    category: row.category as Event['category'],
    startsAtUtc: row.starts_at_utc,
    endsAtUtc: row.ends_at_utc,
    localDate: row.local_date,
    localTime: row.local_time,
    timezone: row.timezone,
    timePrecision: row.time_precision as Event['timePrecision'],
    allDay: row.all_day === 1,
    venueName: row.venue_name,
    address: row.address,
    cost: row.cost as Event['cost'],
    costText: row.cost_text,
    organizer: row.organizer,
    imageUrl: row.image_url,
    url: row.url,
    status: row.status as Event['status'],
    active: row.active === 1,
  }
}

const SELECT = `
  SELECT e.*, m.name AS municipality_name
    FROM events e
    LEFT JOIN municipalities m ON m.slug = e.municipality_slug`

/**
 * Build a parameterised query. `filters.q` is NOT in it: SQLite cannot compare text without
 * accents, so the search is applied afterwards, in JavaScript, by `selectEvents` — which is
 * what every reader of events should call. Calling this directly ignores a search.
 * Values are always bound, never interpolated — these
 * filters come straight from a URL a stranger controls.
 */
export function buildQuery(filters: EventFilters, limit = 4000): { sql: string; bindings: unknown[] } {
  const where: string[] = ['e.active = 1']
  const bindings: unknown[] = []

  const inClause = (column: string, values: string[]) => {
    if (values.length === 0) return
    where.push(`${column} IN (${values.map(() => '?').join(',')})`)
    bindings.push(...values)
  }

  // "Not specified" is just another value in the `m` list, so it ORs with real slugs.
  const places = filters.municipalities.filter((slug) => slug !== UNPLACED)
  if (filters.municipalities.length) {
    const terms: string[] = []
    if (places.length) {
      terms.push(`e.municipality_slug IN (${places.map(() => '?').join(',')})`)
      bindings.push(...places)
    }
    if (places.length !== filters.municipalities.length) terms.push('e.municipality_slug IS NULL')
    where.push(`(${terms.join(' OR ')})`)
  }
  inClause('e.category', filters.categories)
  inClause('e.status', filters.statuses)
  if (!filters.includeCivic) where.push(`e.category <> 'civic-meeting'`)
  if (filters.cost === 'free') where.push(`e.cost = 'free'`)
  else if (filters.cost === 'paid') where.push(`e.cost = 'paid'`)
  else if (filters.cost === 'default') where.push(`e.cost <> 'paid'`)

  if (filters.sources.length) {
    // source_slugs is a JSON array; a LIKE per slug is enough at this scale.
    where.push(`(${filters.sources.map(() => `e.source_slugs LIKE ?`).join(' OR ')})`)
    bindings.push(...filters.sources.map((s) => `%"${s.replace(/[%_"]/g, '')}"%`))
  }
  if (filters.from) {
    where.push('e.local_date >= ?')
    bindings.push(filters.from)
  }
  if (filters.to) {
    where.push('e.local_date <= ?')
    bindings.push(filters.to)
  }
  // The two halves of the calendar, exact complements at one date so nothing falls between
  // them. "Still running" is by start date OR end time: a festival that opened in September
  // and closes at Hallowe'en has an old local_date and is very much not over. The UTC
  // midnight is a few hours generous to Simcoe County's; the page makes the fine cut.
  if (filters.since) {
    where.push('(e.local_date >= ? OR e.ends_at_utc >= ?)')
    bindings.push(filters.since, `${filters.since}T00:00:00.000Z`)
  }
  if (filters.before) {
    where.push('(e.local_date < ? AND (e.ends_at_utc IS NULL OR e.ends_at_utc < ?))')
    bindings.push(filters.before, `${filters.before}T00:00:00.000Z`)
  }

  const sql = `${SELECT} WHERE ${where.join(' AND ')}
    ORDER BY e.starts_at_utc ASC
    LIMIT ${Math.max(1, Math.floor(limit))}`
  return { sql, bindings }
}

/**
 * The most events any one read returns. The home page read the whole calendar through a
 * cap of 4,000 until the calendar grew to 6,225: the page then held the oldest 4,000 —
 * 1,814 of them already over — and nothing after 19 November, with no sign anything was
 * missing. So the cap is well clear of the data, and a read that hits it SAYS so
 * (`truncated`), which is the part that matters when this number is next outgrown.
 */
export const MAX_EVENTS = 10_000

/** The part of a D1 binding selectEvents needs. */
export interface EventSource {
  prepare(query: string): { bind(...values: unknown[]): { all<T>(): Promise<{ results: T[] }> } }
}

/**
 * The events a set of filters selects, search included — the one way to read events by
 * filter. Everything SQL can decide is decided there; the search runs over what comes
 * back. So with a search the SQL takes no small limit (it would cut before the search had
 * chosen), and `limit` is applied to the matches instead. `truncated` is true when either
 * cut dropped something.
 */
export async function selectEventPage(db: EventSource, filters: EventFilters, limit = MAX_EVENTS): Promise<{ events: PublicEvent[]; truncated: boolean }> {
  const terms = searchTerms(filters.q)
  const sqlLimit = terms.length ? MAX_EVENTS : limit
  // One more than wanted: the only way to know a cut happened.
  const { sql, bindings } = buildQuery(filters, sqlLimit + 1)
  const { results } = await db.prepare(sql).bind(...bindings).all<Row>()
  const cut = results.length > sqlLimit
  const events = results.slice(0, sqlLimit).map(rowToEvent)
  const matches = terms.length ? events.filter((e) => matchesSearch(e, terms)) : events
  return { events: matches.slice(0, limit), truncated: cut || matches.length > limit }
}

export const selectEvents = async (db: EventSource, filters: EventFilters, limit = MAX_EVENTS): Promise<PublicEvent[]> =>
  (await selectEventPage(db, filters, limit)).events
