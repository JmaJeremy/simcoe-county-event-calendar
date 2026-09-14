import { buildIcal, sourceBySlug } from '@scec/core'
import { UNPLACED, buildQuery, listUrlFrom, parseFilters, rowToEvent, type PublicEvent, type Row } from './query.ts'

interface D1Statement {
  all<T>(): Promise<{ results: T[] }>
  first<T>(): Promise<T | null>
}

export interface Env {
  DB: {
    prepare(query: string): D1Statement & { bind(...values: unknown[]): D1Statement }
  }
  ASSETS: { fetch(request: Request): Promise<Response> }
  /** Set once a custom domain is attached; www then redirects to it. */
  CANONICAL_HOST?: string
}

const SITE_NAME = 'Simcoe County Events'

const json = (data: unknown, cacheSeconds: number): Response =>
  Response.json(data, {
    headers: {
      // The data changes every couple of hours at most, so let the edge absorb traffic.
      'Cache-Control': `public, max-age=60, s-maxage=${cacheSeconds}`,
      'Access-Control-Allow-Origin': '*',
    },
  })

async function queryEvents(env: Env, url: URL): Promise<PublicEvent[]> {
  const { sql, bindings } = buildQuery(parseFilters(url))
  const statement = env.DB.prepare(sql)
  const { results } = await (bindings.length ? statement.bind(...bindings) : statement).all<Row>()
  return results.map(rowToEvent)
}

async function lookupEvent(env: Env, column: 'short_code' | 'id', value: string): Promise<Row | null> {
  // `column` is one of two literals, never user input; `value` is always bound.
  return env.DB.prepare(
    `SELECT e.*, m.name AS municipality_name
       FROM events e LEFT JOIN municipalities m ON m.slug = e.municipality_slug
      WHERE e.${column} = ?`,
  )
    .bind(value)
    .first<Row>()
}

/** The one asset that carries share metadata and therefore needs origin substitution. */
const isShell = (pathname: string): boolean => pathname === '/' || pathname === '/index.html'

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/**
 * The mark: a sun over a field — the county's fairs and festivals. Inlined so a shared
 * permalink paints it with the first byte, drawn in currentColor to follow the theme.
 */
const MARK = `<svg class="mark" viewBox="0 0 48 48" fill="none" aria-hidden="true" focusable="false">
  <circle cx="24" cy="19" r="7.5" fill="var(--accent)"/>
  <path d="M24 4.5v4M11 11l2.9 2.9M37 11l-2.9 2.9M4.5 21h4M39.5 21h4" stroke="var(--accent)" stroke-width="3" stroke-linecap="round"/>
  <path d="M0 48V37c6.5-4.5 11-1 16.5-3.5S27 26 33 29.5 42 37 48 33.5V48Z" fill="currentColor"/>
</svg>`

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // Keep one canonical origin once a domain exists: feed URLs and permalinks embed
    // whichever host produced them.
    if (env.CANONICAL_HOST && url.hostname === `www.${env.CANONICAL_HOST}`) {
      url.hostname = env.CANONICAL_HOST
      return Response.redirect(url.toString(), 301)
    }

    try {
      if (url.pathname === '/api/events') {
        const events = await queryEvents(env, url)
        return json({ count: events.length, events }, 600)
      }

      if (url.pathname === '/api/municipalities') {
        const { results } = await env.DB.prepare(
          `SELECT m.slug, m.name, m.short_name, m.level, m.parent_slug,
                  COUNT(e.id) AS event_count
             FROM municipalities m
             LEFT JOIN events e ON e.municipality_slug = m.slug AND e.active = 1
            GROUP BY m.slug ORDER BY m.name`,
        ).all<unknown>()
        return json(results, 600)
      }

      if (url.pathname === '/api/sources') {
        const { results } = await env.DB.prepare(
          `SELECT s.slug, s.name, s.kind, s.platform, s.municipality_slug, s.homepage,
                  COUNT(l.id) AS listing_count, MAX(l.last_seen_at) AS last_seen,
                  (SELECT ok FROM sync_runs r WHERE r.source_slug = s.slug ORDER BY r.started_at DESC LIMIT 1) AS last_ok
             FROM sources s
             LEFT JOIN listings l ON l.source_slug = s.slug AND l.active = 1
            WHERE s.enabled = 1
            GROUP BY s.slug ORDER BY s.name`,
        ).all<unknown>()
        return json(results, 600)
      }

      if (url.pathname === '/api/categories') {
        const { results } = await env.DB.prepare(
          `SELECT category, COUNT(*) AS count FROM events WHERE active = 1 GROUP BY category ORDER BY count DESC`,
        ).all<unknown>()
        return json(results, 600)
      }

      // Used by the front end to distinguish a blocked request from a real outage.
      if (url.pathname === '/health') {
        const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE active = 1').first<{ n: number }>()
        const run = await env.DB.prepare('SELECT MAX(finished_at) AS at FROM dedup_runs').first<{ at: string | null }>()
        return json({ ok: true, events: row?.n ?? 0, lastRun: run?.at ?? null }, 60)
      }

      // The feature none of the upstream calendars offer: a subscribable feed.
      if (url.pathname === '/calendar.ics') {
        const events = await queryEvents(env, url)
        const names: Record<string, string> = {}
        for (const e of events) if (e.municipalitySlug && e.municipalityName) names[e.municipalitySlug] = e.municipalityName
        return new Response(buildIcal(events, { calendarName: describeFilters(url, events), baseUrl: url.origin, municipalityNames: names }), {
          headers: {
            'Content-Type': 'text/calendar; charset=utf-8',
            'Cache-Control': 'public, max-age=300, s-maxage=1800',
            'Content-Disposition': 'inline; filename="simcoe-county-events.ics"',
          },
        })
      }

      // The short, shareable form. Server-rendered so a pasted link previews properly.
      if (url.pathname.startsWith('/e/')) {
        const code = decodeURIComponent(url.pathname.slice('/e/'.length))
        const row = await lookupEvent(env, 'short_code', code)
        if (!row) return new Response('Event not found', { status: 404 })
        return new Response(renderEventPage(rowToEvent(row), url.origin, listUrlFrom(url)), {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=600' },
        })
      }

      // The long form redirects so there is a single canonical URL.
      if (url.pathname.startsWith('/event/')) {
        const id = decodeURIComponent(url.pathname.slice('/event/'.length))
        const row = await lookupEvent(env, 'id', id)
        if (!row) return new Response('Event not found', { status: 404 })
        return Response.redirect(`${url.origin}/e/${row.short_code}`, 301)
      }

      // Share metadata needs ABSOLUTE urls, but the shell is a static file with no idea
      // which host served it. Substituting here keeps shares correct on workers.dev now
      // and on a custom domain later.
      const asset = await env.ASSETS.fetch(request)
      if (isShell(url.pathname) && asset.ok) {
        const html = (await asset.text()).replaceAll('__ORIGIN__', url.origin)
        const headers = new Headers(asset.headers)
        headers.set('Content-Type', 'text/html; charset=utf-8')
        return new Response(html, { status: asset.status, headers })
      }
      return asset
    } catch (err) {
      return new Response(`Error: ${err instanceof Error ? err.message : String(err)}`, { status: 500 })
    }
  },
}

function describeFilters(url: URL, events: PublicEvent[]): string {
  const parts = [SITE_NAME]
  const m = url.searchParams.get('m')
  if (m) {
    const names = new Map(events.map((e) => [e.municipalitySlug, e.municipalityName]))
    parts.push(
      m
        .split(',')
        .map((slug) => (slug === UNPLACED ? 'location not specified' : names.get(slug) ?? titleCase(slug)))
        .join(', '),
    )
  }
  const cat = url.searchParams.get('cat')
  if (cat) parts.push(cat.split(',').map(titleCase).join(', '))
  if (url.searchParams.get('cost') === 'free') parts.push('free')
  return parts.join(' — ')
}

const titleCase = (slug: string): string =>
  slug.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')

const COST_LABEL: Record<string, string> = { free: 'Free', paid: 'Paid', unknown: 'Cost not listed' }

function renderEventPage(event: PublicEvent, origin: string, backHref = '/'): string {
  const when =
    event.allDay || event.timePrecision === 'date-only'
      ? `${formatDate(event.localDate)}${event.endsAtUtc ? ` to ${formatDate(localDateOf(event.endsAtUtc, event.timezone))}` : ''} · all day`
      : `${formatDate(event.localDate)} at ${formatTime(event.localTime)}${event.endsAtUtc ? ` to ${formatTime(localTimeOf(event.endsAtUtc, event.timezone))}` : ''}`

  const place = [event.venueName, event.address].filter((v): v is string => !!v).join(', ')
  const cost = event.cost === 'free' ? 'Free' : event.costText ?? COST_LABEL[event.cost] ?? ''
  // A share preview is often all someone sees: the event, when, and where.
  const title = event.municipalityName ? `${event.title} — ${event.municipalityName}` : event.title
  const prefix = event.status === 'cancelled' ? 'CANCELLED · ' : event.status === 'rescheduled' ? 'RESCHEDULED · ' : ''
  const description = `${prefix}${[when, place || event.municipalityName, cost].filter(Boolean).join(' · ')}`
  const canonical = `${origin}/e/${event.shortCode}`

  const listedOn = event.sourceSlugs.map((slug) => sourceBySlug(slug)?.name ?? slug)
  // The listing lives on someone else's site: open it in a new tab so this page, and
  // whatever the reader was scrolling through to reach it, stays where it was.
  const links: string[] = [
    `<a class="btn" href="${escapeHtml(event.url)}" target="_blank" rel="noopener noreferrer">View the listing <span class="ext" aria-hidden="true">&#8599;</span></a>`,
  ]
  links.push(
    `<button class="btn ghost" type="button" data-share aria-haspopup="dialog"
       data-share-url="${escapeHtml(canonical)}"
       data-share-text="${escapeHtml(`${event.title} · ${when}`)}">Share</button>`,
  )

  const notices: string[] = []
  if (event.status === 'cancelled') notices.push('<p class="notice cancelled">This event has been cancelled.</p>')
  if (event.status === 'rescheduled') notices.push('<p class="notice moved">This event has been rescheduled — check the listing for the new time.</p>')
  if (event.category === 'civic-meeting') {
    notices.push('<p class="notice">This is a council or committee meeting. Agendas and minutes are on <a href="https://civi-times.ca">Civi-Times</a>.</p>')
  }

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="theme-color" content="#e05a17">
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:locale" content="en_CA">
<meta property="og:url" content="${escapeHtml(canonical)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${escapeHtml(event.imageUrl ?? `${origin}/og.png`)}">
<meta name="twitter:card" content="${event.imageUrl ? 'summary' : 'summary_large_image'}">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${escapeHtml(event.imageUrl ?? `${origin}/og.png`)}">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/style.css">
<script type="module" src="/share.js"></script>
<script type="application/ld+json">${eventJsonLd(event, canonical)}</script>
</head><body class="event-page">
<header class="topbar"><a href="${escapeHtml(backHref)}" class="home">${MARK}<span>&larr; All events</span></a></header>
<main class="card" data-cat="${escapeHtml(event.category)}">
  <p class="eyebrow">${escapeHtml(event.municipalityName ?? 'Simcoe County')} · ${escapeHtml(titleCase(event.category))}</p>
  <h1>${escapeHtml(event.title)}</h1>
  <p class="when">${escapeHtml(when)}</p>
  ${place ? `<p class="where">${escapeHtml(place)}</p>` : ''}
  <p class="cost ${escapeHtml(event.cost)}">${escapeHtml(cost)}</p>
  ${notices.join('')}
  ${event.imageUrl ? `<img class="hero" src="${escapeHtml(event.imageUrl)}" alt="">` : ''}
  ${event.description ? `<div class="description">${escapeHtml(event.description).replace(/\n+/g, '<br>')}</div>` : ''}
  ${event.organizer ? `<p class="organizer">Organized by ${escapeHtml(event.organizer)}</p>` : ''}
  <div class="actions">${links.join('')}</div>
  <p class="listed">Listed on ${listedOn.map((n) => escapeHtml(n)).join(', ')}. Details come from those sites; confirm with the organizer before you go.</p>
  ${event.municipalitySlug ? `<p class="subscribe"><a href="${origin}/calendar.ics?m=${encodeURIComponent(event.municipalitySlug)}">Subscribe to ${escapeHtml(event.municipalityName ?? '')} events</a></p>` : ''}
</main></body></html>`
}

const SCHEMA_STATUS: Record<string, string> = {
  scheduled: 'https://schema.org/EventScheduled',
  cancelled: 'https://schema.org/EventCancelled',
  rescheduled: 'https://schema.org/EventRescheduled',
}

/**
 * Structured data, so a shared link can also surface as a rich result. Serialized
 * through JSON.stringify and escaped for `</script>`, since every value here originates
 * from a third-party calendar.
 */
function eventJsonLd(event: PublicEvent, canonical: string): string {
  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: event.title,
    startDate: event.allDay || event.timePrecision === 'date-only' ? event.localDate : event.startsAtUtc,
    eventStatus: SCHEMA_STATUS[event.status] ?? SCHEMA_STATUS.scheduled,
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    url: canonical,
    isAccessibleForFree: event.cost === 'free',
  }
  if (event.endsAtUtc) data.endDate = event.endsAtUtc
  if (event.description) data.description = event.description.slice(0, 500)
  if (event.imageUrl) data.image = event.imageUrl
  if (event.organizer) data.organizer = { '@type': 'Organization', name: event.organizer }
  const place = event.venueName ?? event.address
  if (place) {
    data.location = { '@type': 'Place', name: event.venueName ?? event.address, ...(event.address ? { address: event.address } : {}) }
  }
  return JSON.stringify(data).replace(/</g, '\\u003c')
}

function formatDate(localDate: string): string {
  const [y, m, d] = localDate.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString('en-CA', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

function formatTime(localTime: string): string {
  const [h, m] = localTime.split(':').map(Number)
  const suffix = h! >= 12 ? 'p.m.' : 'a.m.'
  const hour = h! % 12 === 0 ? 12 : h! % 12
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`
}

const localDateOf = (iso: string, tz: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))

const localTimeOf = (iso: string, tz: string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso))
