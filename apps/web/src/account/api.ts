import type { AccountsDb } from '../auth/db.ts'
import { readForm } from '../auth/routes.ts'
import { isSameOriginWrite, sessionUser } from '../auth/session.ts'
import { savedQueryFrom } from '../query.ts'
import { eventForPin, listFilters, listPins, pin, saveFilter, unpin, type EventsDb } from './store.ts'

/**
 * JSON for ONE reader: never cached anywhere but their own browser, never readable by
 * another origin.
 *
 * The worker's `json()` sets `public, s-maxage` and `Access-Control-Allow-Origin: *`,
 * which is right for the event list and catastrophic here — it would put one reader's pins
 * in a shared cache behind a header inviting any site to read them. So this is a separate
 * helper with a separate name, and nothing per-user may ever go through `json()`.
 */
export const privateJson = (data: unknown, status = 200): Response =>
  Response.json(data, {
    status,
    headers: { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' },
  })

export interface MeEnv {
  DB: EventsDb
  ACCOUNTS: AccountsDb
  CANONICAL_HOST?: string
}

/**
 * /api/me and its two writes, the front end's view of the signed-in reader. The pages
 * themselves never change with sign-in state — /e/{code} is byte-identical for everyone,
 * so it stays cacheable — and a small script asks here instead.
 *
 * Deliberately minimal: which events are pinned and which views are saved. No address,
 * no name; the account page shows those, to the reader, on a no-store page.
 */
export async function handleMe(request: Request, url: URL, env: MeEnv, now = new Date()): Promise<Response> {
  // The session cookie only exists on the canonical host, so anywhere else nobody is
  // signed in — said plainly rather than redirected, since a fetch cannot follow a 302
  // to another origin usefully.
  const onCanonical = !env.CANONICAL_HOST || url.hostname === env.CANONICAL_HOST
  const user = onCanonical ? await sessionUser(env.ACCOUNTS, request, now) : null

  if (url.pathname === '/api/me') {
    if (request.method !== 'GET') return privateJson({ error: 'method' }, 405)
    if (!user) return privateJson({ signedIn: false })
    const [pins, filters] = await Promise.all([listPins(env.ACCOUNTS, user.userId), listFilters(env.ACCOUNTS, user.userId)])
    return privateJson({
      signedIn: true,
      pins: pins.map((p) => p.eventId),
      filters: filters.map((f) => ({ id: f.id, label: f.label, query: f.query })),
    })
  }

  if (request.method !== 'POST') return privateJson({ error: 'method' }, 405)
  if (!onCanonical || !isSameOriginWrite(request, url.hostname)) return privateJson({ error: 'cross-site' }, 403)
  if (!user) return privateJson({ error: 'signed-out' }, 401)
  const form = await readForm(request)
  if (!form) return privateJson({ error: 'form' }, 400)

  if (url.pathname === '/api/me/pins') {
    const eventId = form.event ?? ''
    if (!eventId || eventId.length > 512) return privateJson({ error: 'event' }, 400)
    if (form.pinned === '0') {
      await unpin(env.ACCOUNTS, user.userId, eventId)
      return privateJson({ pinned: false })
    }
    const event = await eventForPin(env.DB, eventId)
    if (!event) return privateJson({ error: 'no-such-event' }, 404)
    const result = await pin(env.ACCOUNTS, user.userId, event, now)
    return result === 'full' ? privateJson({ error: 'full' }, 409) : privateJson({ pinned: true })
  }

  if (url.pathname === '/api/me/filters') {
    const query = savedQueryFrom(new URLSearchParams(form.query ?? ''))
    const saved = await saveFilter(env.ACCOUNTS, user.userId, form.label ?? '', query, now)
    if (!saved.ok) return privateJson({ error: saved.reason }, saved.reason === 'full' ? 409 : 400)
    return privateJson({ saved: true, id: saved.id, query })
  }

  return privateJson({ error: 'not-found' }, 404)
}
