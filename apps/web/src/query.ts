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
}

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
 * Build a parameterised query. Values are always bound, never interpolated — these
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

  const sql = `${SELECT} WHERE ${where.join(' AND ')}
    ORDER BY e.starts_at_utc ASC
    LIMIT ${Math.max(1, Math.floor(limit))}`
  return { sql, bindings }
}
