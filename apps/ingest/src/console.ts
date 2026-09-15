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
 * The admin console at console.outinsimcoe.ca: add, edit and remove events by hand.
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

  try {
    if (path === '/' && request.method === 'GET') return page(await listPage(env.DB, url, publicOrigin, auth.email))
    if (path === '/new' && request.method === 'GET') return page(formPage({ email: auth.email }))
    if (path === '/events' && request.method === 'POST') return await createEvent(env.DB, request, auth.email)

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
  const parsed = parseEventForm(await readForm(request))
  if (!parsed.ok) return page(formPage({ email, values: parsed.values, errors: parsed.errors }), 400)

  const listing = buildManualListing(parsed.input, crypto.randomUUID())
  await writeListing(db, listing, { eventId: null, eventCreatedAt: null, active: true })
  return redirect(`/?saved=${encodeURIComponent(listing.externalId)}`)
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
    return `<p class="flash">Saved “${escapeHtml(saved.title)}”.${merged}${link}</p>`
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

function formPage(options: { email: string; uuid?: string; values?: Record<string, string>; errors?: Record<string, string> }): string {
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
  const heading = options.uuid ? 'Edit event' : 'Add an event'

  return shell(
    heading,
    `${Object.keys(errors).length ? '<p class="flash error">Some fields need another look — see below.</p>' : ''}
    <form method="post" action="${action}" class="event-form">
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
      ${field('image_url', 'Poster image', input('image_url', 'url', 'maxlength="2000" placeholder="https://"'), 'Optional, https only.')}
      <p class="actions"><button type="submit" class="button">${options.uuid ? 'Save changes' : 'Add event'}</button> <a href="/">Cancel</a></p>
    </form>`,
    options.email,
  )
}

function shell(title: string, body: string, email: string): string {
  return `<!doctype html><html lang="en-CA"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)} — Out in Simcoe console</title>
<style>
  :root { color-scheme: light dark; --bg:#fbf7f1; --card:#fffdf9; --ink:#231a12; --muted:#6f6358; --line:#e7ddd0; --accent:#e05a17; --accent-ink:#fffaf4; --warn:#8a4b12; --warn-bg:#fbf1e6; --bad:#a3261b; --bad-bg:#fbe9e7; }
  @media (prefers-color-scheme: dark) { :root { --bg:#15110d; --card:#1f1914; --ink:#f3ebe1; --muted:#b3a697; --line:#3a3027; --accent:#ff8a4c; --accent-ink:#2c1205; --warn:#e0a86a; --warn-bg:#2c2318; --bad:#ff9d92; --bad-bg:#3a1a16; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0 16px 48px; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header, main { max-width: 820px; margin: 0 auto; }
  header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 6px 16px; padding: 20px 0 12px; border-bottom: 1px solid var(--line); }
  header a { color: var(--ink); font-weight: 700; text-decoration: none; }
  header .who { color: var(--muted); font-size: 13px; }
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
  .link { border: 0; padding: 0; background: none; color: var(--accent); font: inherit; text-decoration: underline; cursor: pointer; }
  .flag { margin-left: 8px; padding: 1px 8px; border-radius: 999px; background: var(--line); font-size: 12px; font-weight: 600; }
  .flag.warn { background: var(--warn-bg); color: var(--warn); }
  .flag.off { background: var(--bad-bg); color: var(--bad); }
  .event-form { margin-top: 8px; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px; }
  .field { display: flex; flex-direction: column; gap: 4px; margin: 0 0 14px; min-width: 0; }
  .field label { font-weight: 700; font-size: 14px; }
  .hint { font-size: 12.5px; }
  input, select, textarea { width: 100%; font: inherit; color: var(--ink); background: var(--card); border: 1.5px solid var(--line); border-radius: 9px; padding: 8px 10px; }
  textarea { resize: vertical; }
  .has-error input, .has-error select, .has-error textarea { border-color: var(--bad); }
  .error { color: var(--bad); font-size: 13px; font-weight: 600; }
  .actions { display: flex; align-items: center; gap: 16px; }
  @media (max-width: 600px) { .pair { grid-template-columns: 1fr; } }
</style>
</head><body>
<header><a href="/">Out in Simcoe · console</a>${email ? `<span class="who">Signed in as ${escapeHtml(email)}</span>` : ''}</header>
<main><h1>${escapeHtml(title)}</h1>${body}</main>
</body></html>`
}
