import type { AccountsDb } from '../auth/db.ts'
import { MAIL_FROM, sendMail, type SendEmail } from '../mail.ts'
import { formatDate, formatTime, localDateOf } from '../html.ts'
import { buildQuery, parseFilters, rowToEvent, type PublicEvent, type Row } from '../query.ts'
import { unsubscribeToken, userForUnsubscribeToken } from './calendar.ts'
import { describeSaved } from './page.ts'
import { listFilters, livePinnedEvents, type EventsDb } from './store.ts'

/**
 * Email digests (SCEC-109): a reader's pins and saved views, once a day or once a week, sent
 * by the WEB worker's hourly cron — the ingest worker must never hold the account database
 * (docs/user-accounts.md, "This moves the digest sender to the web worker").
 *
 * Three rules carry the design:
 *  - A digest is CLAIMED in digest_sends before it is sent, and the claim only succeeds
 *    while the reader's setting is still on. So a re-run cannot send twice, and an
 *    unsubscribe that lands between the sender's query and its send still wins.
 *  - A reader is due once their hour has come today, not only during it, so a run that is
 *    over budget, or a cron that failed, is caught up by the next hour.
 *  - Digests have their own daily budget, well under the account's 1,000 messages a day, so
 *    they can never spend the allowance a visitor's verification or thank-you mail needs.
 *
 * Unsubscribing is ours alone: the setting goes to 'none', and the claim above enforces it.
 * The account-wide Cloudflare suppression list the design proposed is deliberately not used
 * — it would block password resets and every other mail to the address too.
 */

/** At most this many digests per hourly run... */
export const DIGESTS_PER_RUN = 100
/** ...and per day, leaving 300 of the account's 1,000 for mail people are waiting for. */
export const DIGESTS_PER_DAY = 700
/** Events listed per saved view before "see all". */
export const PER_VIEW = 10

const SITE_TZ = 'America/Toronto'

/**
 * The wall clock in Simcoe County. hourCycle 'h23', or some ICU versions call midnight 24.
 * The weekday comes from the date itself, never a locale's name for it ('Thu' in one ICU
 * build, 'Thu.' in another), which would fail silently: no weekly digest would ever match.
 */
export function siteClock(now: Date): { date: string; hour: number; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: SITE_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  )
  const date = `${parts.year}-${parts.month}-${parts.day}`
  return { date, hour: Number(parts.hour), weekday: new Date(`${date}T00:00:00Z`).getUTCDay() }
}

const addDays = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export interface DigestEnv {
  DB: EventsDb
  ACCOUNTS: AccountsDb
  EMAIL?: SendEmail
  CANONICAL_HOST?: string
  FEED_TOKEN_KEY?: string
}

interface Section {
  heading: string
  events: PublicEvent[]
  more?: string
}

const lastDay = (e: PublicEvent): string => (e.endsAtUtc ? localDateOf(e.endsAtUtc, SITE_TZ) : e.localDate)

const eventLines = (e: PublicEvent, origin: string): string => {
  const untimed = e.allDay || e.timePrecision === 'date-only'
  const when = [formatDate(e.localDate), untimed ? null : formatTime(e.localTime), e.municipalityName].filter(Boolean).join(' · ')
  return `- ${e.title}${e.status === 'cancelled' ? ' (CANCELLED)' : ''}\n  ${when}\n  ${origin}/e/${e.shortCode}`
}

/**
 * What goes in one reader's digest for the window [start, end]: their pins in it first,
 * then each saved view's events, every event listed once however many sections it matches
 * — the same lesson as a feed's UIDs. A saved view's own date range is intersected with the
 * window rather than replaced by it.
 */
export async function composeDigest(env: DigestEnv, userId: string, start: string, end: string, origin: string): Promise<Section[]> {
  const seen = new Set<string>()
  const sections: Section[] = []

  const pins = (await livePinnedEvents(env.DB, env.ACCOUNTS, userId)).filter((e) => e.localDate <= end && lastDay(e) >= start)
  pins.forEach((e) => seen.add(e.id))
  if (pins.length) sections.push({ heading: 'Your pinned events', events: pins })

  for (const view of await listFilters(env.ACCOUNTS, userId)) {
    const params = new URLSearchParams(view.query)
    const from = [params.get('from') ?? start, start].sort().at(-1)!
    const to = [params.get('to') ?? end, end].sort()[0]!
    if (from > to) continue
    params.set('from', from)
    params.set('to', to)
    const { sql, bindings } = buildQuery(parseFilters(new URL(`https://x/?${params}`)), PER_VIEW + seen.size + 1)
    const { results } = await env.DB.prepare(sql).bind(...bindings).all<Row>()
    const fresh = results.map(rowToEvent).filter((e) => !seen.has(e.id))
    const shown = fresh.slice(0, PER_VIEW)
    shown.forEach((e) => seen.add(e.id))
    if (!shown.length) continue
    sections.push({
      heading: `${view.label} (${describeSaved(view.query)})`,
      events: shown,
      ...(fresh.length > PER_VIEW ? { more: `${origin}/?${params}` } : {}),
    })
  }
  return sections
}

/** Plain text, from database values only: nothing a stranger typed, no address anywhere. */
export function digestMessage(sections: Section[], cadence: 'daily' | 'weekly', start: string, end: string, origin: string, unsubscribeUrl: string) {
  const subject = cadence === 'daily'
    ? `Today on Out in Simcoe: ${formatDate(start)}`
    : `This week on Out in Simcoe: ${formatDate(start)} to ${formatDate(end)}`
  const body = sections
    .map((s) => `${s.heading.toUpperCase()}\n\n${s.events.map((e) => eventLines(e, origin)).join('\n\n')}${s.more ? `\n\n  See all: ${s.more}` : ''}`)
    .join('\n\n\n')
  const text = `${cadence === 'daily' ? 'Here is what is on for you today.' : 'Here is what is on for you this week.'}

${body}

--
You are getting this because you turned on a ${cadence} digest at Out in Simcoe.
Change it, or turn it off: ${origin}/account#digest
Unsubscribe with one click: ${unsubscribeUrl}
`
  return { subject, text }
}

type Claim = { meta?: { changes?: number } }

/**
 * Claim, compose, send, record — for one reader and one period. `requireOn` is false only
 * for the account page's preview, which the reader asked for with their own hands.
 */
export async function sendDigest(
  env: DigestEnv & { EMAIL: SendEmail; FEED_TOKEN_KEY: string },
  reader: { userId: string; calendarId: string; email: string },
  cadence: 'daily' | 'weekly',
  periodKey: string,
  start: string,
  now: Date,
  origin: string,
  requireOn = true,
): Promise<'sent' | 'skipped-empty' | 'already' | 'error'> {
  const claimed = (await env.ACCOUNTS.prepare(
    `INSERT INTO digest_sends (user_id, period_key, outcome, event_count, created_at)
     SELECT ?, ?, 'sending', 0, ?
      WHERE ${requireOn ? `EXISTS (SELECT 1 FROM user_calendars WHERE user_id = ? AND digest <> 'none')` : '? IS NOT NULL'}
     ON CONFLICT(user_id, period_key) DO NOTHING`,
  )
    .bind(reader.userId, periodKey, now.toISOString(), reader.userId)
    .run()) as Claim
  if (claimed?.meta?.changes !== 1) return 'already'

  const record = (outcome: string, count: number) =>
    env.ACCOUNTS.prepare('UPDATE digest_sends SET outcome = ?, event_count = ? WHERE user_id = ? AND period_key = ?')
      .bind(outcome, count, reader.userId, periodKey)
      .run()

  const end = cadence === 'daily' ? start : addDays(start, 6)
  const sections = await composeDigest(env, reader.userId, start, end, origin)
  const count = sections.reduce((n, s) => n + s.events.length, 0)
  if (!count) {
    await record('skipped-empty', 0)
    return 'skipped-empty'
  }
  const unsubscribeUrl = `${origin}/unsubscribe/${await unsubscribeToken(env.FEED_TOKEN_KEY, reader.calendarId)}`
  const outcome = await sendMail(env.EMAIL, {
    to: reader.email,
    from: MAIL_FROM,
    ...digestMessage(sections, cadence, start, end, origin, unsubscribeUrl),
    // RFC 8058 one-click: Gmail and Yahoo draw an unsubscribe button from these, and POST
    // to the URL themselves — which is why /unsubscribe takes a POST with no Origin.
    headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  })
  await record(outcome, count)
  return outcome === 'sent' ? 'sent' : 'error'
}

export interface DigestRun {
  due: number
  sent: number
  empty: number
  errors: number
  skipped?: string
}

/** The hourly cron: everyone whose hour has come today and whose period is unsent. */
export async function runDigests(env: DigestEnv, now: Date): Promise<DigestRun> {
  const run: DigestRun = { due: 0, sent: 0, empty: 0, errors: 0 }
  // No key, no unsubscribe link — and a digest without one is not sent. No host, no links.
  if (!env.FEED_TOKEN_KEY || !env.CANONICAL_HOST || !env.EMAIL) return { ...run, skipped: 'not configured' }
  const ready = { ...env, EMAIL: env.EMAIL, FEED_TOKEN_KEY: env.FEED_TOKEN_KEY }
  const origin = `https://${env.CANONICAL_HOST}`
  const clock = siteClock(now)

  // Today's spend, by the Simcoe County day every period key carries — the same day the
  // periods themselves run on. Previews ('p:') count: they spend the same allowance.
  const spent = await env.ACCOUNTS.prepare(`SELECT COUNT(*) AS n FROM digest_sends WHERE outcome = 'sent' AND period_key LIKE ?`)
    .bind(`%:${clock.date}`)
    .first<{ n: number }>()
  const budget = Math.min(DIGESTS_PER_RUN, DIGESTS_PER_DAY - (spent?.n ?? 0))
  if (budget <= 0) return { ...run, skipped: 'daily budget spent' }

  const { results } = await env.ACCOUNTS.prepare(
    `SELECT uc.user_id, uc.calendar_id, uc.digest, u.email
       FROM user_calendars uc JOIN users u ON u.id = uc.user_id
      WHERE u.email_verified_at IS NOT NULL
        AND uc.digest_hour <= ?
        AND (uc.digest = 'daily' OR (uc.digest = 'weekly' AND uc.digest_day = ?))
        AND NOT EXISTS (SELECT 1 FROM digest_sends s WHERE s.user_id = uc.user_id
                         AND s.period_key = (CASE uc.digest WHEN 'daily' THEN 'd:' ELSE 'w:' END) || ?)
      ORDER BY uc.digest_hour, uc.user_id
      LIMIT ?`,
  )
    .bind(clock.hour, clock.weekday, clock.date, budget)
    .all<{ user_id: string; calendar_id: string; digest: 'daily' | 'weekly'; email: string }>()
  run.due = results.length

  for (const r of results) {
    const key = `${r.digest === 'daily' ? 'd' : 'w'}:${clock.date}`
    try {
      const result = await sendDigest(ready, { userId: r.user_id, calendarId: r.calendar_id, email: r.email }, r.digest, key, clock.date, now, origin)
      if (result === 'sent') run.sent++
      else if (result === 'skipped-empty') run.empty++
      else if (result === 'error') run.errors++
    } catch (err) {
      // One reader's broken saved view must not stop everyone after them.
      run.errors++
      console.warn('digest failed', r.user_id, err instanceof Error ? err.message : String(err))
    }
  }
  return run
}

/**
 * /unsubscribe/{token}: turns the reader's digest off, and nothing else. GET for the link in
 * the body; POST for RFC 8058 one-click, which the mail provider's own servers send with no
 * Origin and no session — so there is deliberately no same-origin check here. The token is
 * the authority, and the only thing it can do is stop mail, the conservative direction: the
 * worst a prefetching link scanner can do is what the reader asked for anyway.
 */
export async function handleUnsubscribe(request: Request, url: URL, env: DigestEnv, render: (ok: boolean) => string, now = new Date()): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' }
  if (request.method !== 'GET' && request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { ...headers, Allow: 'GET, POST' } })
  const token = decodeURIComponent(url.pathname.slice('/unsubscribe/'.length))
  const userId = env.FEED_TOKEN_KEY ? await userForUnsubscribeToken(env.ACCOUNTS, env.FEED_TOKEN_KEY, token) : null
  if (userId) {
    await env.ACCOUNTS.prepare(`UPDATE user_calendars SET digest = 'none', updated_at = ? WHERE user_id = ?`).bind(now.toISOString(), userId).run()
  }
  if (request.method === 'POST') return new Response(userId ? 'Unsubscribed.' : 'Not found.', { status: userId ? 200 : 404, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } })
  return new Response(render(!!userId), { status: userId ? 200 : 404, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } })
}
