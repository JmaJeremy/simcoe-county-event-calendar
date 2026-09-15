import {
  MANUAL_SOURCE_SLUG,
  MUNICIPALITIES,
  buildClusters,
  sourceBySlug,
  type Listing,
} from '@scec/core'
import type { JWTVerifyGetKey } from 'jose'
import { isSameOriginWrite, verifyAccess } from './access.ts'
import {
  AUTO_CATEGORY,
  CATEGORY_OPTIONS,
  COST_OPTIONS,
  STATUS_OPTIONS,
  buildManualListing,
  parseEventForm,
} from './console-form.ts'
import {
  assignClusterStatements,
  rowToListing,
  runBatched,
  upsertEventStatements,
  upsertListingStatements,
  upsertRegistry,
  type D1Like,
  type ListingRow,
} from './repository.ts'

/**
 * The admin console at console.outinsimcoe.ca: add, edit and remove events by hand, and
 * review what visitors suggest through the site's form.
 *
 * Every event it creates is a listing from the `manual` source, never a row written
 * straight into `events`. Dedup rebuilds events from listings on every run and switches
 * off any event with no listing behind it, so a bare event would vanish within two hours.
 * As a listing it survives, and it can also merge with a scraped copy of the same event —
 * where, ranked first, it becomes the version the site shows.
 *
 * So the event appears at once rather than at the next run, each write also stores the
 * event dedup would build from that one listing, under the id dedup will keep for it.
 */

export interface ConsoleEnv {
  DB: D1Like
  CONSOLE_HOST?: string
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUD?: string
  /** The public site, for links to an event's page. */
  PUBLIC_ORIGIN?: string
  /** Posters uploaded with suggestions. The web worker writes them; the console only reads. */
  POSTERS?: { get(key: string): Promise<{ body: ReadableStream } | null> }
}

const MANUAL_ID_PREFIX = `${MANUAL_SOURCE_SLUG}:`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  // No scripts at all; forms may only post back here; nobody may frame it.
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'Referrer-Policy': 'same-origin',
}

const page = (body: string, status = 200): Response => new Response(body, { status, headers: HEADERS })
const redirect = (location: string): Response =>
  new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store' } })

/**
 * @param keys Only for tests, which sign Access tokens with a local key pair.
 */
export async function handleConsole(request: Request, env: ConsoleEnv, keys?: JWTVerifyGetKey): Promise<Response> {
  const auth = await verifyAccess(request, { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD }, keys)
  if (!auth.ok) {
    console.warn('console: access refused', auth.reason)
    return page(shell('Not signed in', `<p>This console is only reachable through Cloudflare Access.</p>`, ''), 403)
  }

  const url = new URL(request.url)
  const host = env.CONSOLE_HOST ?? url.hostname
  if (request.method === 'POST' && !isSameOriginWrite(request, host)) {
    console.warn('console: cross-site write refused', request.headers.get('Origin'), request.headers.get('Sec-Fetch-Site'))
    return page(shell('Refused', '<p>That change did not come from this console, so it was not made.</p>', auth.email), 403)
  }

  const publicOrigin = (env.PUBLIC_ORIGIN ?? 'https://outinsimcoe.ca').replace(/\/$/, '')
  const path = url.pathname.replace(/\/+$/, '') || '/'
  const route = path.match(/^\/events\/([^/]+)(?:\/(remove|restore))?$/)
  const suggestionRoute = path.match(/^\/suggestions\/([^/]+)(?:\/(poster|dismiss|reopen))?$/)

  try {
    if (path === '/' && request.method === 'GET') return page(await listPage(env.DB, url, publicOrigin, auth.email))
    if (path === '/new' && request.method === 'GET') return await newPage(env.DB, url, publicOrigin, auth.email)
    if (path === '/events' && request.method === 'POST') return await createEvent(env.DB, request, auth.email)
    if (path === '/suggestions' && request.method === 'GET') return page(await suggestionsPage(env.DB, url, auth.email))

    if (suggestionRoute) {
      const [, id, action] = suggestionRoute
      if (!UUID.test(id!)) return notFound(auth.email)
      if (!action && request.method === 'GET') return await suggestionPage(env.DB, id!, auth.email)
      if (action === 'poster' && request.method === 'GET') return await posterResponse(env, id!, auth.email)
      if ((action === 'dismiss' || action === 'reopen') && request.method === 'POST') {
        return await setDismissed(env.DB, id!, action === 'dismiss')
      }
    }

    if (route) {
      const [, uuid, action] = route
      if (!UUID.test(uuid!)) return notFound(auth.email)
      if (!action && request.method === 'GET') return await editPage(env.DB, uuid!, auth.email)
      if (!action && request.method === 'POST') return await updateEvent(env.DB, request, uuid!, auth.email)
      if (action && request.method === 'POST') return await setActive(env.DB, uuid!, action === 'restore')
    }
    return notFound(auth.email)
  } catch (err) {
    console.error('console: request failed', err)
    return page(
      shell('Something went wrong', `<p>The change was not saved: ${escapeHtml(err instanceof Error ? err.message : String(err))}</p><p><a href="/">Back to the console</a></p>`, auth.email),
      500,
    )
  }
}

const notFound = (email: string): Response =>
  page(shell('Not found', '<p>There is nothing at that address. <a href="/">Back to the console</a></p>', email), 404)

/* ------------------------------------------------------------------------- writes */

async function readForm(request: Request): Promise<Record<string, unknown>> {
  return Object.fromEntries(await request.formData())
}

async function createEvent(db: D1Like, request: Request, email: string): Promise<Response> {
  const form = await readForm(request)
  // Opened from a suggestion: saving approves it.
  const suggestion = typeof form.from === 'string' && UUID.test(form.from) ? await loadSuggestion(db, form.from) : null
  const parsed = parseEventForm(form)
  if (!parsed.ok) return page(formPage({ email, values: parsed.values, errors: parsed.errors, suggestion }), 400)

  const listing = buildManualListing(parsed.input, crypto.randomUUID())
  await writeListing(db, listing, { eventId: null, eventCreatedAt: null, active: true })
  if (suggestion) {
    // This is also what makes its poster public: the site's /posters/ route serves only
    // the posters of suggestions approved as events.
    await runBatched(db, [
      db
        .prepare("UPDATE suggestions SET handled_at = ?, handled_as = 'event', handled_listing_id = ? WHERE id = ?")
        .bind(new Date().toISOString(), listing.id, suggestion.id),
    ])
  }
  return redirect(`/?saved=${encodeURIComponent(listing.externalId)}${suggestion ? '&suggestion=1' : ''}`)
}

async function updateEvent(db: D1Like, request: Request, uuid: string, email: string): Promise<Response> {
  const existing = await loadManual(db, uuid)
  if (!existing) return notFound(email)

  const parsed = parseEventForm(await readForm(request))
  if (!parsed.ok) return page(formPage({ email, uuid, values: parsed.values, errors: parsed.errors }), 400)

  const listing = buildManualListing(parsed.input, uuid)
  const cluster = await loadCluster(db, existing.row.cluster_id)
  const solo = !cluster || isSolo(cluster, listing.id)
  await writeListing(db, listing, {
    eventId: solo ? cluster?.id ?? null : null,
    eventCreatedAt: solo ? cluster?.created_at ?? null : null,
    active: existing.row.active === 1,
    // Merged with scraped listings: the event is theirs too, and the next dedup run
    // rebuilds it with this listing as its representative.
    skipEvent: !solo,
  })
  return redirect(`/?saved=${encodeURIComponent(uuid)}${solo ? '' : '&merged=1'}`)
}

/** Remove (or bring back) a manual event. A removal flips `active`, never deletes. */
async function setActive(db: D1Like, uuid: string, active: boolean): Promise<Response> {
  const existing = await loadManual(db, uuid)
  if (!existing) return redirect('/')
  const now = new Date().toISOString()
  const id = `${MANUAL_ID_PREFIX}${uuid}`
  const cluster = await loadCluster(db, existing.row.cluster_id)
  const statements = [
    active
      ? db.prepare('UPDATE listings SET active = 1, removed_at = NULL WHERE id = ?').bind(id)
      : db.prepare('UPDATE listings SET active = 0, removed_at = ? WHERE id = ?').bind(now, id),
  ]
  // On its own, the event goes with it now. Merged, it stays up while a calendar still
  // lists it; dedup settles that at the next run.
  if (cluster && isSolo(cluster, id)) {
    statements.push(db.prepare('UPDATE events SET active = ?, updated_at = ? WHERE id = ?').bind(active ? 1 : 0, now, cluster.id))
  }
  await runBatched(db, statements)
  return redirect(`/?${active ? 'restored' : 'removed'}=${encodeURIComponent(uuid)}`)
}

/**
 * Store the listing and, unless it has merged with others, the event dedup would make
 * of it. Built by dedup's own `buildClusters`, not by hand, so the two cannot disagree —
 * and under the event's existing id, which `buildClusters` keeps for a listing already in
 * a cluster, so an edit never changes the event's short link.
 */
async function writeListing(
  db: D1Like,
  listing: Listing,
  cluster: { eventId: string | null; eventCreatedAt: string | null; active: boolean; skipEvent?: boolean },
): Promise<void> {
  const now = new Date().toISOString()
  const source = sourceBySlug(MANUAL_SOURCE_SLUG)!
  // Listings reference their source, and the manual source is not one the ingest run
  // fetches. Registering it here means the very first save cannot trip the foreign key.
  await upsertRegistry(db, [], [source])

  const stored = { ...listing, active: cluster.active, clusterId: cluster.eventId }
  const statements = [...upsertListingStatements(db, [listing], now)]
  // The upsert always marks a listing active; an edit to a removed event keeps it removed.
  if (!cluster.active) statements.push(db.prepare('UPDATE listings SET active = 0, removed_at = ? WHERE id = ?').bind(now, listing.id))

  if (!cluster.skipEvent) {
    const { events, assignments } = buildClusters({
      listings: [stored],
      sameEdges: [],
      existingClusters: cluster.eventId ? [{ id: cluster.eventId, createdAt: cluster.eventCreatedAt ?? now }] : [],
      priorityOf: (slug) => sourceBySlug(slug)?.priority ?? 50,
    })
    statements.push(...upsertEventStatements(db, events, now), ...assignClusterStatements(db, assignments))
  }
  await runBatched(db, statements)
}

/* -------------------------------------------------------------------------- reads */

interface ClusterRow {
  id: string
  short_code: string
  created_at: string
  listing_ids: string
  listing_count: number
  active: number
}

const isSolo = (cluster: ClusterRow, listingId: string): boolean => {
  const ids = JSON.parse(cluster.listing_ids || '[]') as string[]
  return ids.length === 1 && ids[0] === listingId
}

async function loadManual(db: D1Like, uuid: string): Promise<{ row: ListingRow; listing: Listing } | null> {
  const row = await db
    .prepare('SELECT * FROM listings WHERE id = ? AND source_slug = ?')
    .bind(`${MANUAL_ID_PREFIX}${uuid}`, MANUAL_SOURCE_SLUG)
    .first<ListingRow>()
  return row ? { row, listing: rowToListing(row, 'manual') } : null
}

async function loadCluster(db: D1Like, id: string | null): Promise<ClusterRow | null> {
  if (!id) return null
  return db
    .prepare('SELECT id, short_code, created_at, listing_ids, listing_count, active FROM events WHERE id = ?')
    .bind(id)
    .first<ClusterRow>()
}

/* -------------------------------------------------------------------------- pages */

const todayLocal = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })

function when(row: ListingRow): string {
  const date = new Date(`${row.local_date}T00:00:00Z`).toLocaleDateString('en-CA', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  })
  return row.all_day === 1 || row.time_precision === 'date-only' ? `${date} · all day` : `${date} · ${row.local_time}`
}

async function listPage(db: D1Like, url: URL, publicOrigin: string, email: string): Promise<string> {
  const { results } = await db
    .prepare(
      `SELECT l.*, e.short_code AS event_code, e.listing_count AS event_listings
         FROM listings l LEFT JOIN events e ON e.id = l.cluster_id
        WHERE l.source_slug = ?`,
    )
    .bind(MANUAL_SOURCE_SLUG)
    .all<ListingRow & { event_code: string | null; event_listings: number | null }>()

  const today = todayLocal()
  const upcoming = results.filter((r) => r.local_date >= today).sort((a, b) => a.starts_at_utc.localeCompare(b.starts_at_utc))
  const past = results.filter((r) => r.local_date < today).sort((a, b) => b.starts_at_utc.localeCompare(a.starts_at_utc))

  const flash = flashMessage(url, results, publicOrigin)
  const waiting = (await db.prepare('SELECT COUNT(*) AS n FROM suggestions WHERE handled_at IS NULL').first<{ n: number }>())?.n ?? 0
  const row = (r: (typeof results)[number]): string => {
    const uuid = r.id.slice(MANUAL_ID_PREFIX.length)
    const place = MUNICIPALITIES.find((m) => m.slug === r.municipality_slug)?.shortName ?? 'Not specified'
    const flags = [
      r.active === 1 ? '' : '<span class="flag off">Removed</span>',
      r.status === 'cancelled' ? '<span class="flag warn">Cancelled</span>' : '',
      r.status === 'rescheduled' ? '<span class="flag warn">Rescheduled</span>' : '',
      (r.event_listings ?? 1) > 1 ? `<span class="flag">Merged with ${(r.event_listings ?? 1) - 1} listing${r.event_listings === 2 ? '' : 's'}</span>` : '',
    ].join('')
    const view = r.event_code
      ? `<a href="${escapeHtml(`${publicOrigin}/e/${r.event_code}`)}" target="_blank" rel="noopener">View on site</a>`
      : ''
    const toggle = `<form method="post" action="/events/${uuid}/${r.active === 1 ? 'remove' : 'restore'}">
        <button type="submit" class="link">${r.active === 1 ? 'Remove' : 'Restore'}</button></form>`
    return `<li class="${r.active === 1 ? '' : 'is-off'}">
      <div class="row-main"><a href="/events/${uuid}"><strong>${escapeHtml(r.title)}</strong></a>${flags}</div>
      <div class="row-meta">${escapeHtml(when(r))} · ${escapeHtml(place)}${r.venue_name ? ` · ${escapeHtml(r.venue_name)}` : ''}</div>
      <div class="row-actions"><a href="/events/${uuid}">Edit</a>${view}${toggle}</div>
    </li>`
  }

  const section = (heading: string, rows: typeof results, empty: string): string =>
    `<h2>${heading}</h2>${rows.length ? `<ul class="rows">${rows.map(row).join('')}</ul>` : `<p class="muted">${empty}</p>`}`

  return shell(
    'Events added by hand',
    `${flash}
    ${waiting ? `<p class="notice">${waiting} suggestion${waiting === 1 ? '' : 's'} from the site waiting. <a href="/suggestions">Review ${waiting === 1 ? 'it' : 'them'}</a></p>` : ''}
    <p><a class="button" href="/new">Add an event</a></p>
    ${section('Upcoming', upcoming, 'No upcoming events added by hand yet.')}
    ${past.length ? section('Past', past, '') : ''}`,
    email,
  )
}

function flashMessage(url: URL, rows: Array<ListingRow & { event_code: string | null }>, publicOrigin: string): string {
  const pick = (key: string) => {
    const uuid = url.searchParams.get(key)
    return uuid ? rows.find((r) => r.id === `${MANUAL_ID_PREFIX}${uuid}`) : undefined
  }
  const saved = pick('saved')
  if (saved) {
    const link = saved.event_code ? ` <a href="${escapeHtml(`${publicOrigin}/e/${saved.event_code}`)}" target="_blank" rel="noopener">See it on the site</a>.` : ''
    const merged = url.searchParams.get('merged') === '1'
      ? ' It is merged with a calendar’s copy of the same event, so the public page catches up at the next ingest run (within two hours).'
      : ' It is on the site now; if a calendar lists the same event, the next ingest run merges the two.'
    const approved = url.searchParams.get('suggestion') === '1' ? ' The suggestion it came from is marked done.' : ''
    return `<p class="flash">Saved “${escapeHtml(saved.title)}”.${merged}${approved}${link}</p>`
  }
  const removed = pick('removed')
  // Its own page still opens for anyone holding the link; everything that lists events —
  // the calendar, municipality pages, feeds and the sitemap — drops it.
  if (removed) return `<p class="flash">Removed “${escapeHtml(removed.title)}” from the site’s listings, calendar feeds and sitemap. You can restore it below.</p>`
  const restored = pick('restored')
  if (restored) return `<p class="flash">Restored “${escapeHtml(restored.title)}”.</p>`
  return ''
}

async function editPage(db: D1Like, uuid: string, email: string): Promise<Response> {
  const existing = await loadManual(db, uuid)
  if (!existing) return notFound(email)
  return page(formPage({ email, uuid, values: valuesFromRow(existing.row) }))
}

/** A stored listing back into the form's own field names. */
function valuesFromRow(row: ListingRow): Record<string, string> {
  const allDay = row.all_day === 1 || row.time_precision === 'date-only'
  const endLocal = row.ends_at_utc
    ? new Intl.DateTimeFormat('sv-SE', {
        timeZone: row.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(row.ends_at_utc))
    : null
  const [endDate, endTime] = endLocal ? endLocal.split(' ') : [null, null]
  return {
    title: row.title,
    municipality: row.municipality_slug ?? '',
    category: row.category,
    date: row.local_date,
    start_time: allDay ? '' : row.local_time,
    end_date: endDate && endDate !== row.local_date ? endDate : '',
    end_time: allDay || !endTime ? '' : endTime,
    venue: row.venue_name ?? '',
    address: row.address ?? '',
    cost: row.cost,
    cost_text: row.cost_text ?? '',
    description: row.description ?? '',
    organizer: row.organizer ?? '',
    url: row.url ?? '',
    image_url: row.image_url ?? '',
    status: row.status,
  }
}

function formPage(options: {
  email: string
  uuid?: string
  values?: Record<string, string>
  errors?: Record<string, string>
  /** The suggestion this new event is being made from. */
  suggestion?: SuggestionRow | null
}): string {
  const values = options.values ?? {}
  const errors = options.errors ?? {}
  const v = (key: string) => escapeHtml(values[key] ?? '')
  const error = (key: string) => (errors[key] ? `<span class="error">${escapeHtml(errors[key]!)}</span>` : '')
  const select = (name: string, options: ReadonlyArray<readonly [string, string]>, fallback: string) => {
    const current = values[name] ?? fallback
    return `<select id="f-${name}" name="${name}">${options
      .map(([key, label]) => `<option value="${escapeHtml(key)}"${key === current ? ' selected' : ''}>${escapeHtml(label)}</option>`)
      .join('')}</select>`
  }
  const field = (name: string, label: string, control: string, hint = '') =>
    `<div class="field${errors[name] ? ' has-error' : ''}"><label for="f-${name}">${label}</label>${control}${hint ? `<span class="hint">${hint}</span>` : ''}${error(name)}</div>`
  const input = (name: string, type = 'text', extra = '') => `<input id="f-${name}" name="${name}" type="${type}" value="${v(name)}" ${extra}>`

  const places: Array<[string, string]> = [['', 'Not specified'], ...MUNICIPALITIES.map((m): [string, string] => [m.slug, m.name])]
  const categories: ReadonlyArray<readonly [string, string]> = [[AUTO_CATEGORY, 'Work it out from the title'], ...CATEGORY_OPTIONS]
  const action = options.uuid ? `/events/${options.uuid}` : '/events'
  const s = options.uuid ? null : options.suggestion ?? null
  const heading = options.uuid ? 'Edit event' : s ? 'Add an event from a suggestion' : 'Add an event'
  const fromPanel = s
    ? `<div class="from-suggestion">
        <p><strong>From a suggestion</strong>${s.name ? ` by ${escapeHtml(s.name)}` : ''}, received ${escapeHtml(received(s.created_at))}
          · <a href="/suggestions/${s.id}">See the suggestion</a></p>
        <p>Check the details, since they are what a visitor typed. Saving adds the event and marks the suggestion done.</p>
        ${s.comments ? `<p class="muted pre">Their comments, which are not copied into the event: ${escapeHtml(s.comments)}</p>` : ''}
        ${s.poster_key ? `<p><img class="thumb" src="/suggestions/${s.id}/poster" alt="The poster sent with the suggestion"></p>` : ''}
      </div>`
    : ''

  return shell(
    heading,
    `${Object.keys(errors).length ? '<p class="flash error">Some fields need another look — see below.</p>' : ''}
    ${fromPanel}
    <form method="post" action="${action}" class="event-form">
      ${s ? `<input type="hidden" name="from" value="${s.id}">` : ''}
      ${field('title', 'Title', input('title', 'text', 'required maxlength="200"'))}
      <div class="pair">
        ${field('municipality', 'Municipality', select('municipality', places, ''))}
        ${field('category', 'Category', select('category', categories, AUTO_CATEGORY))}
      </div>
      <div class="pair">
        ${field('date', 'Date', input('date', 'date', 'required'))}
        ${field('start_time', 'Start time', input('start_time', 'time'), 'Leave blank for an all-day event.')}
      </div>
      <div class="pair">
        ${field('end_date', 'End date', input('end_date', 'date'), 'Only if it runs over more than one day.')}
        ${field('end_time', 'End time', input('end_time', 'time'), 'Optional. The site hides a timed event once this passes.')}
      </div>
      <div class="pair">
        ${field('venue', 'Venue', input('venue', 'text', 'maxlength="200"'))}
        ${field('address', 'Address', input('address', 'text', 'maxlength="300"'))}
      </div>
      <div class="pair">
        ${field('cost', 'Cost', select('cost', COST_OPTIONS, 'unknown'))}
        ${field('cost_text', 'Price details', input('cost_text', 'text', 'maxlength="120" placeholder="Adults $10, kids free"'))}
      </div>
      ${field('description', 'Description', `<textarea id="f-description" name="description" rows="7" maxlength="4000">${v('description')}</textarea>`)}
      <div class="pair">
        ${field('organizer', 'Organizer', input('organizer', 'text', 'maxlength="200"'))}
        ${field('status', 'Status', select('status', STATUS_OPTIONS, 'scheduled'))}
      </div>
      ${field('url', 'Link to more information', input('url', 'url', 'maxlength="2000" placeholder="https://"'), 'Optional. Without one, the event page has no “View the listing” button.')}
      ${field('image_url', 'Poster image', input('image_url', 'url', 'maxlength="2000" placeholder="https://"'), s?.poster_key && values.image_url?.includes(s.poster_key)
        ? 'The suggested poster, filled in for you. It becomes public when you add this event; clear it to leave the poster out.'
        : 'Optional, https only.')}
      <p class="actions"><button type="submit" class="button">${options.uuid ? 'Save changes' : 'Add event'}</button> <a href="/">Cancel</a></p>
    </form>`,
    options.email,
  )
}

/* -------------------------------------------------------------------- suggestions */

/*
 * What visitors send through the site's "Are we missing something?" form. The web worker
 * writes these rows and puts any poster in R2; here they are read, their posters shown
 * behind Access, and an event suggestion becomes a manual event through the ordinary
 * form, filled in from it. Nothing is ever deleted: a suggestion is waiting, added as an
 * event, or dismissed.
 */

interface SuggestionRow {
  id: string
  kind: 'event' | 'website'
  name: string | null
  email: string | null
  title: string | null
  url: string | null
  event_date: string | null
  event_time: string | null
  description: string | null
  comments: string | null
  created_at: string
  admin_mail: string | null
  user_mail: string | null
  poster_key: string | null
  poster_type: string | null
  poster_error: string | null
  handled_at: string | null
  handled_as: 'event' | 'dismissed' | null
  handled_listing_id: string | null
}

/** The types the web worker can have decided from a file's bytes. Nothing else is served. */
const POSTER_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

const loadSuggestion = (db: D1Like, id: string): Promise<SuggestionRow | null> =>
  db.prepare('SELECT * FROM suggestions WHERE id = ?').bind(id).first<SuggestionRow>()

const received = (iso: string): string =>
  new Date(iso).toLocaleString('en-CA', { timeZone: 'America/Toronto', dateStyle: 'medium', timeStyle: 'short' })

const suggestionLabel = (s: Pick<SuggestionRow, 'title' | 'url'>): string => s.title ?? s.url ?? 'No title given'

async function newPage(db: D1Like, url: URL, publicOrigin: string, email: string): Promise<Response> {
  const from = url.searchParams.get('from')
  if (!from) return page(formPage({ email }))
  const suggestion = UUID.test(from) ? await loadSuggestion(db, from) : null
  if (!suggestion) return notFound(email)
  return page(formPage({ email, suggestion, values: valuesFromSuggestion(suggestion, publicOrigin) }))
}

/**
 * A suggestion in the event form's own field names. The comments stay out: they were
 * written to us, not for the public page.
 */
function valuesFromSuggestion(s: SuggestionRow, publicOrigin: string): Record<string, string> {
  return {
    title: s.title ?? '',
    url: s.url ?? '',
    date: s.event_date ?? '',
    start_time: s.event_time ?? '',
    description: s.description ?? '',
    // Its public address once the event is saved; see servePoster in apps/web/src/worker.ts.
    image_url: s.poster_key ? `${publicOrigin}/posters/${s.poster_key}` : '',
  }
}

function handledNote(s: Pick<SuggestionRow, 'handled_at' | 'handled_as' | 'handled_listing_id'>): string {
  if (!s.handled_at) return ''
  if (s.handled_as !== 'event') return '<span class="flag off">Dismissed</span>'
  const uuid = s.handled_listing_id?.startsWith(MANUAL_ID_PREFIX) ? s.handled_listing_id.slice(MANUAL_ID_PREFIX.length) : null
  return `<span class="flag ok">Added as an event</span>${uuid && UUID.test(uuid) ? ` <a href="/events/${uuid}">Edit the event</a>` : ''}`
}

async function suggestionsPage(db: D1Like, url: URL, email: string): Promise<string> {
  const { results } = await db
    .prepare(
      `SELECT id, kind, name, title, url, event_date, event_time, created_at, poster_key, handled_at, handled_as, handled_listing_id
         FROM suggestions ORDER BY created_at DESC LIMIT 300`,
    )
    .all<SuggestionRow>()
  const waiting = results.filter((s) => !s.handled_at)
  const done = results.filter((s) => s.handled_at).slice(0, 50)

  const row = (s: SuggestionRow): string => {
    const when = s.event_date ? ` · for ${escapeHtml(s.event_date)}${s.event_time ? ` at ${escapeHtml(s.event_time)}` : ''}` : ''
    return `<li>
      <div class="row-main"><a href="/suggestions/${s.id}"><strong>${escapeHtml(suggestionLabel(s))}</strong></a><span class="flag">${
        s.kind === 'website' ? 'Website' : 'Event'
      }</span>${s.poster_key ? '<span class="flag">Poster</span>' : ''}</div>
      <div class="row-meta">Received ${escapeHtml(received(s.created_at))}${when}${s.name ? ` · from ${escapeHtml(s.name)}` : ''}</div>
      ${s.handled_at ? `<div class="row-actions">${handledNote(s)}</div>` : ''}
    </li>`
  }
  const list = (rows: SuggestionRow[], empty: string): string =>
    rows.length ? `<ul class="rows">${rows.map(row).join('')}</ul>` : `<p class="muted">${empty}</p>`

  const dismissed = results.find((s) => s.id === url.searchParams.get('dismissed'))
  const flash = dismissed
    ? `<p class="flash">Dismissed “${escapeHtml(suggestionLabel(dismissed))}”. <a href="/suggestions/${dismissed.id}">Open it</a> to undo that.</p>`
    : ''

  return shell(
    'Suggestions',
    `${flash}
    <h2>Waiting</h2>${list(waiting, 'Nothing waiting. Suggestions sent through the site’s form appear here.')}
    ${done.length ? `<h2>Done</h2>${list(done, '')}` : ''}`,
    email,
  )
}

async function suggestionPage(db: D1Like, id: string, email: string): Promise<Response> {
  const s = await loadSuggestion(db, id)
  if (!s) return notFound(email)

  // The web worker only stores http(s) links, but this is a stranger's text on its way
  // into an href, so check again.
  const link = s.url && /^https?:\/\//i.test(s.url)
    ? `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.url)}</a>`
    : s.url && escapeHtml(s.url)
  const rows: Array<[string, string | null]> = [
    ['Type', s.kind === 'website' ? 'A website that lists events' : 'A single event'],
    ['Title', s.title && escapeHtml(s.title)],
    ['Link', link],
    ['Date', s.event_date && escapeHtml(s.event_date)],
    ['Time', s.event_time && escapeHtml(s.event_time)],
    ['Description', s.description && escapeHtml(s.description)],
    ['Comments', s.comments && escapeHtml(s.comments)],
    ['From', escapeHtml([s.name, s.email ? `<${s.email}>` : null].filter(Boolean).join(' ') || 'Anonymous')],
    ['Received', escapeHtml(received(s.created_at))],
    ['Emails', escapeHtml(`to us: ${s.admin_mail ?? 'not recorded'} · thank-you: ${s.user_mail ?? 'not recorded'}`)],
    ['Poster', s.poster_error && escapeHtml(`one was sent but not kept (${s.poster_error})`)],
  ]
  const details = `<dl class="details">${rows
    .filter(([, value]) => value)
    .map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`)
    .join('')}</dl>`

  let actions: string
  if (!s.handled_at) {
    const create =
      s.kind === 'event'
        ? `<a class="button" href="/new?from=${s.id}">Create an event from this</a>`
        : '<span class="muted">A website is a source for the ingest run to read, not an event to add here.</span>'
    actions = `${create}<form method="post" action="/suggestions/${s.id}/dismiss"><button type="submit" class="link">Dismiss</button></form>`
  } else if (s.handled_as === 'dismissed') {
    actions = `${handledNote(s)}<form method="post" action="/suggestions/${s.id}/reopen"><button type="submit" class="link">Undo, and put it back in the waiting list</button></form>`
  } else {
    actions = handledNote(s)
  }

  const poster = s.poster_key
    ? `<p><a href="/suggestions/${s.id}/poster" target="_blank" rel="noopener"><img class="poster" src="/suggestions/${s.id}/poster" alt="The poster sent with this suggestion"></a></p>`
    : ''
  return page(shell(suggestionLabel(s), `<div class="actions">${actions}</div>${details}${poster}<p><a href="/suggestions">All suggestions</a></p>`, email))
}

/** A suggestion's poster, straight from the private bucket, to a signed-in admin only. */
async function posterResponse(env: ConsoleEnv, id: string, email: string): Promise<Response> {
  const s = await loadSuggestion(env.DB, id)
  const type = s?.poster_type && POSTER_TYPES.has(s.poster_type) ? s.poster_type : null
  const object = s?.poster_key && type && env.POSTERS ? await env.POSTERS.get(s.poster_key) : null
  if (!object || !type) return notFound(email)
  return new Response(object.body, {
    headers: {
      'Content-Type': type,
      // Not public until approved, so never into a shared cache.
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'X-Robots-Tag': 'noindex, nofollow',
    },
  })
}

/**
 * Dismiss a waiting suggestion, or undo a dismissal. An approved suggestion cannot be
 * sent back: its event may be showing its poster, which would stop being served.
 */
async function setDismissed(db: D1Like, id: string, dismiss: boolean): Promise<Response> {
  await runBatched(db, [
    dismiss
      ? db
          .prepare("UPDATE suggestions SET handled_at = ?, handled_as = 'dismissed' WHERE id = ? AND handled_at IS NULL")
          .bind(new Date().toISOString(), id)
      : db.prepare("UPDATE suggestions SET handled_at = NULL, handled_as = NULL WHERE id = ? AND handled_as = 'dismissed'").bind(id),
  ])
  return redirect(dismiss ? `/suggestions?dismissed=${id}` : `/suggestions/${id}`)
}

function shell(title: string, body: string, email: string): string {
  return `<!doctype html><html lang="en-CA"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)} — Out in Simcoe console</title>
<style>
  :root { color-scheme: light dark; --bg:#fbf7f1; --card:#fffdf9; --ink:#231a12; --muted:#6f6358; --line:#e7ddd0; --accent:#e05a17; --accent-ink:#fffaf4; --warn:#8a4b12; --warn-bg:#fbf1e6; --bad:#a3261b; --bad-bg:#fbe9e7; --ok:#1f6b2a; --ok-bg:#e3f1e4; }
  @media (prefers-color-scheme: dark) { :root { --bg:#15110d; --card:#1f1914; --ink:#f3ebe1; --muted:#b3a697; --line:#3a3027; --accent:#ff8a4c; --accent-ink:#2c1205; --warn:#e0a86a; --warn-bg:#2c2318; --bad:#ff9d92; --bad-bg:#3a1a16; --ok:#8fd49a; --ok-bg:#1c2e1f; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0 16px 48px; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header, main { max-width: 820px; margin: 0 auto; }
  header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 6px 16px; padding: 20px 0 12px; border-bottom: 1px solid var(--line); }
  header a { color: var(--ink); font-weight: 700; text-decoration: none; }
  header .who { color: var(--muted); font-size: 13px; }
  header nav { display: flex; gap: 16px; }
  header nav a { color: var(--accent); font-weight: 600; }
  h1 { font-size: 26px; margin: 22px 0 12px; }
  h2 { font-size: 17px; margin: 26px 0 8px; }
  a { color: var(--accent); }
  .muted, .hint { color: var(--muted); }
  .button { display: inline-block; border: 0; border-radius: 999px; padding: 9px 18px; background: var(--accent); color: var(--accent-ink); font: inherit; font-weight: 700; text-decoration: none; cursor: pointer; }
  .flash { padding: 10px 14px; border-radius: 10px; background: var(--warn-bg); color: var(--warn); }
  .flash.error { background: var(--bad-bg); color: var(--bad); font-weight: 600; }
  .rows { list-style: none; margin: 0; padding: 0; }
  .rows li { padding: 12px 0; border-bottom: 1px solid var(--line); }
  .rows li.is-off { opacity: .6; }
  .row-main a { color: var(--ink); text-decoration: none; }
  .row-meta { color: var(--muted); font-size: 13.5px; }
  .row-actions { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 4px; font-size: 14px; }
  .row-actions form { display: inline; margin: 0; }
  .row-actions .flag { margin-left: 0; }
  .link { border: 0; padding: 0; background: none; color: var(--accent); font: inherit; text-decoration: underline; cursor: pointer; }
  .flag { margin-left: 8px; padding: 1px 8px; border-radius: 999px; background: var(--line); font-size: 12px; font-weight: 600; }
  .flag.warn { background: var(--warn-bg); color: var(--warn); }
  .flag.off { background: var(--bad-bg); color: var(--bad); }
  .flag.ok { background: var(--ok-bg); color: var(--ok); }
  .notice { padding: 10px 14px; border: 1.5px solid var(--accent); border-radius: 10px; }
  .from-suggestion { margin: 8px 0 18px; padding: 12px 14px; border: 1.5px dashed var(--line); border-radius: 10px; background: var(--card); }
  .from-suggestion p { margin: 0 0 6px; }
  .pre { white-space: pre-wrap; }
  .thumb { max-width: 160px; max-height: 160px; border: 1px solid var(--line); border-radius: 8px; }
  .poster { max-width: 100%; max-height: 520px; border: 1px solid var(--line); border-radius: 10px; }
  .details { display: grid; grid-template-columns: 8.5em 1fr; gap: 8px 16px; margin: 16px 0; }
  .details dt { color: var(--muted); font-weight: 700; }
  .details dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .event-form { margin-top: 8px; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px; }
  .field { display: flex; flex-direction: column; gap: 4px; margin: 0 0 14px; min-width: 0; }
  .field label { font-weight: 700; font-size: 14px; }
  .hint { font-size: 12.5px; }
  input, select, textarea { width: 100%; font: inherit; color: var(--ink); background: var(--card); border: 1.5px solid var(--line); border-radius: 9px; padding: 8px 10px; }
  textarea { resize: vertical; }
  .has-error input, .has-error select, .has-error textarea { border-color: var(--bad); }
  .error { color: var(--bad); font-size: 13px; font-weight: 600; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; margin: 12px 0; }
  .actions form { margin: 0; }
  @media (max-width: 600px) { .pair, .details { grid-template-columns: 1fr; } }
</style>
</head><body>
<header><a href="/">Out in Simcoe · console</a>${
  email ? `<nav><a href="/">Events</a><a href="/suggestions">Suggestions</a></nav><span class="who">Signed in as ${escapeHtml(email)}</span>` : ''
}</header>
<main><h1>${escapeHtml(title)}</h1>${body}</main>
</body></html>`
}
