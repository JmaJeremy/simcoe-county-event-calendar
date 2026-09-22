import {
  MANUAL_SOURCE_SLUG,
  MUNICIPALITIES,
  municipalityBySlug,
  applyOverrides,
  buildClusters,
  eventFromCluster,
  parseOverrides,
  shortCode,
  sourceBySlug,
  type EventOverrides,
  type Listing,
} from '@scec/core'
import type { JWTVerifyGetKey } from 'jose'
import { isSameOriginWrite, verifyAccess } from './access.ts'
import { ADMIN_ADDRESS, MAIL_FROM, acceptedMail } from './suggestion-mail.ts'
import {
  AUTO_CATEGORY,
  CATEGORY_OPTIONS,
  COST_OPTIONS,
  ORIGINAL_PREFIX,
  OVERRIDE_GROUPS,
  STATUS_OPTIONS,
  buildManualListing,
  editedGroups,
  overridesFromForm,
  parseEventForm,
  withoutGroups,
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
 * The admin console at console.outinsimcoe.ca: add, edit and remove events by hand, edit
 * any event the ingest run found, and review what visitors suggest through the site's form.
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
  /** Cloudflare Email Service, for telling a suggester their suggestion was accepted. */
  EMAIL?: {
    send(message: { to: string; from: { email: string; name: string }; replyTo: string; subject: string; text: string }): Promise<unknown>
  }
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
  const suggestionRoute = path.match(/^\/suggestions\/([^/]+)(?:\/(poster|accept|dismiss|reopen))?$/)
  const stagedRoute = path.match(/^\/staged\/([^/]+)(?:\/(dismiss|reopen))?$/)

  try {
    if (path === '/' && request.method === 'GET') return page(await listPage(env.DB, url, publicOrigin, auth.email))
    if (path === '/new' && request.method === 'GET') return await newPage(env.DB, url, publicOrigin, auth.email)
    if (path === '/events' && request.method === 'POST') return await createEvent(env, request, publicOrigin, auth.email)
    if (path === '/suggestions' && request.method === 'GET') return page(await suggestionsPage(env.DB, url, publicOrigin, auth.email))
    if (path === '/staged' && request.method === 'GET') return page(await stagedPage(env.DB, url, publicOrigin, auth.email))
    if (path === '/find' && request.method === 'GET') return page(await findPage(env.DB, url, publicOrigin, auth.email))
    if (path === '/social' && request.method === 'GET') return page(await socialPage(env.DB, url, publicOrigin, auth.email))

    // A day's drafts approved in one go. The date is checked before it reaches any SQL.
    const socialDay = path.match(/^\/social\/day\/(\d{4}-\d{2}-\d{2})\/approve$/)
    if (socialDay && request.method === 'POST') return await approveSocialDay(env.DB, socialDay[1]!, auth.email)

    // Addressed by the row's uuid, never the event id: listing ids carry colons and slashes.
    const socialRoute = path.match(/^\/social\/([^/]+)(?:\/(approve|unapprove|skip|unskip))?$/)
    if (socialRoute) {
      const [, id, action] = socialRoute
      if (!UUID.test(id!)) return notFound(auth.email)
      if (!action && request.method === 'GET') return await socialEditPage(env.DB, id!, publicOrigin, auth.email)
      if (!action && request.method === 'POST') return await saveSocialEdit(env.DB, request, id!, publicOrigin, auth.email)
      if (action && request.method === 'POST') return await socialAction(env.DB, id!, action as SocialAction, auth.email)
    }

    // Short codes are seven hex characters; listing ids can contain slashes.
    const eventRoute = path.match(/^\/event\/([0-9a-f]{7})(?:\/(clear|hide|show))?$/)
    if (eventRoute) {
      const [, code, action] = eventRoute
      if (!action && request.method === 'GET') return await eventEditPage(env.DB, url, code!, publicOrigin, auth.email)
      if (!action && request.method === 'POST') return await saveEventEdit(env.DB, request, code!, publicOrigin, auth.email)
      if (action && request.method === 'POST') return await eventAction(env.DB, request, code!, action as 'clear' | 'hide' | 'show', auth.email)
    }

    if (suggestionRoute) {
      const [, id, action] = suggestionRoute
      if (!UUID.test(id!)) return notFound(auth.email)
      if (!action && request.method === 'GET') return await suggestionPage(env.DB, url, id!, publicOrigin, auth.email)
      if (action === 'accept' && request.method === 'POST') return await acceptSuggestion(env, id!, auth.email)
      if (action === 'poster' && request.method === 'GET') return await posterResponse(env, id!, auth.email)
      if ((action === 'dismiss' || action === 'reopen') && request.method === 'POST') {
        return await setDismissed(env.DB, id!, action === 'dismiss')
      }
    }

    if (stagedRoute) {
      const [, id, action] = stagedRoute
      if (!UUID.test(id!)) return notFound(auth.email)
      if (!action && request.method === 'GET') return await stagedDetailPage(env.DB, id!, publicOrigin, auth.email)
      if ((action === 'dismiss' || action === 'reopen') && request.method === 'POST') {
        return await setStagedDismissed(env.DB, id!, action === 'dismiss')
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

async function createEvent(env: ConsoleEnv, request: Request, publicOrigin: string, email: string): Promise<Response> {
  const db = env.DB
  const form = await readForm(request)
  // Opened from a suggestion, or from a news draft: saving approves whichever it was.
  const suggestion = typeof form.from === 'string' && UUID.test(form.from) ? await loadSuggestion(db, form.from) : null
  const staged = typeof form.staged === 'string' && UUID.test(form.staged) ? await loadStaged(db, form.staged) : null
  const parsed = parseEventForm(form)
  if (!parsed.ok) return page(formPage({ email, values: parsed.values, errors: parsed.errors, suggestion, staged }), 400)

  const listing = buildManualListing(parsed.input, crypto.randomUUID())
  // Marking the suggestion done is also what makes its poster public: the site's /posters/
  // route serves only the posters of suggestions approved as events. It rides in the same
  // batch as the event, so the two land together or not at all — an event whose poster
  // 404s, with the suggestion still waiting to be approved into a duplicate, cannot happen.
  const approve = suggestion
    ? [
        db
          .prepare("UPDATE suggestions SET handled_at = ?, handled_as = 'event', handled_listing_id = ? WHERE id = ?")
          .bind(new Date().toISOString(), listing.id, suggestion.id),
      ]
    : []
  // A news draft is marked done in the same batch, for the same reason: the draft and the
  // event it became land together or not at all, so the queue can never show something to
  // review that is already on the site.
  if (staged) {
    approve.push(
      db
        .prepare("UPDATE staged_events SET handled_at = ?, handled_as = 'event', handled_listing_id = ? WHERE id = ?")
        .bind(new Date().toISOString(), listing.id, staged.id),
    )
  }
  await writeListing(db, listing, { eventId: null, eventCreatedAt: null, active: true }, approve)
  if (staged) return redirect(`/?saved=${encodeURIComponent(listing.externalId)}&staged=1`)
  if (!suggestion) return redirect(`/?saved=${encodeURIComponent(listing.externalId)}`)
  // After the write, so the link in the email already works. A new solo event takes its
  // listing's id, and with it the short code.
  const mail = await notifyAccepted(env, suggestion, { title: listing.title, url: `${publicOrigin}/e/${shortCode(listing.id)}` })
  return redirect(`/?saved=${encodeURIComponent(listing.externalId)}&suggestion=1&mail=${mail}`)
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
  /** Further writes that must land with this one, in the same batch. */
  alongside: ReturnType<D1Like['prepare']>[] = [],
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
    // An edit made through /event/ applies here too, so the two editors never disagree.
    const override = cluster.eventId
      ? parseOverrides((await db.prepare('SELECT fields FROM event_overrides WHERE event_id = ?').bind(cluster.eventId).first<{ fields: string }>())?.fields)
      : {}
    statements.push(...upsertEventStatements(db, events.map((e) => applyOverrides(e, override)), now), ...assignClusterStatements(db, assignments))
  }
  statements.push(...alongside)
  // A D1 batch is one transaction. runBatched only splits past 80 statements, and a single
  // listing with its event is a handful.
  if (statements.length > 80) throw new Error('A console write outgrew one batch, so it would no longer be atomic')
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

function when(row: Pick<ListingRow, 'local_date' | 'local_time' | 'all_day' | 'time_precision'>): string {
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
  // Only drafts whose date has not passed: one nobody got to in time is not work waiting.
  const staged =
    (
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM staged_events WHERE handled_at IS NULL AND local_date >= date('now', 'localtime')",
        )
        .first<{ n: number }>()
    )?.n ?? 0
  // Only posts that can still go out: a draft whose day has passed is expired within the hour.
  const posts =
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM social_posts WHERE status = 'drafted' AND post_date >= ?")
        .bind(today)
        .first<{ n: number }>()
    )?.n ?? 0
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
    ${staged ? `<p class="notice">${staged} event${staged === 1 ? '' : 's'} found in the news waiting. <a href="/staged">Review ${staged === 1 ? 'it' : 'them'}</a></p>` : ''}
    ${posts ? `<p class="notice">${posts} social post${posts === 1 ? '' : 's'} waiting for approval. <a href="/social">Review ${posts === 1 ? 'it' : 'them'}</a></p>` : ''}
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
    const approved = url.searchParams.get('suggestion') === '1' ? ` The suggestion it came from is marked done. ${mailNote(url.searchParams.get('mail'), true)}` : ''
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
/** The columns the event form is filled from, which listings and events share. */
type FormRow = Pick<
  ListingRow,
  | 'title' | 'municipality_slug' | 'category' | 'local_date' | 'local_time' | 'all_day' | 'time_precision' | 'ends_at_utc'
  | 'timezone' | 'venue_name' | 'address' | 'cost' | 'cost_text' | 'description' | 'organizer' | 'url' | 'image_url' | 'status'
>

function valuesFromRow(row: FormRow): Record<string, string> {
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
  /** The news-scraper draft this new event is being made from. */
  staged?: StagedRow | null
  /** For editing a found event: where it posts, what it says, and which groups are edited. */
  action?: string
  heading?: string
  submitLabel?: string
  cancelHref?: string
  intro?: string
  hidden?: Record<string, string>
  edited?: readonly string[]
}): string {
  const values = options.values ?? {}
  const errors = options.errors ?? {}
  const v = (key: string) => escapeHtml(values[key] ?? '')
  const error = (key: string) => (errors[key] ? `<span class="error">${escapeHtml(errors[key]!)}</span>` : '')
  const select = (name: string, options: ReadonlyArray<readonly [string, string]>, fallback: string) => {
    const current = values[name] ?? fallback
    // A stored value the list lacks is offered as it is, or the form would post a different one.
    const known = current === '' || options.some(([key]) => key === current)
    return `<select id="f-${name}" name="${name}">${known ? '' : `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}</option>`}${options
      .map(([key, label]) => `<option value="${escapeHtml(key)}"${key === current ? ' selected' : ''}>${escapeHtml(label)}</option>`)
      .join('')}</select>`
  }
  const editedMark = (name: string): string => {
    const group = OVERRIDE_GROUPS.find((g) => g.form.includes(name))?.key
    return group && options.edited?.includes(group) ? ' <span class="flag edited">edited</span>' : ''
  }
  const field = (name: string, label: string, control: string, hint = '') =>
    `<div class="field${errors[name] ? ' has-error' : ''}"><label for="f-${name}">${label}${editedMark(name)}</label>${control}${hint ? `<span class="hint">${hint}</span>` : ''}${error(name)}</div>`
  const input = (name: string, type = 'text', extra = '') => `<input id="f-${name}" name="${name}" type="${type}" value="${v(name)}" ${extra}>`

  const places: Array<[string, string]> = [['', 'Not specified'], ...MUNICIPALITIES.map((m): [string, string] => [m.slug, m.name])]
  const categories: ReadonlyArray<readonly [string, string]> = [[AUTO_CATEGORY, 'Work it out from the title'], ...CATEGORY_OPTIONS]
  const action = options.action ?? (options.uuid ? `/events/${options.uuid}` : '/events')
  const s = options.uuid ? null : options.suggestion ?? null
  const draft = options.uuid ? null : options.staged ?? null
  const heading =
    options.heading ??
    (options.uuid ? 'Edit event' : s ? 'Add an event from a suggestion' : draft ? 'Add an event from the news' : 'Add an event')
  const fromPanel = s
    ? `<div class="from-suggestion">
        <p><strong>From a suggestion</strong>${s.name ? ` by ${escapeHtml(s.name)}` : ''}, received ${escapeHtml(received(s.created_at))}
          · <a href="/suggestions/${s.id}">See the suggestion</a></p>
        <p>Check the details, since they are what a visitor typed. Saving adds the event, marks the suggestion done${
          s.email ? ' and emails them a link to it' : ''
        }.</p>
        ${s.comments ? `<p class="muted pre">Their comments, which are not copied into the event: ${escapeHtml(s.comments)}</p>` : ''}
        ${s.poster_key ? `<p><img class="thumb" src="/suggestions/${s.id}/poster" alt="The poster sent with the suggestion"></p>` : ''}
      </div>`
    : ''

  /**
   * What the scraper read, beside the article it read it from. The quotes are the point:
   * each was checked to appear verbatim in the article, so the form can be checked against
   * the story rather than believed. The title is the exception and says so — a news article
   * names an event in prose, never as a title, so that field is always someone's wording.
   */
  const stagedPanel = draft
    ? `<div class="from-suggestion">
        <p><strong>Found in the news</strong> by the scraper, in ${escapeHtml(draft.source_slug)}
          · <a href="${escapeHtml(draft.article_url)}" target="_blank" rel="noopener noreferrer">Read the article ↗</a>
          · <a href="/staged/${draft.id}">See the draft</a></p>
        <p>Saving adds the event and marks the draft done. Nothing from the article's own
          writing is copied into it${draft.title_generated ? ', and the title below appears nowhere in the article — read it against the story first' : ''}.</p>
        ${Object.entries(evidenceOf(draft))
          .map(([field, quote]) => `<p class="muted pre">${escapeHtml(field)}: “${escapeHtml(quote)}”</p>`)
          .join('')}
      </div>`
    : ''

  return shell(
    heading,
    `${Object.keys(errors).length ? '<p class="flash error">Some fields need another look — see below.</p>' : ''}
    ${fromPanel}${stagedPanel}
    ${options.intro ?? ''}
    <form method="post" action="${action}" class="event-form">
      ${Object.entries(options.hidden ?? {}).map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`).join('')}
      ${s ? `<input type="hidden" name="from" value="${s.id}">` : ''}
      ${draft ? `<input type="hidden" name="staged" value="${draft.id}">` : ''}
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
      ${field('description', 'Description', `<textarea id="f-description" name="description" rows="7" maxlength="4000">${v('description')}</textarea>`, 'Markdown works: **bold**, *italic*, [a link](https://…), and lines starting with “- ” for a list. A blank line starts a new paragraph.')}
      <div class="pair">
        ${field('organizer', 'Organizer', input('organizer', 'text', 'maxlength="200"'))}
        ${field('status', 'Status', select('status', STATUS_OPTIONS, 'scheduled'))}
      </div>
      ${field('url', 'Link to more information', input('url', 'url', 'maxlength="2000" placeholder="https://"'), 'Optional. Without one, the event page has no “View the listing” button.')}
      ${field('image_url', 'Poster image', input('image_url', 'url', 'maxlength="2000" placeholder="https://"'), s?.poster_key && values.image_url?.includes(s.poster_key)
        ? 'The suggested poster, filled in for you. It becomes public when you add this event; clear it to leave the poster out.'
        : 'Optional, https only.')}
      <p class="actions"><button type="submit" class="button">${options.submitLabel ?? (options.uuid ? 'Save changes' : 'Add event')}</button> <a href="${options.cancelHref ?? '/'}">Cancel</a></p>
    </form>`,
    options.email,
  )
}

/* ---------------------------------------------------------------------- any event */

/*
 * Every event on the site, found and edited by hand. The ingest run rebuilds events from
 * their listings every two hours, so an edit is kept in event_overrides and laid over what
 * the sources say: by dedup on every run, and here on save, which rebuilds the one event
 * from its listings exactly as dedup would. Only edited fields are kept, so the rest of the
 * event goes on following its sources.
 */

interface EventRow extends FormRow {
  id: string
  short_code: string
  representative_id: string
  listing_ids: string
  source_slugs: string
  listing_count: number
  active: number
  starts_at_utc: string
  override_fields: string | null
  override_updated_at: string | null
  override_updated_by: string | null
}

const EVENT_SELECT = `SELECT e.*, o.fields AS override_fields, o.updated_at AS override_updated_at, o.updated_by AS override_updated_by
  FROM events e LEFT JOIN event_overrides o ON o.event_id = e.id`
const FIND_LIMIT = 60
const UNPLACED = 'unspecified'

const loadEventByCode = (db: D1Like, code: string): Promise<EventRow | null> =>
  db.prepare(`${EVENT_SELECT} WHERE e.short_code = ?`).bind(code).first<EventRow>()

/** A solo event added by hand is edited as its listing, never through an override. */
function soloManualUuid(row: Pick<EventRow, 'representative_id' | 'listing_ids'>): string | null {
  if (!row.representative_id?.startsWith(MANUAL_ID_PREFIX)) return null
  const ids = JSON.parse(row.listing_ids || '[]') as string[]
  return ids.length === 1 ? row.representative_id.slice(MANUAL_ID_PREFIX.length) : null
}

async function loadClusterListings(db: D1Like, row: Pick<EventRow, 'listing_ids'>): Promise<ListingRow[]> {
  const ids = JSON.parse(row.listing_ids || '[]') as string[]
  const rows: ListingRow[] = []
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    const { results } = await db
      .prepare(`SELECT * FROM listings WHERE id IN (${chunk.map(() => '?').join(', ')})`)
      .bind(...chunk)
      .all<ListingRow>()
    rows.push(...results)
  }
  return rows
}

async function findPage(db: D1Like, url: URL, publicOrigin: string, email: string): Promise<string> {
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200)
  const placeParam = url.searchParams.get('m') ?? ''
  const place = placeParam === UNPLACED || MUNICIPALITIES.some((m) => m.slug === placeParam) ? placeParam : ''
  const past = url.searchParams.get('past') === '1'
  // A short code, on its own or inside a pasted link, finds that one event wherever it is in time.
  const code = (q.match(/\/e\/([0-9a-f]{7})\b/i) ?? q.match(/^([0-9a-f]{7})$/i))?.[1]?.toLowerCase() ?? null

  const where: string[] = []
  const binds: unknown[] = []
  if (code) {
    where.push('e.short_code = ?')
    binds.push(code)
  } else {
    if (q) {
      where.push(`e.title LIKE ? ESCAPE '\\'`)
      binds.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    }
    if (place === UNPLACED) where.push('e.municipality_slug IS NULL')
    else if (place) {
      where.push('e.municipality_slug = ?')
      binds.push(place)
    }
    where.push(past ? 'e.local_date < ?' : 'e.local_date >= ?')
    binds.push(todayLocal())
  }
  const { results } = await db
    .prepare(`${EVENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY e.starts_at_utc ${past && !code ? 'DESC' : 'ASC'} LIMIT ${FIND_LIMIT + 1}`)
    .bind(...binds)
    .all<EventRow>()

  const row = (r: EventRow): string => {
    const overrides = parseOverrides(r.override_fields)
    const manual = soloManualUuid(r)
    const edit = manual ? `/events/${manual}` : `/event/${r.short_code}`
    const placeName = MUNICIPALITIES.find((m) => m.slug === r.municipality_slug)?.shortName ?? 'Not specified'
    const sources = (JSON.parse(r.source_slugs || '[]') as string[]).map((slug) => sourceBySlug(slug)?.name ?? slug)
    const flags = [
      editedGroups(overrides).length ? '<span class="flag edited">Edited</span>' : '',
      overrides.active === false ? '<span class="flag off">Hidden</span>' : r.active === 1 ? '' : '<span class="flag off">No longer listed</span>',
      r.status === 'cancelled' ? '<span class="flag warn">Cancelled</span>' : '',
      r.representative_id?.startsWith(MANUAL_ID_PREFIX) ? '<span class="flag">Added by hand</span>' : '',
    ].join('')
    return `<li class="${r.active === 1 ? '' : 'is-off'}">
      <div class="row-main"><a href="${edit}"><strong>${escapeHtml(r.title)}</strong></a>${flags}</div>
      <div class="row-meta">${escapeHtml(when(r))} · ${escapeHtml(placeName)}${r.venue_name ? ` · ${escapeHtml(r.venue_name)}` : ''} · ${escapeHtml(sources.join(', '))}</div>
      <div class="row-actions"><a href="${edit}">Edit</a><a href="${escapeHtml(`${publicOrigin}/e/${r.short_code}`)}" target="_blank" rel="noopener">View on site</a></div>
    </li>`
  }

  const places: Array<[string, string]> = [['', 'Anywhere'], [UNPLACED, 'Not specified'], ...MUNICIPALITIES.map((m): [string, string] => [m.slug, m.name])]
  const shown = results.slice(0, FIND_LIMIT)
  const summary = code
    ? shown.length ? '' : `<p class="muted">No event has the short code ${escapeHtml(code)}.</p>`
    : results.length > FIND_LIMIT
      ? `<p class="muted">Showing the first ${FIND_LIMIT}. Narrow the search to see the rest.</p>`
      : `<p class="muted">${shown.length} ${past ? 'past ' : 'upcoming '}event${shown.length === 1 ? '' : 's'}${q ? ` matching “${escapeHtml(q)}”` : ''}.</p>`

  return shell(
    'All events',
    `<form method="get" action="/find" class="search">
      <div class="field grow"><label for="f-q">Title, short code or event link</label><input id="f-q" name="q" type="search" value="${escapeHtml(q)}"></div>
      <div class="field"><label for="f-m">Municipality</label><select id="f-m" name="m">${places
        .map(([key, label]) => `<option value="${escapeHtml(key)}"${key === place ? ' selected' : ''}>${escapeHtml(label)}</option>`)
        .join('')}</select></div>
      <label class="check"><input type="checkbox" name="past" value="1"${past ? ' checked' : ''}> Past events</label>
      <button type="submit" class="button">Search</button>
    </form>
    ${summary}
    ${shown.length ? `<ul class="rows">${shown.map(row).join('')}</ul>` : ''}`,
    email,
  )
}

function eventFlash(url: URL): string {
  const labels = new Map(OVERRIDE_GROUPS.map((g) => [g.key, g.label]))
  const saved = (url.searchParams.get('saved') ?? '').split(',').map((key) => labels.get(key)).filter((label): label is string => !!label)
  if (saved.length) {
    return `<p class="flash">Saved. ${escapeHtml(saved.join(', '))} now stay${saved.length === 1 ? 's' : ''} as you set ${saved.length === 1 ? 'it' : 'them'} through every ingest run; the rest follows the sources.</p>`
  }
  if (url.searchParams.has('unchanged')) return '<p class="flash">Nothing was changed, so nothing was saved.</p>'
  if (url.searchParams.has('cleared')) return '<p class="flash">Undone. That part of the event follows its sources again.</p>'
  if (url.searchParams.has('hidden')) {
    return '<p class="flash">Hidden. It is off the site’s listings, calendar feeds and sitemap until you show it again, whatever its sources say. Its own page still opens for anyone with the link.</p>'
  }
  if (url.searchParams.has('shown')) return '<p class="flash">Shown again, for as long as a source still lists it.</p>'
  return ''
}

async function eventEditPage(db: D1Like, url: URL, code: string, publicOrigin: string, email: string): Promise<Response> {
  const row = await loadEventByCode(db, code)
  if (!row) return notFound(email)
  const manual = soloManualUuid(row)
  if (manual) return redirect(`/events/${manual}`)
  return page(eventFormPage({ email, row, listings: await loadClusterListings(db, row), publicOrigin, flash: eventFlash(url) }))
}

function eventFormPage(o: {
  email: string
  row: EventRow
  listings: ListingRow[]
  publicOrigin: string
  flash?: string
  values?: Record<string, string>
  errors?: Record<string, string>
  /** The orig_ fields as posted, when the form comes back with problems. */
  originals?: Record<string, string>
}): string {
  const overrides = parseOverrides(o.row.override_fields)
  const edited = editedGroups(overrides)
  const hidden = overrides.active === false
  const code = o.row.short_code
  const original = valuesFromRow(o.row)
  const labels = new Map(OVERRIDE_GROUPS.map((g) => [g.key, g.label]))

  const listed = o.listings
    .map((l) => {
      const link = /^https?:\/\//i.test(l.url) ? ` <a href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">Open</a>` : ''
      return `<li><strong>${escapeHtml(sourceBySlug(l.source_slug)?.name ?? l.source_slug)}</strong>: ${escapeHtml(l.title)} · ${escapeHtml(when(l))}${
        l.active === 1 ? '' : ' <span class="flag off">No longer listed</span>'
      }${link}</li>`
    })
    .join('')
  const undo = (group: string, label: string) =>
    `<form method="post" action="/event/${code}/clear" class="inline"><input type="hidden" name="group" value="${group}"><button type="submit" class="link">${label}</button></form>`
  const editedBox = edited.length
    ? // Divs, not paragraphs: a form inside a <p> makes the browser close the paragraph early.
      `<div class="notice"><div>Edited by hand: ${edited.map((key) => `${escapeHtml(labels.get(key)!)} (${undo(key, 'undo')})`).join(', ')}. Everything else follows the sources.</div>${
        o.row.override_updated_by && o.row.override_updated_at
          ? `<div class="muted">Last edited by ${escapeHtml(o.row.override_updated_by)} · ${escapeHtml(received(o.row.override_updated_at))}</div>`
          : ''
      }<div>${undo('all', 'Undo every edit')}</div></div>`
    : '<p class="muted">Nothing edited yet: this is what the sources say. A field you change and save stays as you set it through every ingest run; the rest keeps following the sources.</p>'
  const visibility = `<form method="post" action="/event/${code}/${hidden ? 'show' : 'hide'}" class="inline"><button type="submit" class="link">${
    hidden ? 'Show it on the site again' : 'Hide it from the site'
  }</button></form>`
  const status = hidden
    ? '<span class="flag off">Hidden from the site</span>'
    : o.row.active === 1
      ? ''
      : '<span class="flag off">No longer listed by any source</span>'

  return formPage({
    email: o.email,
    action: `/event/${code}`,
    heading: `Edit “${o.row.title}”`,
    submitLabel: 'Save edits',
    cancelHref: '/find',
    intro: `${o.flash ?? ''}
      <div class="actions"><a href="${escapeHtml(`${o.publicOrigin}/e/${code}`)}" target="_blank" rel="noopener">View on site</a>${status}${visibility}</div>
      ${editedBox}
      <h2>Listed by</h2><ul class="listed">${listed || '<li class="muted">No listings found.</li>'}</ul>
      <h2>Details</h2>`,
    hidden: o.originals ?? Object.fromEntries(Object.entries(original).map(([key, value]) => [`${ORIGINAL_PREFIX}${key}`, value])),
    edited,
    values: o.values ?? original,
    errors: o.errors,
  })
}

async function saveEventEdit(db: D1Like, request: Request, code: string, publicOrigin: string, email: string): Promise<Response> {
  const row = await loadEventByCode(db, code)
  if (!row) return notFound(email)
  const manual = soloManualUuid(row)
  if (manual) return redirect(`/events/${manual}`)

  const result = overridesFromForm(await readForm(request), parseOverrides(row.override_fields))
  if (!result.ok) {
    const pick = (original: boolean) =>
      Object.fromEntries(Object.entries(result.values).filter(([key]) => key.startsWith(ORIGINAL_PREFIX) === original))
    return page(
      eventFormPage({ email, row, listings: await loadClusterListings(db, row), publicOrigin, values: pick(false), errors: result.errors, originals: pick(true) }),
      400,
    )
  }
  if (!result.changed.length) return redirect(`/event/${code}?unchanged=1`)
  await storeOverrides(db, row, result.overrides, email)
  return redirect(`/event/${code}?saved=${result.changed.join(',')}`)
}

async function eventAction(db: D1Like, request: Request, code: string, action: 'clear' | 'hide' | 'show', email: string): Promise<Response> {
  const row = await loadEventByCode(db, code)
  if (!row) return notFound(email)
  const manual = soloManualUuid(row)
  if (manual) return redirect(`/events/${manual}`)

  const current = parseOverrides(row.override_fields)
  let next: EventOverrides
  if (action === 'clear') {
    const group = String((await readForm(request)).group ?? '')
    if (group !== 'all' && !OVERRIDE_GROUPS.some((g) => g.key === group)) return redirect(`/event/${code}`)
    next = withoutGroups(current, group === 'all' ? 'all' : [group])
  } else if (action === 'hide') {
    next = { ...current, active: false }
  } else {
    const { active: _hidden, ...rest } = current
    next = rest
  }
  await storeOverrides(db, row, next, email)
  return redirect(`/event/${code}?${action === 'clear' ? 'cleared' : action === 'hide' ? 'hidden' : 'shown'}=1`)
}

/**
 * Keep an override and rebuild the event with it at once: from its listings, by dedup's own
 * eventFromCluster, so the page shows now exactly what the next run will write. One batch,
 * so the override and the event never disagree. An empty override is deleted.
 */
async function storeOverrides(db: D1Like, row: EventRow, overrides: EventOverrides, email: string): Promise<void> {
  const members = (await loadClusterListings(db, row)).map((r) => rowToListing(r, sourceBySlug(r.source_slug)?.kind ?? 'municipal'))
  if (!members.length) throw new Error('this event has no listings behind it, so it cannot be rebuilt with the edit')
  const now = new Date().toISOString()
  const event = applyOverrides(eventFromCluster(row.id, members, (slug) => sourceBySlug(slug)?.priority ?? 50), overrides)
  await runBatched(db, [
    Object.keys(overrides).length
      ? db
          .prepare(
            `INSERT INTO event_overrides (event_id, fields, updated_at, updated_by) VALUES (?, ?, ?, ?)
             ON CONFLICT(event_id) DO UPDATE SET fields = excluded.fields, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
          )
          .bind(row.id, JSON.stringify(overrides), now, email)
      : db.prepare('DELETE FROM event_overrides WHERE event_id = ?').bind(row.id),
    ...upsertEventStatements(db, [event], now),
  ])
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
  handled_as: 'event' | 'accepted' | 'dismissed' | null
  handled_listing_id: string | null
  /** What happened to the acceptance email: 'sent', 'error: …'. Null until one was tried. */
  accepted_mail?: string | null
  /** The public short code of the event it became, when it was approved. */
  event_code?: string | null
}

/** The types the web worker can have decided from a file's bytes. Nothing else is served. */
const POSTER_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

/** The event an approved suggestion became: its listing, then that listing's cluster. */
const SUGGESTION_EVENT_JOIN = `LEFT JOIN listings l ON l.id = s.handled_listing_id LEFT JOIN events e ON e.id = l.cluster_id`

const loadSuggestion = (db: D1Like, id: string): Promise<SuggestionRow | null> =>
  db
    .prepare(`SELECT s.*, e.short_code AS event_code FROM suggestions s ${SUGGESTION_EVENT_JOIN} WHERE s.id = ?`)
    .bind(id)
    .first<SuggestionRow>()

const received = (iso: string): string =>
  new Date(iso).toLocaleString('en-CA', { timeZone: 'America/Toronto', dateStyle: 'medium', timeStyle: 'short' })

const suggestionLabel = (s: Pick<SuggestionRow, 'title' | 'url'>): string => s.title ?? s.url ?? 'No title given'

async function newPage(db: D1Like, url: URL, publicOrigin: string, email: string): Promise<Response> {
  // Two things can pre-fill this form: a suggestion someone sent through the site, and a
  // draft the news scraper staged. They fill in different fields and carry different
  // warnings, so each gets its own parameter rather than one overloaded one.
  const staged = url.searchParams.get('staged')
  if (staged) {
    const draft = UUID.test(staged) ? await loadStaged(db, staged) : null
    if (!draft) return notFound(email)
    return page(formPage({ email, staged: draft, values: valuesFromStaged(draft) }))
  }
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

function handledNote(s: Pick<SuggestionRow, 'handled_at' | 'handled_as' | 'handled_listing_id' | 'event_code'>, publicOrigin: string): string {
  if (!s.handled_at) return ''
  if (s.handled_as === 'dismissed') return '<span class="flag off">Dismissed</span>'
  if (s.handled_as === 'accepted') return '<span class="flag ok">Accepted</span>'
  // The tag itself opens the event's public page, once it has one.
  const tag = s.event_code
    ? `<a class="flag ok" href="${escapeHtml(`${publicOrigin}/e/${s.event_code}`)}" target="_blank" rel="noopener">Added as an event ↗</a>`
    : '<span class="flag ok">Added as an event</span>'
  const uuid = s.handled_listing_id?.startsWith(MANUAL_ID_PREFIX) ? s.handled_listing_id.slice(MANUAL_ID_PREFIX.length) : null
  return `${tag}${uuid && UUID.test(uuid) ? ` <a href="/events/${uuid}">Edit the event</a>` : ''}`
}

async function suggestionsPage(db: D1Like, url: URL, publicOrigin: string, email: string): Promise<string> {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.kind, s.name, s.title, s.url, s.event_date, s.event_time, s.created_at, s.poster_key,
              s.handled_at, s.handled_as, s.handled_listing_id, e.short_code AS event_code
         FROM suggestions s ${SUGGESTION_EVENT_JOIN}
        ORDER BY s.created_at DESC LIMIT 300`,
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
      ${s.handled_at ? `<div class="row-actions">${handledNote(s, publicOrigin)}</div>` : ''}
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

async function suggestionPage(db: D1Like, url: URL, id: string, publicOrigin: string, email: string): Promise<Response> {
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
    ['Emails', escapeHtml(`to us: ${s.admin_mail ?? 'not recorded'} · thank-you: ${s.user_mail ?? 'not recorded'}${s.accepted_mail ? ` · accepted: ${s.accepted_mail}` : ''}`)],
    ['Poster', s.poster_error && escapeHtml(`one was sent but not kept (${s.poster_error})`)],
  ]
  const details = `<dl class="details">${rows
    .filter(([, value]) => value)
    .map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`)
    .join('')}</dl>`

  let actions: string
  let hint = ''
  if (!s.handled_at) {
    // Offered for websites too: "Barrie Film Festival" sent as a website is often one event.
    const create = `<a class="button" href="/new?from=${s.id}">Create an event from this</a>`
    const accept = `<form method="post" action="/suggestions/${s.id}/accept"><button type="submit" class="button ghost">Accept without an event</button></form>`
    actions = `${create}${accept}<form method="post" action="/suggestions/${s.id}/dismiss"><button type="submit" class="link">Dismiss</button></form>`
    const website =
      s.kind === 'website'
        ? 'Sent as a website that lists events: to plan it as a source, accept it without an event; if it is really one event, create it. '
        : ''
    const tell = !s.email
      ? 'They left no email address, so accepting tells nobody.'
      : s.accepted_mail
        ? 'They were already emailed when it was first accepted, so accepting again sends nothing.'
        : 'Accepting it, with an event or without, emails them to say so, with a link if you create the event.'
    hint = `<p class="muted">${website}${tell}</p>`
  } else if (s.handled_as === 'dismissed' || s.handled_as === 'accepted') {
    actions = `${handledNote(s, publicOrigin)}<form method="post" action="/suggestions/${s.id}/reopen"><button type="submit" class="link">Undo, and put it back in the waiting list</button></form>`
  } else {
    actions = handledNote(s, publicOrigin)
  }

  const poster = s.poster_key
    ? `<p><a href="/suggestions/${s.id}/poster" target="_blank" rel="noopener"><img class="poster" src="/suggestions/${s.id}/poster" alt="The poster sent with this suggestion"></a></p>`
    : ''
  const flash = url.searchParams.get('accepted') === '1' ? `<p class="flash">Accepted. ${mailNote(url.searchParams.get('mail'), false)}</p>` : ''
  return page(shell(suggestionLabel(s), `${flash}<div class="actions">${actions}</div>${hint}${details}${poster}<p><a href="/suggestions">All suggestions</a></p>`, email))
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
 * Dismiss a waiting suggestion, or send a dismissed or accepted one back to waiting. One
 * approved as an event cannot go back: its event may be showing its poster, which would stop
 * being served. Undoing an acceptance unsends nothing, and accepting again emails nobody twice.
 */
type MailOutcome = 'sent' | 'failed' | 'skipped' | 'already'

/**
 * Tell a suggester their suggestion was accepted, once. The outcome is kept on the row
 * whether it went or not, and a row that has one is never mailed again. A failed email
 * never undoes the acceptance: the row says what happened.
 */
async function notifyAccepted(env: ConsoleEnv, s: SuggestionRow, event: { title: string; url: string } | null): Promise<MailOutcome> {
  if (!s.email) return 'skipped'
  if (s.accepted_mail) return 'already'
  let outcome = 'sent'
  if (!env.EMAIL) outcome = 'error: no EMAIL binding'
  else {
    try {
      await env.EMAIL.send({ to: s.email, from: MAIL_FROM, replyTo: ADMIN_ADDRESS, ...acceptedMail({ kind: s.kind, createdAt: s.created_at }, event) })
    } catch (err) {
      outcome = `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500)
    }
  }
  if (outcome !== 'sent') console.error('console: acceptance email not sent', outcome)
  await runBatched(env.DB, [env.DB.prepare('UPDATE suggestions SET accepted_mail = ? WHERE id = ?').bind(outcome, s.id)])
  return outcome === 'sent' ? 'sent' : 'failed'
}

function mailNote(outcome: string | null, linked: boolean): string {
  switch (outcome) {
    case 'sent':
      return linked ? 'We emailed them a link to it.' : 'We emailed them to say so.'
    case 'failed':
      return 'The email to them could not be sent; the reason is on the suggestion.'
    case 'skipped':
      return 'They left no email address, so nobody was told.'
    case 'already':
      return 'They were emailed when it was first accepted, so not again.'
    default:
      return ''
  }
}

/** Accept a waiting suggestion without making an event of it: a website planned as a source, say. */
async function acceptSuggestion(env: ConsoleEnv, id: string, email: string): Promise<Response> {
  const s = await loadSuggestion(env.DB, id)
  if (!s) return notFound(email)
  if (s.handled_at) return redirect(`/suggestions/${id}`)
  await runBatched(env.DB, [
    env.DB.prepare("UPDATE suggestions SET handled_at = ?, handled_as = 'accepted' WHERE id = ? AND handled_at IS NULL").bind(new Date().toISOString(), id),
  ])
  const mail = await notifyAccepted(env, s, null)
  return redirect(`/suggestions/${id}?accepted=1&mail=${mail}`)
}

async function setDismissed(db: D1Like, id: string, dismiss: boolean): Promise<Response> {
  await runBatched(db, [
    dismiss
      ? db
          .prepare("UPDATE suggestions SET handled_at = ?, handled_as = 'dismissed' WHERE id = ? AND handled_at IS NULL")
          .bind(new Date().toISOString(), id)
      : db
          .prepare("UPDATE suggestions SET handled_at = NULL, handled_as = NULL WHERE id = ? AND handled_as IN ('dismissed', 'accepted')")
          .bind(id),
  ])
  return redirect(dismiss ? `/suggestions?dismissed=${id}` : `/suggestions/${id}`)
}

/* --------------------------------------------------------------- staged news events */

/**
 * Drafts the news scraper (JmaJeremy/news-event-scraper) found in local news articles.
 *
 * It writes into `staged_events` in this database; nothing it writes is ever an event.
 * Reviewing one and saving the form below creates an ordinary `manual` listing, exactly as
 * typing an event by hand does — which is the only way anything here reaches the site.
 *
 * It is a second inbox rather than more rows in `suggestions` on purpose. A suggestion is
 * a message from a person, with a reply owed and an address to answer; a staged draft is a
 * machine's reading of someone else's journalism, and what it needs on screen is the
 * opposite: the quotes it was drawn from, so the reading can be checked against the article
 * rather than taken on trust.
 */
export interface StagedRow {
  id: string
  source_slug: string
  article_url: string
  article_title: string
  article_published_at: string | null
  title: string
  title_generated: number
  municipality_slug: string | null
  local_date: string
  local_time: string | null
  end_date: string | null
  end_time: string | null
  venue_name: string | null
  address: string | null
  description: string | null
  organizer: string | null
  cost: string
  cost_text: string | null
  url: string | null
  image_url: string | null
  evidence: string
  confidence: number | null
  notes: string | null
  created_at: string
  handled_at: string | null
  handled_as: string | null
  handled_listing_id: string | null
  event_code?: string | null
}

const STAGED_EVENT_JOIN = `LEFT JOIN listings l ON l.id = s.handled_listing_id LEFT JOIN events e ON e.id = l.cluster_id`

const loadStaged = (db: D1Like, id: string): Promise<StagedRow | null> =>
  db
    .prepare(`SELECT s.*, e.short_code AS event_code FROM staged_events s ${STAGED_EVENT_JOIN} WHERE s.id = ?`)
    .bind(id)
    .first<StagedRow>()

/** The quotes the scraper checked against the article, keyed by the field each supports. */
function evidenceOf(row: Pick<StagedRow, 'evidence'>): Record<string, string> {
  try {
    const parsed = JSON.parse(row.evidence || '{}') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    )
  } catch {
    return {}
  }
}

/** A staged draft in the event form's own field names. */
function valuesFromStaged(s: StagedRow): Record<string, string> {
  return {
    title: s.title,
    municipality: s.municipality_slug ?? '',
    date: s.local_date,
    start_time: s.local_time ?? '',
    end_date: s.end_date ?? '',
    end_time: s.end_time ?? '',
    venue: s.venue_name ?? '',
    address: s.address ?? '',
    // Deliberately empty unless the scraper wrote one. It never copies the article's prose,
    // so a description here is written by hand or the event goes without.
    description: s.description ?? '',
    organizer: s.organizer ?? '',
    cost: s.cost,
    cost_text: s.cost_text ?? '',
    url: s.url ?? '',
    image_url: s.image_url ?? '',
  }
}

function stagedNote(
  s: Pick<StagedRow, 'handled_at' | 'handled_as' | 'handled_listing_id' | 'event_code'>,
  publicOrigin: string,
): string {
  if (!s.handled_at) return ''
  if (s.handled_as === 'dismissed') return '<span class="flag off">Dismissed</span>'
  if (s.handled_as === 'duplicate') return '<span class="flag">Already on the calendar</span>'
  const tag = s.event_code
    ? `<a class="flag ok" href="${escapeHtml(`${publicOrigin}/e/${s.event_code}`)}" target="_blank" rel="noopener">Added as an event ↗</a>`
    : '<span class="flag ok">Added as an event</span>'
  const uuid = s.handled_listing_id?.startsWith(MANUAL_ID_PREFIX)
    ? s.handled_listing_id.slice(MANUAL_ID_PREFIX.length)
    : null
  return `${tag}${uuid && UUID.test(uuid) ? ` <a href="/events/${uuid}">Edit the event</a>` : ''}`
}

async function stagedPage(db: D1Like, url: URL, publicOrigin: string, email: string): Promise<string> {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.source_slug, s.article_url, s.article_title, s.article_published_at, s.title,
              s.title_generated, s.municipality_slug, s.local_date, s.local_time, s.venue_name,
              s.cost, s.confidence, s.evidence, s.created_at, s.handled_at, s.handled_as,
              s.handled_listing_id, e.short_code AS event_code
         FROM staged_events s ${STAGED_EVENT_JOIN}
        ORDER BY s.handled_at IS NOT NULL, s.local_date, s.created_at DESC
        LIMIT 300`,
    )
    .all<StagedRow>()

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
  const waiting = results.filter((s) => !s.handled_at && s.local_date >= today)
  // A draft nobody looked at before its date is not dismissed, just too late to add.
  const missed = results.filter((s) => !s.handled_at && s.local_date < today)
  const done = results.filter((s) => s.handled_at).slice(0, 50)

  const row = (s: StagedRow): string => {
    const when = `${escapeHtml(s.local_date)}${s.local_time ? ` at ${escapeHtml(s.local_time)}` : ' (no time given)'}`
    const place = s.municipality_slug ? escapeHtml(municipalityBySlug(s.municipality_slug)?.shortName ?? s.municipality_slug) : 'Not specified'
    return `<li>
      <div class="row-main"><a href="/staged/${s.id}"><strong>${escapeHtml(s.title)}</strong></a>${
        s.title_generated ? '<span class="flag warn">Title invented</span>' : ''
      }${s.cost === 'paid' ? '<span class="flag">Paid</span>' : ''}</div>
      <div class="row-meta">${when} · ${place}${s.venue_name ? ` · ${escapeHtml(s.venue_name)}` : ''}</div>
      <div class="row-meta">Found in ${escapeHtml(s.source_slug)}${
        s.article_published_at ? `, published ${escapeHtml(received(s.article_published_at))}` : ''
      }</div>
      ${s.handled_at ? `<div class="row-actions">${stagedNote(s, publicOrigin)}</div>` : ''}
    </li>`
  }
  const list = (rows: StagedRow[], empty: string): string =>
    rows.length ? `<ul class="rows">${rows.map(row).join('')}</ul>` : `<p class="muted">${empty}</p>`

  const dismissed = results.find((s) => s.id === url.searchParams.get('dismissed'))
  const flash = dismissed
    ? `<p class="flash">Dismissed “${escapeHtml(dismissed.title)}”. <a href="/staged/${dismissed.id}">Open it</a> to undo that.</p>`
    : ''

  return shell(
    'Found in the news',
    `${flash}
    <p class="muted">Events the news scraper read out of local news articles. Nothing here is on the
    site: check it against the article it came from, then save it as an event or dismiss it.</p>
    <h2>Waiting</h2>${list(waiting, 'Nothing waiting.')}
    ${missed.length ? `<h2>Their date has passed</h2>${list(missed, '')}` : ''}
    ${done.length ? `<h2>Done</h2>${list(done, '')}` : ''}`,
    email,
  )
}

async function stagedDetailPage(db: D1Like, id: string, publicOrigin: string, email: string): Promise<Response> {
  const s = await loadStaged(db, id)
  if (!s) return notFound(email)

  const evidence = evidenceOf(s)
  const quotes = Object.entries(evidence)
    .map(([field, quote]) => `<dt>${escapeHtml(field)}</dt><dd class="pre">“${escapeHtml(quote)}”</dd>`)
    .join('')

  const place = s.municipality_slug
    ? escapeHtml(municipalityBySlug(s.municipality_slug)?.name ?? s.municipality_slug)
    : 'Not specified'
  const rows: Array<[string, string | null]> = [
    ['Title', `${escapeHtml(s.title)}${s.title_generated ? ' <span class="flag warn">not in the article’s own words</span>' : ''}`],
    ['When', `${escapeHtml(s.local_date)}${s.local_time ? ` at ${escapeHtml(s.local_time)}` : ' — no time given'}${s.end_date ? ` until ${escapeHtml(s.end_date)}` : ''}`],
    ['Municipality', place],
    ['Venue', s.venue_name && escapeHtml(s.venue_name)],
    ['Address', s.address && escapeHtml(s.address)],
    ['Organizer', s.organizer && escapeHtml(s.organizer)],
    ['Cost', `${escapeHtml(s.cost)}${s.cost_text ? ` — ${escapeHtml(s.cost_text)}` : ''}`],
    ['Link', s.url && /^https?:\/\//i.test(s.url) ? `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.url)}</a>` : null],
    ['Confidence', s.confidence === null ? null : escapeHtml(s.confidence.toFixed(2))],
    ['The reader’s note', s.notes && escapeHtml(s.notes)],
  ]
  const details = `<dl class="details">${rows
    .filter(([, value]) => value)
    .map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`)
    .join('')}</dl>`

  const article = `<div class="from-suggestion">
    <p><strong>Read out of a news article</strong> in ${escapeHtml(s.source_slug)}${
      s.article_published_at ? `, published ${escapeHtml(received(s.article_published_at))}` : ''
    } · <a href="${escapeHtml(s.article_url)}" target="_blank" rel="noopener noreferrer">Read it ↗</a></p>
    <p class="muted pre">${escapeHtml(s.article_title)}</p>
    <p>Every quote below was checked to appear in that article. The title never is — articles
    name events in prose — so read that one against the story before saving.</p>
    ${quotes ? `<dl class="details">${quotes}</dl>` : ''}
  </div>`

  let actions: string
  if (!s.handled_at) {
    actions =
      `<a class="button" href="/new?staged=${s.id}">Create an event from this</a>` +
      `<form method="post" action="/staged/${s.id}/dismiss"><button type="submit" class="link">Dismiss</button></form>`
  } else if (s.handled_as === 'dismissed' || s.handled_as === 'duplicate') {
    actions = `${stagedNote(s, publicOrigin)}<form method="post" action="/staged/${s.id}/reopen"><button type="submit" class="link">Undo, and put it back in the waiting list</button></form>`
  } else {
    actions = stagedNote(s, publicOrigin)
  }

  return page(
    shell(s.title, `<div class="actions">${actions}</div>${article}${details}<p><a href="/staged">All news drafts</a></p>`, email),
  )
}

/**
 * Dismiss a waiting draft, or send a dismissed one — or one filed as already on the
 * calendar — back to waiting. Nothing is ever deleted: the row is the record that this
 * article was read, and its `stage_key` is what stops a second outlet's copy of the same
 * event being staged all over again.
 */
async function setStagedDismissed(db: D1Like, id: string, dismiss: boolean): Promise<Response> {
  await runBatched(db, [
    dismiss
      ? db
          .prepare("UPDATE staged_events SET handled_at = ?, handled_as = 'dismissed' WHERE id = ? AND handled_at IS NULL")
          .bind(new Date().toISOString(), id)
      : db
          .prepare("UPDATE staged_events SET handled_at = NULL, handled_as = NULL WHERE id = ? AND handled_as IN ('dismissed', 'duplicate')")
          .bind(id),
  ])
  return redirect(dismiss ? `/staged?dismissed=${id}` : `/staged/${id}`)
}

/* ------------------------------------------------------------------------- social posts */

/**
 * The approval screen for the social poster's drafts.
 *
 * `JmaJeremy/social-event-poster` drafts each evening's posts into `social_posts` — this
 * database, the calendar's schema (0008) — and this page is where a person says yes. It
 * lives here rather than in the poster because it is a view over shared rows behind the
 * Access application that already guards everything else, the same place the news
 * scraper's drafts are reviewed.
 *
 * Every write is a conditional UPDATE that only moves a row out of the state it was shown
 * in, so a stale tab cannot approve something already sent or skipped, and nothing here
 * ever sends a post: approving marks a row for the poster's send pass (SCEC-90) to pick up.
 */

type SocialAction = 'approve' | 'unapprove' | 'skip' | 'unskip'

interface SocialRow {
  id: string
  platform: 'facebook' | 'x' | 'instagram'
  post_date: string
  event_id: string
  short_code: string
  post_key: string
  rank: number
  score: number
  cost: string
  snapshot: string
  hook: string | null
  hook_source: 'model' | 'none' | 'edited'
  body: string
  image_path: string | null
  status: 'drafted' | 'approved' | 'posting' | 'posted' | 'failed' | 'skipped' | 'stale' | 'expired'
  error: string | null
  decided_at: string | null
  decided_by: string | null
  posted_at: string | null
}

/** What the post said about its event when it was drafted. camelCase: the poster writes it. */
interface SocialSnapshot {
  title: string
  localDate: string
  localTime: string
  allDay: boolean
  timePrecision: string
  venueName: string | null
  municipalitySlug: string | null
  cost: string
}

const PLATFORM_NAMES: Record<SocialRow['platform'], string> = { facebook: 'Facebook', x: 'X', instagram: 'Instagram' }

/**
 * The most a platform will take. X's is counted crudely here — the poster's `xLength`
 * weighs links at 23 and emoji at two, and its send pass checks again — because only a
 * rough ceiling is needed to stop an edit that could never go out.
 */
const SOCIAL_LIMITS: Record<SocialRow['platform'], number> = { x: 280, facebook: 63_206, instagram: 2_200 }

const STATUS_FLAGS: Record<SocialRow['status'], string> = {
  drafted: '<span class="flag warn">Waiting</span>',
  approved: '<span class="flag ok">Approved</span>',
  posting: '<span class="flag">Sending</span>',
  posted: '<span class="flag ok">Posted</span>',
  failed: '<span class="flag off">Failed</span>',
  skipped: '<span class="flag off">Skipped</span>',
  stale: '<span class="flag warn">Stale — the event changed</span>',
  expired: '<span class="flag">Expired</span>',
}

const snapshotOf = (row: Pick<SocialRow, 'snapshot'>): SocialSnapshot | null => {
  try {
    return JSON.parse(row.snapshot) as SocialSnapshot
  } catch {
    return null
  }
}

const socialWhen = (snap: SocialSnapshot): string =>
  when({ local_date: snap.localDate, local_time: snap.localTime, all_day: snap.allDay ? 1 : 0, time_precision: snap.timePrecision } as never)

const dayHeading = (date: string): string =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })

async function loadSocialRow(db: D1Like, id: string): Promise<SocialRow | null> {
  return db.prepare('SELECT * FROM social_posts WHERE id = ?').bind(id).first<SocialRow>()
}

async function socialPage(db: D1Like, url: URL, publicOrigin: string, email: string): Promise<string> {
  const today = todayLocal()
  const { results } = await db
    .prepare(
      `SELECT * FROM social_posts WHERE post_date >= date(?, '-7 days')
        ORDER BY post_date, rank, platform LIMIT 500`,
    )
    .bind(today)
    .all<SocialRow>()
  const lastRun = await db
    .prepare(`SELECT local_date, ran_at, stats FROM social_runs WHERE kind = 'draft' ORDER BY ran_at DESC LIMIT 1`)
    .first<{ local_date: string; ran_at: string; stats: string | null }>()

  const upcoming = results.filter((r) => r.post_date >= today && r.status !== 'expired')
  const earlier = results.filter((r) => r.post_date < today || r.status === 'expired').reverse().slice(0, 60)

  const post = (r: SocialRow): string => {
    const limit = SOCIAL_LIMITS[r.platform]
    const length = r.body.length
    const count = r.platform === 'x' ? `${length}/${limit}` : `${length} characters`
    const actions: string[] = []
    if (r.status === 'drafted') {
      actions.push(`<a href="/social/${r.id}">Edit</a>`)
      actions.push(`<form method="post" action="/social/${r.id}/skip"><button type="submit" class="link">Skip ${PLATFORM_NAMES[r.platform]}</button></form>`)
    }
    if (r.status === 'approved') {
      actions.push(`<form method="post" action="/social/${r.id}/unapprove"><button type="submit" class="link">Undo approval</button></form>`)
      actions.push(`<form method="post" action="/social/${r.id}/skip"><button type="submit" class="link">Skip</button></form>`)
    }
    if (r.status === 'skipped' && r.post_date >= today) {
      actions.push(`<form method="post" action="/social/${r.id}/unskip"><button type="submit" class="link">Undo skip</button></form>`)
    }
    const decided = r.decided_by && (r.status === 'approved' || r.status === 'skipped')
      ? `<span class="muted"> by ${escapeHtml(r.decided_by)}</span>`
      : ''
    return `<div class="post">
      <div class="row-meta"><strong>${PLATFORM_NAMES[r.platform]}</strong>${STATUS_FLAGS[r.status]}${
        r.hook_source === 'edited'
          ? '<span class="flag edited">Edited</span>'
          : // Offered is not used: Facebook and Instagram drop a hook their excerpt already says.
            r.hook_source === 'model' && r.hook && r.body.includes(r.hook)
            ? '<span class="flag">Hook by the judge</span>'
            : ''
      } · <span class="${length > limit ? 'over' : ''}">${count}</span>${decided}</div>
      ${r.image_path ? `<img class="thumb" src="${escapeHtml(`${publicOrigin}${r.image_path}`)}" alt="The image that will go with this post">` : ''}
      <p class="body">${escapeHtml(r.body)}</p>
      ${r.error ? `<p class="error">${escapeHtml(r.error)}</p>` : ''}
      ${actions.length ? `<div class="row-actions">${actions.join('')}</div>` : ''}
    </div>`
  }

  // One event, every platform it is drafted for, and one approval for all of them.
  const event = (rows: SocialRow[]): string => {
    const first = rows[0]!
    const snap = snapshotOf(first)
    const place = snap?.municipalitySlug ? municipalityBySlug(snap.municipalitySlug)?.shortName ?? snap.municipalitySlug : 'Not specified'
    const waiting = rows.find((r) => r.status === 'drafted')
    const approve = waiting
      ? `<form method="post" action="/social/${waiting.id}/approve"><button type="submit" class="button">Approve${rows.length > 1 ? ' for every platform' : ''}</button></form>`
      : ''
    return `<div class="social-event">
      <div class="row-main"><div><strong>${first.rank}. ${escapeHtml(snap?.title ?? first.short_code)}</strong>
        <a href="${escapeHtml(`${publicOrigin}/e/${first.short_code}`)}" target="_blank" rel="noopener">View on site ↗</a>
        ${first.cost === 'paid' ? '<span class="flag">Paid</span>' : ''}</div>${approve}</div>
      ${snap ? `<div class="row-meta">${escapeHtml(socialWhen(snap))} · ${escapeHtml(place)}${snap.venueName ? ` · ${escapeHtml(snap.venueName)}` : ''}</div>` : ''}
      ${rows.map(post).join('')}
    </div>`
  }

  const days = [...new Set(upcoming.map((r) => r.post_date))].map((date) => {
    const rows = upcoming.filter((r) => r.post_date === date)
    const events = [...new Set(rows.map((r) => r.post_key))].map((key) => rows.filter((r) => r.post_key === key))
    const waiting = rows.filter((r) => r.status === 'drafted').length
    const approveAll = waiting
      ? `<form method="post" action="/social/day/${date}/approve"><button type="submit" class="button ghost">Approve all ${waiting} waiting</button></form>`
      : ''
    return `<div class="day"><h2>Going out ${escapeHtml(dayHeading(date))}</h2>${approveAll}</div>${events.map(event).join('')}`
  })

  const pastRow = (r: SocialRow): string => {
    const snap = snapshotOf(r)
    return `<li><div class="row-main"><strong>${escapeHtml(snap?.title ?? r.short_code)}</strong> · ${PLATFORM_NAMES[r.platform]}${STATUS_FLAGS[r.status]}</div>
      <div class="row-meta">For ${escapeHtml(dayHeading(r.post_date))}${r.decided_by ? ` · decided by ${escapeHtml(r.decided_by)}` : ''}</div></li>`
  }

  let run = ''
  if (lastRun) {
    let stats: Record<string, any> = {}
    try {
      stats = JSON.parse(lastRun.stats ?? '{}')
    } catch {}
    const rejected = Object.entries(stats.judging?.hooksRejected ?? {}).map(([why, n]) => `${n} ${why}`).join(', ')
    run = `<p class="muted run">Last drafted ${escapeHtml(received(lastRun.ran_at))} for ${escapeHtml(dayHeading(lastRun.local_date))} ·
      judge ${escapeHtml(String(stats.judge ?? 'unknown'))}${
        stats.judge && stats.judge !== 'none' ? ` · ${Number(stats.judging?.hooksKept ?? 0)} hook${stats.judging?.hooksKept === 1 ? '' : 's'} kept${rejected ? `, rejected ${escapeHtml(rejected)}` : ''}` : ''
      }${stats.judgeError ? ` · <span class="error">the judge failed: ${escapeHtml(String(stats.judgeError))}</span>` : ''}</p>`
  }

  const flash = socialFlash(url)
  return shell(
    'Social posts',
    `${flash}
    <p class="muted">Drafted each evening by the social poster from the next few days' events. Nothing
    here has been posted: approving a post marks it to go out the next morning, and it goes out
    exactly as written below.</p>
    ${run}
    ${days.length ? days.join('') : '<p class="muted">Nothing waiting. Tomorrow’s posts are drafted from 6 p.m.</p>'}
    ${earlier.length ? `<h2>Earlier</h2><ul class="rows">${earlier.map(pastRow).join('')}</ul>` : ''}`,
    email,
  )
}

function socialFlash(url: URL): string {
  const done = url.searchParams.get('done')
  const messages: Record<string, string> = {
    approve: 'Approved.',
    day: 'Approved every waiting post for that day.',
    unapprove: 'Approval undone; the post is waiting again.',
    skip: 'Skipped. It will not be posted.',
    unskip: 'Skip undone; the post is waiting again.',
    edit: 'Saved. The post will go out as edited.',
    unchanged: 'Nothing had changed, so nothing was saved.',
    missed: 'That post had already moved on — sent, skipped, or its day passed — so it was left as it was.',
    duplicate: 'That event already has an approved post on that platform, so this one was left waiting.',
  }
  const message = done ? messages[done] : undefined
  if (!message) return ''
  const bad = done === 'missed' || done === 'duplicate'
  return `<p class="flash${bad ? ' error' : ''}">${message}</p>`
}

/** D1's own word for a conditional UPDATE that matched nothing. Absent in some test doubles. */
const changedNothing = (result: { meta?: { changes?: number } }): boolean => result.meta?.changes === 0

/**
 * Approve, un-approve, skip or un-skip.
 *
 * Approving takes the row's siblings with it — the same event on the other platforms, the
 * same day — because a person approves an event, not a platform; skipping stays per row, so
 * one platform's post can be dropped while the others go out. Nothing moves a row out of a
 * state other than the one the page showed it in, and nothing touches a day already past.
 */
async function socialAction(db: D1Like, id: string, action: SocialAction, email: string): Promise<Response> {
  const row = await loadSocialRow(db, id)
  if (!row) return notFound(email)
  const today = todayLocal()
  const now = new Date().toISOString()
  const statement = {
    approve: () =>
      db
        .prepare(
          `UPDATE social_posts SET status = 'approved', decided_at = ?, decided_by = ?
            WHERE post_key = ? AND post_date = ? AND status = 'drafted' AND post_date >= ?`,
        )
        .bind(now, email, row.post_key, row.post_date, today),
    unapprove: () =>
      db
        .prepare(
          `UPDATE social_posts SET status = 'drafted', decided_at = NULL, decided_by = NULL
            WHERE id = ? AND status = 'approved' AND post_date >= ?`,
        )
        .bind(id, today),
    skip: () =>
      db
        .prepare(
          `UPDATE social_posts SET status = 'skipped', decided_at = ?, decided_by = ?
            WHERE id = ? AND status IN ('drafted', 'approved')`,
        )
        .bind(now, email, id),
    unskip: () =>
      db
        .prepare(
          `UPDATE social_posts SET status = 'drafted', decided_at = NULL, decided_by = NULL
            WHERE id = ? AND status = 'skipped' AND post_date >= ?`,
        )
        .bind(id, today),
  }[action]()

  try {
    const result = await statement.run()
    return redirect(`/social?done=${changedNothing(result) ? 'missed' : action}`)
  } catch (err) {
    // The partial unique index: an event already approved or sent on that platform.
    if (/UNIQUE/i.test(err instanceof Error ? err.message : String(err))) return redirect('/social?done=duplicate')
    throw err
  }
}

async function approveSocialDay(db: D1Like, date: string, email: string): Promise<Response> {
  try {
    const result = await db
      .prepare(
        `UPDATE social_posts SET status = 'approved', decided_at = ?, decided_by = ?
          WHERE post_date = ? AND status = 'drafted' AND post_date >= ?`,
      )
      .bind(new Date().toISOString(), email, date, todayLocal())
      .run()
    return redirect(`/social?done=${changedNothing(result) ? 'missed' : 'day'}`)
  } catch (err) {
    if (/UNIQUE/i.test(err instanceof Error ? err.message : String(err))) return redirect('/social?done=duplicate')
    throw err
  }
}

/** Browsers submit a textarea's line breaks as CRLF; the stored body has LF. */
const lf = (value: unknown): string => String(value ?? '').replace(/\r\n?/g, '\n')

function socialEditForm(row: SocialRow, publicOrigin: string, email: string, problem = '', value = row.body): Response {
  const snap = snapshotOf(row)
  const title = `Edit the ${PLATFORM_NAMES[row.platform]} post`
  return page(
    shell(
      title,
      `<p class="muted">${escapeHtml(snap?.title ?? row.short_code)} · going out ${escapeHtml(dayHeading(row.post_date))} ·
        <a href="${escapeHtml(`${publicOrigin}/e/${row.short_code}`)}" target="_blank" rel="noopener">View the event ↗</a></p>
      <p class="hint">This is sent exactly as written. Once saved it is never rewritten from the event again, so a
      change to the event after this — a new time, a new venue — makes the post stale rather than updating it.</p>
      ${problem ? `<p class="flash error">${escapeHtml(problem)}</p>` : ''}
      <form method="post" action="/social/${row.id}" class="event-form">
        <input type="hidden" name="orig_body" value="${escapeHtml(row.body)}">
        <div class="field${problem ? ' has-error' : ''}"><label for="body">Post</label>
          <textarea id="body" name="body" rows="14">${escapeHtml(value)}</textarea>
          <span class="hint">At most ${SOCIAL_LIMITS[row.platform].toLocaleString('en-CA')} characters on ${PLATFORM_NAMES[row.platform]}. Keep the link to the event.</span></div>
        <div class="actions"><button type="submit" class="button">Save</button><a href="/social">Cancel</a></div>
      </form>`,
      email,
    ),
    problem ? 422 : 200,
  )
}

async function socialEditPage(db: D1Like, id: string, publicOrigin: string, email: string): Promise<Response> {
  const row = await loadSocialRow(db, id)
  if (!row) return notFound(email)
  if (row.status !== 'drafted') {
    return page(
      shell(
        'Not editable',
        `<p>Only a post still waiting can be edited. ${row.status === 'approved' ? 'Undo its approval first.' : 'This one has moved on.'}</p><p><a href="/social">Back to the posts</a></p>`,
        email,
      ),
      409,
    )
  }
  return socialEditForm(row, publicOrigin, email)
}

/**
 * Save an edited post.
 *
 * Compared with what the form was filled in with, never re-read from the row, for the
 * reason the event editor does the same: an unchanged form must store nothing. An edited
 * body is marked `edited`, which is what tells the send pass never to re-render it from the
 * event — and the UPDATE only lands if the stored body is still the one that was edited, so
 * two tabs cannot silently overwrite each other.
 */
async function saveSocialEdit(db: D1Like, request: Request, id: string, publicOrigin: string, email: string): Promise<Response> {
  const row = await loadSocialRow(db, id)
  if (!row) return notFound(email)
  const form = await readForm(request)
  const body = lf(form.body).trim()
  const original = lf(form.orig_body)
  if (body === original.trim()) return redirect('/social?done=unchanged')
  if (row.status !== 'drafted') return redirect('/social?done=missed')

  if (!body) return socialEditForm(row, publicOrigin, email, 'A post cannot be empty.', body)
  if (body.length > SOCIAL_LIMITS[row.platform]) {
    return socialEditForm(row, publicOrigin, email, `That is ${body.length} characters; ${PLATFORM_NAMES[row.platform]} takes ${SOCIAL_LIMITS[row.platform]}.`, body)
  }
  // Every post exists to send a reader to the event; one without the link has lost its point.
  if (!body.includes(`/e/${row.short_code}`)) {
    return socialEditForm(row, publicOrigin, email, 'The link to the event has been removed. Put it back before saving.', body)
  }

  const result = await db
    .prepare(`UPDATE social_posts SET body = ?, hook_source = 'edited' WHERE id = ? AND status = 'drafted' AND body = ?`)
    .bind(body, id, original)
    .run()
  return redirect(`/social?done=${changedNothing(result) ? 'missed' : 'edit'}`)
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
  .flag.edited { background: var(--warn-bg); color: var(--warn); }
  .button.ghost { background: transparent; color: var(--accent); box-shadow: inset 0 0 0 1.5px var(--accent); }
  .search { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px 14px; margin: 8px 0 18px; }
  .search .field { margin: 0; }
  .search .grow { flex: 1 1 260px; }
  .check { display: flex; align-items: center; gap: 6px; padding-bottom: 9px; font-weight: 600; }
  .check input { width: auto; }
  form.inline { display: inline; margin: 0; }
  .notice > div + div { margin-top: 6px; }
  .listed { margin: 0; padding-left: 1.2em; }
  .listed li { margin: 4px 0; }
  a.flag { text-decoration: none; }
  a.flag:hover { text-decoration: underline; }
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
  .day { margin: 26px 0 8px; display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 16px; }
  .day h2 { margin: 0; }
  .day form { margin: 0; }
  .social-event { padding: 12px 0 4px; border-bottom: 1px solid var(--line); }
  .social-event .row-main { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 12px; }
  .social-event .row-main form { margin: 0; }
  .post { margin: 8px 0 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); }
  .post .body { margin: 6px 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
  .post .row-meta .flag:first-of-type { margin-left: 8px; }
  .over { color: var(--bad); font-weight: 700; }
  .run { font-size: 13.5px; }
  @media (max-width: 600px) { .pair, .details { grid-template-columns: 1fr; } }
</style>
</head><body>
<header><a href="/">Out in Simcoe · console</a>${
  email ? `<nav><a href="/">Added by hand</a><a href="/find">All events</a><a href="/suggestions">Suggestions</a><a href="/staged">In the news</a><a href="/social">Social</a></nav><span class="who">Signed in as ${escapeHtml(email)}</span>` : ''
}</header>
<main><h1>${escapeHtml(title)}</h1>${body}</main>
</body></html>`
}
