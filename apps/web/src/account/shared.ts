import type { AccountsDb } from '../auth/db.ts'
import { renderFeed } from '../feed.ts'
import { renderSharedPage } from '../pages.ts'
import { userForFeedToken, userForShareSlug } from './calendar.ts'
import { livePinnedEvents, type EventsDb } from './store.ts'

/**
 * The two calendars a reader's pins can be read from without signing in, each opened by
 * the capability in its URL:
 *
 *   /calendar/{token}.ics   the private feed (SCEC-107), for the reader's own calendar app
 *   /c/{slug}, /c/{slug}.ics  the shared calendar (SCEC-108), for whoever they send it to
 *
 * Neither is ever cached outside the browser and neither is indexed: rotating the feed or
 * stopping sharing must end access at once, and an edge copy would outlive the decision.
 * An unknown token or slug is a plain 404 — not 401, which would confirm the route is
 * guarding something worth guessing at.
 */

export interface CalendarEnv {
  DB: EventsDb
  ACCOUNTS: AccountsDb
  CANONICAL_HOST?: string
  /** Signs private feed URLs. Absent, private feeds do not exist (404) and the account
   * page says so; shared calendars do not need it. */
  FEED_TOKEN_KEY?: string
}

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow',
}

const notFound = (): Response =>
  new Response('No calendar at this address. It may have been replaced with a new link.', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...PRIVATE_HEADERS },
  })

const ics = (body: string, filename: string): Response =>
  new Response(body, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `inline; filename="${filename}"`,
      ...PRIVATE_HEADERS,
    },
  })

/** Handles /calendar/… and /c/…; anything else there is a 404. */
export async function handleCalendar(url: URL, env: CalendarEnv, now = new Date()): Promise<Response> {
  const origin = env.CANONICAL_HOST ? `https://${env.CANONICAL_HOST}` : url.origin

  const feed = /^\/calendar\/([^/]+)\.ics$/.exec(url.pathname)
  if (feed) {
    if (!env.FEED_TOKEN_KEY) return notFound()
    const userId = await userForFeedToken(env.ACCOUNTS, env.FEED_TOKEN_KEY, decodeURIComponent(feed[1]!))
    if (!userId) return notFound()
    const events = await livePinnedEvents(env.DB, env.ACCOUNTS, userId)
    return ics(renderFeed(events, 'Out in Simcoe — my pinned events', origin), 'out-in-simcoe-pinned.ics')
  }

  const shared = /^\/c\/([^/.]+)(\.ics)?$/.exec(url.pathname)
  if (shared) {
    const slug = decodeURIComponent(shared[1]!)
    const userId = await userForShareSlug(env.ACCOUNTS, slug)
    if (!userId) return notFound()
    const events = await livePinnedEvents(env.DB, env.ACCOUNTS, userId)
    if (shared[2]) return ics(renderFeed(events, 'Out in Simcoe — a shared calendar', origin), 'out-in-simcoe-shared.ics')
    const today = now.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
    return new Response(renderSharedPage(events, origin, slug, today), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...PRIVATE_HEADERS },
    })
  }

  return notFound()
}
