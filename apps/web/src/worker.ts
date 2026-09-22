import { MUNICIPALITIES, buildIcal, municipalityBySlug } from '@scec/core'
import { UNPLACED, buildQuery, listUrlFrom, parseFilters, rowToEvent, type PublicEvent, type Row } from './query.ts'
import { SITE_NAME, escapeHtml, titleCase } from './html.ts'
import { renderEventPage, renderNotFound, renderPlacePage, shareableImage } from './pages.ts'
import { descriptionText } from './markdown.ts'
import { renderRobots, renderSitemap, type SitemapEntry } from './sitemap.ts'
import { TURNSTILE_FIELD, adminMail, thanksMail, validateSuggestion, verifyTurnstile, type Suggestion } from './suggest.ts'
import { MAX_POSTER_BYTES, inspectImage, stripMetadata, type ImageKind } from './image.ts'

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

/** The R2 bucket binding — only the part of it this worker uses. */
interface PosterBucket {
  put(key: string, value: Uint8Array, options: { httpMetadata: { contentType: string } }): Promise<unknown>
  get(key: string): Promise<{ body: ReadableStream } | null>
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
  /** Posters uploaded with suggestions. Private: see servePoster. */
  POSTERS?: PosterBucket
  /** The admin console, which the admin email links to. */
  CONSOLE_ORIGIN?: string
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

/** Today in Simcoe County, which is what "on now" means to everyone reading the site. */
const todayLocal = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })

const html = (body: string, status = 200, extra: Record<string, string> = {}): Response =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...extra } })

/**
 * The municipality index the shell's footer carries, substituted in like __ORIGIN__.
 *
 * It comes from MUNICIPALITIES rather than the database because that registry decides
 * which places exist, and the home page should not pay for a query to render nineteen
 * links that change about never. Its real job is to give a crawler nineteen internal
 * links from the site's strongest page — without it the municipality pages are in the
 * sitemap and linked from nowhere.
 */
const placeLinks = (): string =>
  MUNICIPALITIES.map((m) => `<a href="/place/${m.slug}">${escapeHtml(m.shortName)}</a>`).join(' · ')

/**
 * A poster's measured size, if the ingest pass has read it. One indexed lookup on the
 * event page only — never on the list, which shares no poster of its own.
 *
 * Absent or unmeasurable (the row exists with NULL) means no dimensions are written at
 * all. Facebook lays the card out from them, so silence beats a guess: the picture then
 * appears on the second share rather than being drawn at the wrong shape on the first.
 */
async function measuredImageSize(env: Env, image: string | null): Promise<{ width: number; height: number } | undefined> {
  if (!image) return undefined
  try {
    const row = await env.DB.prepare('SELECT width, height FROM image_sizes WHERE url = ?').bind(image).first<{ width: number | null; height: number | null }>()
    return row?.width && row.height ? { width: row.width, height: row.height } : undefined
  } catch {
    // A share card is not worth failing an event page over.
    return undefined
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // Keep one canonical origin once a domain exists: feed URLs and permalinks embed
    // whichever host produced them.
    if (env.CANONICAL_HOST && url.hostname === `www.${env.CANONICAL_HOST}`) {
      url.hostname = env.CANONICAL_HOST
      return Response.redirect(url.toString(), 301)
    }

    const origin = canonicalOrigin(url, env)
    /*
     * The workers.dev fallback serves the identical site, which without this is textbook
     * duplicate content: two hosts, one set of pages, and a search engine free to pick
     * the wrong winner. Every page already declares a canonical on the apex; this makes
     * the weaker signal explicit. `follow` so links out of it still count. With no
     * CANONICAL_HOST set there is only one host, so there is nothing to prefer.
     */
    const isCanonicalHost = !env.CANONICAL_HOST || url.hostname === env.CANONICAL_HOST
    const indexHeaders: Record<string, string> = isCanonicalHost ? {} : { 'X-Robots-Tag': 'noindex, follow' }

    try {
      if (url.pathname === '/api/suggest') {
        if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } })
        return await handleSuggestion(request, env)
      }

      if (url.pathname.startsWith('/posters/')) return await servePoster(env, url.pathname.slice('/posters/'.length))

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

      if (url.pathname === '/robots.txt') {
        return new Response(renderRobots(origin, isCanonicalHost), {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'public, max-age=3600, s-maxage=86400',
          },
        })
      }

      if (url.pathname === '/sitemap.xml') {
        return new Response(renderSitemap(await sitemapEntries(env), origin), {
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            // Events appear and move every couple of hours, so a stale sitemap delays
            // discovery of exactly the listings that are most worth finding.
            'Cache-Control': 'public, max-age=600, s-maxage=3600',
          },
        })
      }

      // A bare /place has nothing to show; without this the asset router 404s it.
      if (url.pathname === '/place' || url.pathname === '/place/') {
        return Response.redirect(`${origin}/`, 301)
      }

      // One indexable page per municipality — and the only crawlable route to the event
      // permalinks below, which are otherwise reachable only from a shared link.
      if (url.pathname.startsWith('/place/')) {
        const slug = decodeURIComponent(url.pathname.slice('/place/'.length)).replace(/\/$/, '')
        return await placeResponse(env, slug, origin, indexHeaders)
      }

      // The feature none of the upstream calendars offer: a subscribable feed.
      if (url.pathname === '/calendar.ics') {
        const events = await queryEvents(env, url)
        const names: Record<string, string> = {}
        for (const e of events) if (e.municipalitySlug && e.municipalityName) names[e.municipalitySlug] = e.municipalityName
        // Calendar apps show a description as plain text, so the markdown comes out.
        const plain = events.map((e) => (e.description ? { ...e, description: descriptionText(e.description) } : e))
        return new Response(buildIcal(plain, { calendarName: describeFilters(url, events), baseUrl: origin, municipalityNames: names }), {
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
        if (!row) {
          return notFound(origin, 'Event not found', 'That link does not match any event we list. It may have been taken down by whoever published it.')
        }
        const shareEvent = rowToEvent(row)
        return html(renderEventPage(shareEvent, origin, listUrlFrom(url), await measuredImageSize(env, shareableImage(shareEvent))), 200, {
          'Cache-Control': 'public, max-age=600',
          ...indexHeaders,
        })
      }

      // The long form redirects so there is a single canonical URL.
      if (url.pathname.startsWith('/event/')) {
        const id = decodeURIComponent(url.pathname.slice('/event/'.length))
        const row = await lookupEvent(env, 'id', id)
        if (!row) return notFound(origin, 'Event not found', 'That link does not match any event we list.')
        return Response.redirect(`${origin}/e/${row.short_code}`, 301)
      }

      // Share metadata needs ABSOLUTE urls, but the shell is a static file with no idea
      // which host served it. Substituting here keeps shares correct on workers.dev now
      // and on a custom domain later.
      const asset = await env.ASSETS.fetch(request)
      if (isShell(url.pathname) && asset.ok) {
        const body = (await asset.text())
          .replaceAll('__ORIGIN__', origin)
          .replaceAll('__PLACE_LINKS__', placeLinks())
        const headers = new Headers(asset.headers)
        headers.set('Content-Type', 'text/html; charset=utf-8')
        for (const [k, v] of Object.entries(indexHeaders)) headers.set(k, v)
        return new Response(body, { status: asset.status, headers })
      }
      return asset
    } catch (err) {
      return new Response(`Error: ${err instanceof Error ? err.message : String(err)}`, { status: 500 })
    }
  },
}

/**
 * The site's inbox: gets every suggestion, and is where a thank-you's reply goes. Used
 * only in mail headers — never in a response body, where it would be harvestable.
 */
const ADMIN_ADDRESS = 'contact@outinsimcoe.ca'
/** Stands in for the address in response messages; see `reply` in handleSuggestion. */
const CONTACT_PLACEHOLDER = '{contact}'
const MAIL_FROM: EmailAddress = { email: ADMIN_ADDRESS, name: SITE_NAME }
/** Per sender, per hour. A person suggesting a whole festival programme will not hit it. */
const SUGGESTIONS_PER_HOUR = 5
const MAX_BODY_BYTES = 64_000
/** A form carrying a poster: the image plus room for every text field at its cap. */
const MAX_UPLOAD_BYTES = MAX_POSTER_BYTES + MAX_BODY_BYTES

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
  /*
   * Messages never carry the site's address, since anything POSTing here — bots
   * included — reads them. They say {contact} instead: the page's script swaps in the
   * address it assembles itself, and a scripts-off reader is pointed at the page, where
   * the address is shown obfuscated.
   */
  const reply = (status: number, error?: string): Response => {
    if (wantsJson) return Response.json(error ? { ok: false, error } : { ok: true }, { status, headers: { 'Cache-Control': 'no-store' } })
    if (!error) return Response.redirect(new URL('/suggest?sent=1', request.url).toString(), 303)
    return new Response(error.replaceAll(CONTACT_PLACEHOLDER, 'us (the address is on the suggestion page)'), {
      status,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  }

  const type = request.headers.get('Content-Type') ?? ''
  const cap = type.includes('multipart/form-data') ? MAX_UPLOAD_BYTES : MAX_BODY_BYTES
  if (Number(request.headers.get('Content-Length') ?? 0) > cap) {
    // Only the size is known here, not what made it big; the exact "image too big" answer
    // comes once the form is read and the poster itself can be measured.
    return reply(413, cap === MAX_UPLOAD_BYTES ? 'That is too much to send in one go. If you attached an image, please use one under 5 MB.' : 'That is too long to send in one go.')
  }

  let form: Record<string, unknown>
  try {
    const body: unknown = type.includes('application/json') ? await request.json() : Object.fromEntries(await request.formData())
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object')
    form = body as Record<string, unknown>
  } catch {
    return reply(400, 'That submission could not be read. Please try again.')
  }

  // A file input with nothing chosen still sends an empty file; that is no poster.
  const upload = isFile(form.poster) && form.poster.size > 0 ? form.poster : null

  // Validation first: a typo in the link should not cost a round trip to Cloudflare, and
  // a token is single-use, so spending it on a submission that fails anyway is waste.
  const result = validateSuggestion(form, { hasPoster: upload !== null })
  // A bot is thanked like anyone else and nothing is kept, so it has nothing to learn.
  if (result.ok === 'spam') return reply(200)
  if (!result.ok) return reply(400, result.error)
  const suggestion: Suggestion = result.suggestion

  /*
   * The poster is checked before Turnstile too, for the same reason, but stored only after
   * it: a bot's bytes never reach the bucket. It is judged by its content, and what is kept
   * is the picture without its metadata — see stripMetadata.
   */
  let poster: { bytes: Uint8Array; kind: ImageKind } | null = null
  if (upload && suggestion.kind === 'event') {
    if (upload.size > MAX_POSTER_BYTES) return reply(413, 'That image is too big. Please use one under 5 MB.')
    const original = new Uint8Array(await upload.arrayBuffer())
    const kind = inspectImage(original)
    const bytes = kind && stripMetadata(original, kind)
    if (!kind || !bytes) return reply(400, "That file isn't an image we can use. Please send a JPEG, PNG, GIF or WebP.")
    poster = { bytes, kind }
  }

  const ip = request.headers.get('CF-Connecting-IP')

  // Fail closed. A missing email binding loses nothing, since the row is kept; a missing
  // bot check would quietly let anything through, which nobody would notice until the
  // domain's mail reputation did.
  if (!env.TURNSTILE_SECRET_KEY) {
    console.error('suggest: TURNSTILE_SECRET_KEY is not set; refusing submissions')
    return reply(503, `The suggestion form is not accepting submissions right now. Please email ${CONTACT_PLACEHOLDER} instead.`)
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
        ? `This form needs JavaScript turned on to check that you're not a bot. Please turn it on and try again, or email ${CONTACT_PLACEHOLDER}.`
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

  // Stored before the row, so the row never names an object that is not there. A failure
  // costs the poster, not the suggestion: the row says why, and so does the admin email.
  let posterKey: string | null = null
  let posterProblem: string | null = null
  if (poster) {
    // Unguessable, though the bucket is private anyway; the suggestion id groups them.
    const key = `${id}/${crypto.randomUUID()}.${poster.kind.ext}`
    if (!env.POSTERS) posterProblem = 'no POSTERS binding'
    else {
      try {
        await env.POSTERS.put(key, poster.bytes, { httpMetadata: { contentType: poster.kind.contentType } })
        posterKey = key
      } catch (err) {
        posterProblem = `storage failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300)
      }
    }
    if (posterProblem) console.error('suggest: poster not stored', posterProblem)
  }

  await env.DB.prepare(
    `INSERT INTO suggestions (id, kind, name, email, title, url, event_date, event_time, description, comments, ip_hash, created_at,
                              poster_key, poster_type, poster_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, suggestion.kind, suggestion.name, suggestion.email, suggestion.title, suggestion.url, suggestion.date,
      suggestion.time, suggestion.description, suggestion.comments, ipHash, receivedAt,
      posterKey, posterKey ? poster!.kind.contentType : null, posterProblem)
    .run()

  // Reply-To on the admin copy is the suggester, so answering them is one click.
  const consoleOrigin = env.CONSOLE_ORIGIN?.replace(/\/$/, '') ?? null
  const admin = adminMail(suggestion, {
    id,
    receivedAt,
    reviewUrl: consoleOrigin ? `${consoleOrigin}/suggestions/${id}` : null,
    posterUrl: posterKey && consoleOrigin ? `${consoleOrigin}/suggestions/${id}/poster` : null,
    posterProblem: posterProblem ?? (posterKey && !consoleOrigin ? `stored as ${posterKey}, but CONSOLE_ORIGIN is not set` : null),
  })
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

const isFile = (value: unknown): value is File =>
  typeof value === 'object' && value !== null && typeof (value as File).arrayBuffer === 'function' && typeof (value as File).size === 'number'

/** `{suggestion uuid}/{uuid}.{ext}`, exactly as handleSuggestion names them. */
const POSTER_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|gif|webp)$/

/**
 * A suggested poster, once its suggestion has been approved as an event.
 *
 * The bucket is private. Until the admin approves, a poster is only visible in the console
 * behind Access; approving publishes it here, where the event page can show it and use it
 * as its share image. Dismissing, or never deciding, keeps it private. The content type is
 * the one decided from the bytes at upload, never one the sender declared.
 */
async function servePoster(env: Env, key: string): Promise<Response> {
  const missing = () => new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
  if (!POSTER_KEY.test(key) || !env.POSTERS) return missing()
  const row = await env.DB.prepare("SELECT poster_type FROM suggestions WHERE poster_key = ? AND handled_as = 'event'")
    .bind(key)
    .first<{ poster_type: string | null }>()
  if (!row?.poster_type) return missing()
  const object = await env.POSTERS.get(key)
  if (!object) return missing()
  return new Response(object.body, {
    headers: {
      'Content-Type': row.poster_type,
      // A day, not forever: approval can be undone, and the edge should let go soon after.
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    },
  })
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

const notFound = (origin: string, heading: string, detail: string): Response =>
  html(renderNotFound(heading, detail, origin), 404, { 'X-Robots-Tag': 'noindex, follow' })

async function placeResponse(
  env: Env,
  slug: string,
  origin: string,
  indexHeaders: Record<string, string>,
): Promise<Response> {
  // The registry is the authority on which municipalities exist, so an unknown slug is a
  // 404 without touching the database.
  const place = municipalityBySlug(slug)
  if (!place) {
    return notFound(
      origin,
      'Municipality not found',
      'We do not cover a municipality at that address. Simcoe County has nineteen, and all of them are linked from the home page.',
    )
  }

  const today = todayLocal()
  /*
   * Deliberately not buildQuery: that applies the list's defaults, which hide paid events.
   * A page answering "what is on in this town" that silently dropped every ticketed
   * concert would be answering a different question. Civic meetings stay out, as they do
   * everywhere else here — those belong to civi-times.
   */
  const select = `SELECT e.*, m.name AS municipality_name
       FROM events e LEFT JOIN municipalities m ON m.slug = e.municipality_slug
      WHERE e.municipality_slug = ? AND e.active = 1 AND e.category <> 'civic-meeting'`
  const upcoming = await env.DB.prepare(
    `${select} AND e.local_date >= ? ORDER BY e.starts_at_utc ASC LIMIT 120`,
  )
    .bind(slug, today)
    .all<Row>()
  // Counted separately, because the list stops at 120 and Essa alone has several hundred:
  // "120 upcoming events" at the top of that page would simply be false.
  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM events e
      WHERE e.municipality_slug = ? AND e.active = 1 AND e.category <> 'civic-meeting' AND e.local_date >= ?`,
  )
    .bind(slug, today)
    .first<{ n: number }>()
  const past = await env.DB.prepare(
    `${select} AND e.local_date < ? ORDER BY e.starts_at_utc DESC LIMIT 12`,
  )
    .bind(slug, today)
    .all<Row>()

  const others = MUNICIPALITIES.filter((m) => m.slug !== slug)
  return html(
    renderPlacePage(place, upcoming.results.map(rowToEvent), past.results.map(rowToEvent), others, origin, total?.n),
    200,
    { 'Cache-Control': 'public, max-age=900', ...indexHeaders },
  )
}

/**
 * Every URL worth crawling: the home page, the nineteen municipalities and each event
 * permalink.
 *
 * No `lastmod`. `updated_at` would be the obvious source, but dedup rewrites every event
 * in its window on every run, so on any given day nearly all of them carry the time of
 * the last cron run — a sitemap built from it tells search engines everything changed two
 * hours ago, and they learn to ignore the field for the whole site. Better absent than
 * wrong; it can come back once `updated_at` only moves when an event's content does.
 *
 * Not /suggest either: the form is marked noindex, and a sitemap listing a noindex page
 * is flagged as an error in Search Console.
 */
async function sitemapEntries(env: Env): Promise<SitemapEntry[]> {
  // Only '/' for the app itself: every other view of it is a query string that the
  // shell's canonical already points back here, so listing them would ask for a crawl of
  // URLs that declare themselves duplicates.
  // The privacy page is indexable, unlike /suggest, so it belongs here: it is the one
  // page a reader (or an app reviewer) may go looking for by name rather than by event.
  const entries: SitemapEntry[] = [
    { path: '/', changefreq: 'hourly', priority: '1.0' },
    { path: '/privacy', changefreq: 'monthly', priority: '0.2' },
  ]

  // The registry decides which municipality pages exist, exactly as placeResponse does.
  for (const place of MUNICIPALITIES) {
    entries.push({ path: `/place/${place.slug}`, changefreq: 'daily', priority: '0.8' })
  }

  // Past events stay listed for a while: someone searching for a festival after the fact
  // should still find the page. A year back is plenty and keeps the file small.
  const cutoff = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10)
  const { results: events } = await env.DB.prepare(
    `SELECT short_code FROM events
      WHERE active = 1 AND category <> 'civic-meeting' AND local_date >= ?
      ORDER BY starts_at_utc DESC LIMIT 20000`,
  )
    .bind(cutoff)
    .all<{ short_code: string }>()
  for (const event of events) {
    entries.push({ path: `/e/${event.short_code}`, changefreq: 'weekly', priority: '0.6' })
  }

  return entries
}
