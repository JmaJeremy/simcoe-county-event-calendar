import { buildIcal, sourceBySlug } from '@scec/core'
import { UNPLACED, buildQuery, listUrlFrom, parseFilters, rowToEvent, type PublicEvent, type Row } from './query.ts'
import { TURNSTILE_FIELD, adminMail, thanksMail, validateSuggestion, verifyTurnstile, type Suggestion } from './suggest.ts'

interface D1Statement {
  all<T>(): Promise<{ results: T[] }>
  first<T>(): Promise<T | null>
  run(): Promise<unknown>
}

interface EmailAddress {
  email: string
  name?: string
}

/** The Cloudflare Email Service binding — only the part of it this worker uses. */
interface SendEmail {
  send(message: {
    to: string | EmailAddress
    from: string | EmailAddress
    replyTo?: string | EmailAddress
    subject: string
    text: string
  }): Promise<unknown>
}

export interface Env {
  DB: {
    prepare(query: string): D1Statement & { bind(...values: unknown[]): D1Statement }
  }
  ASSETS: { fetch(request: Request): Promise<Response> }
  /** Optional so a local `wrangler dev` without it still serves the site. */
  EMAIL?: SendEmail
  /**
   * Secret for the Turnstile widget on /suggest. Deliberately NOT optional in behaviour:
   * without it the form refuses every suggestion rather than accept them unchecked.
   */
  TURNSTILE_SECRET_KEY?: string
  /** Set once a custom domain is attached; www then redirects to it. */
  CANONICAL_HOST?: string
}

const SITE_NAME = 'Out in Simcoe'

/**
 * Whether a source's own image can be used as the share card.
 *
 * govStack calendars sit behind a WAF that answers 403 to anything that does not look
 * like a browser, share crawlers included: the poster renders perfectly for a visitor and
 * not at all for Facebook or Slack, which would turn every share of those events into a
 * broken image. They keep the poster on the page and the site's own card in the preview.
 */
const shareableImage = (event: PublicEvent): string | null => {
  if (!event.imageUrl) return null
  const host = URL.parse?.(event.imageUrl)?.hostname ?? ''
  return /^(calendar|events)\./i.test(host) ? null : event.imageUrl
}

/**
 * The origin that share cards, permalinks and feed URLs should carry.
 *
 * Whichever host answered is the right answer until a domain exists; once CANONICAL_HOST
 * is set, one origin has to win, or the same event acquires two addresses — one on
 * workers.dev and one on the domain — and shares, caches and search split between them.
 */
const canonicalOrigin = (url: URL, env: Env): string =>
  env.CANONICAL_HOST ? `https://${env.CANONICAL_HOST}` : url.origin

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

/** Mirrors the tag and footer line in public/index.html; change one, change both. */
const WIP_TAG = '<p class="wip"><span class="wip-dot" aria-hidden="true"></span>Work in progress &middot; more events being added</p>'
const COPYRIGHT = '&copy; 2026 Jeremy Andrews &amp; Torbarrie Tech'

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
      if (url.pathname === '/api/suggest') {
        if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } })
        return await handleSuggestion(request, env)
      }

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
        return new Response(buildIcal(events, { calendarName: describeFilters(url, events), baseUrl: canonicalOrigin(url, env), municipalityNames: names }), {
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
        return new Response(renderEventPage(rowToEvent(row), canonicalOrigin(url, env), listUrlFrom(url)), {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=600' },
        })
      }

      // The long form redirects so there is a single canonical URL.
      if (url.pathname.startsWith('/event/')) {
        const id = decodeURIComponent(url.pathname.slice('/event/'.length))
        const row = await lookupEvent(env, 'id', id)
        if (!row) return new Response('Event not found', { status: 404 })
        return Response.redirect(`${canonicalOrigin(url, env)}/e/${row.short_code}`, 301)
      }

      // Share metadata needs ABSOLUTE urls, but the shell is a static file with no idea
      // which host served it. Substituting here keeps shares correct on workers.dev now
      // and on a custom domain later.
      const asset = await env.ASSETS.fetch(request)
      if (isShell(url.pathname) && asset.ok) {
        const html = (await asset.text()).replaceAll('__ORIGIN__', canonicalOrigin(url, env))
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

/** The site's inbox: gets every suggestion, and is where a thank-you's reply goes. */
const ADMIN_ADDRESS = 'contact@outinsimcoe.ca'
const MAIL_FROM: EmailAddress = { email: ADMIN_ADDRESS, name: SITE_NAME }
/** Per sender, per hour. A person suggesting a whole festival programme will not hit it. */
const SUGGESTIONS_PER_HOUR = 5
const MAX_BODY_BYTES = 64_000

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** An email's fate, as recorded on the suggestion row. Never throws. */
async function sendMail(env: Env, message: Parameters<SendEmail['send']>[0]): Promise<string> {
  if (!env.EMAIL) return 'error: no EMAIL binding'
  try {
    await env.EMAIL.send(message)
    return 'sent'
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500)
  }
}

/**
 * Take a suggestion from the form.
 *
 * The order matters: validate, store, then mail. Once the row is written the suggestion
 * is safe, so a mail failure is recorded on the row and the visitor still hears "thanks"
 * — telling them it failed would only get the same suggestion sent twice.
 *
 * Answers JSON to the page's own script, and a redirect or plain text to a plain form
 * post. Turnstile needs scripts, so a post with scripts off is refused with a message
 * saying so; the redirect path is kept for the day that changes.
 */
async function handleSuggestion(request: Request, env: Env): Promise<Response> {
  const wantsJson = (request.headers.get('Accept') ?? '').includes('application/json')
  const reply = (status: number, error?: string): Response => {
    if (wantsJson) return Response.json(error ? { ok: false, error } : { ok: true }, { status, headers: { 'Cache-Control': 'no-store' } })
    if (!error) return Response.redirect(new URL('/suggest?sent=1', request.url).toString(), 303)
    return new Response(error, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
  }

  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_BODY_BYTES) return reply(413, 'That is too long to send in one go.')

  let form: Record<string, unknown>
  try {
    const type = request.headers.get('Content-Type') ?? ''
    const body: unknown = type.includes('application/json') ? await request.json() : Object.fromEntries(await request.formData())
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object')
    form = body as Record<string, unknown>
  } catch {
    return reply(400, 'That submission could not be read. Please try again.')
  }

  // Validation first: a typo in the link should not cost a round trip to Cloudflare, and
  // a token is single-use, so spending it on a submission that fails anyway is waste.
  const result = validateSuggestion(form)
  // A bot is thanked like anyone else and nothing is kept, so it has nothing to learn.
  if (result.ok === 'spam') return reply(200)
  if (!result.ok) return reply(400, result.error)
  const suggestion: Suggestion = result.suggestion

  const ip = request.headers.get('CF-Connecting-IP')

  // Fail closed. A missing email binding loses nothing, since the row is kept; a missing
  // bot check would quietly let anything through, which nobody would notice until the
  // domain's mail reputation did.
  if (!env.TURNSTILE_SECRET_KEY) {
    console.error('suggest: TURNSTILE_SECRET_KEY is not set; refusing submissions')
    return reply(503, `The suggestion form is not accepting submissions right now. Please email ${ADMIN_ADDRESS} instead.`)
  }
  const human = await verifyTurnstile(
    form[TURNSTILE_FIELD],
    { secret: env.TURNSTILE_SECRET_KEY, remoteip: ip, hostname: new URL(request.url).hostname },
  )
  if (!human.ok) {
    console.warn('suggest: turnstile refused', human.codes.join(','))
    // No token at all from a plain form post means scripts are off, and the widget is a
    // script. Say that, rather than asking them to wait for a check that will never load.
    const noScript = !wantsJson && human.codes.includes('missing-input-response')
    return reply(
      human.status,
      noScript
        ? `This form needs JavaScript turned on to check that you're not a bot. Please turn it on and try again, or email ${ADMIN_ADDRESS}.`
        : human.error,
    )
  }

  const now = new Date()
  // Salted with the day, so the hash can count one sender's hour and cannot follow them
  // from one day to the next.
  const ipHash = await sha256(`${now.toISOString().slice(0, 10)}:${ip ?? 'unknown'}`)
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM suggestions WHERE ip_hash = ? AND created_at > ?')
    .bind(ipHash, new Date(now.getTime() - 3_600_000).toISOString())
    .first<{ n: number }>()
  if ((recent?.n ?? 0) >= SUGGESTIONS_PER_HOUR) {
    return reply(429, 'Thanks — that is a lot of suggestions for one hour. Please send the rest a little later.')
  }

  const id = crypto.randomUUID()
  const receivedAt = now.toISOString()
  await env.DB.prepare(
    `INSERT INTO suggestions (id, kind, name, email, title, url, event_date, event_time, description, comments, ip_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, suggestion.kind, suggestion.name, suggestion.email, suggestion.title, suggestion.url, suggestion.date,
      suggestion.time, suggestion.description, suggestion.comments, ipHash, receivedAt)
    .run()

  // Reply-To on the admin copy is the suggester, so answering them is one click.
  const admin = adminMail(suggestion, { id, receivedAt })
  const adminOutcome = await sendMail(env, {
    to: ADMIN_ADDRESS,
    from: MAIL_FROM,
    ...(suggestion.email ? { replyTo: suggestion.email } : {}),
    ...admin,
  })
  const userOutcome = suggestion.email
    ? await sendMail(env, { to: suggestion.email, from: MAIL_FROM, replyTo: ADMIN_ADDRESS, ...thanksMail(suggestion) })
    : 'skipped'

  await env.DB.prepare('UPDATE suggestions SET admin_mail = ?, user_mail = ? WHERE id = ?')
    .bind(adminOutcome, userOutcome, id)
    .run()
  return reply(200)
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
<meta property="og:image" content="${escapeHtml(shareableImage(event) ?? `${origin}/og.png`)}">
<meta name="twitter:card" content="${shareableImage(event) ? 'summary' : 'summary_large_image'}">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${escapeHtml(shareableImage(event) ?? `${origin}/og.png`)}">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<script>try { var t = localStorage.getItem('theme'); if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t } catch (e) {}</script>
<link rel="stylesheet" href="/style.css">
<script type="module" src="/share.js"></script>
<script type="application/ld+json">${eventJsonLd(event, canonical)}</script>
</head><body class="event-page">
<header class="topbar"><a href="${escapeHtml(backHref)}" class="home">${MARK}<span>&larr; All events</span></a>${WIP_TAG}</header>
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
</main>
<footer class="page-foot"><p class="copyright">${COPYRIGHT}</p></footer>
</body></html>`
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
