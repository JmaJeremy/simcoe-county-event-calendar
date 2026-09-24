/**
 * The signed-in reader, as far as the front end ever knows it.
 *
 * Pages are the same for everyone — /e/{code} is byte-identical signed in or out, so it
 * stays cacheable — and this module asks /api/me once, after load, and switches on what
 * applies. A failure of any kind reads as signed out: nothing on the calendar may wait
 * on, or break over, an account.
 */

let mePromise = null

/** `{ signedIn, pins: Set<eventId>, filters: [{ id, label, query }] }`, asked once per page. */
export function fetchMe() {
  mePromise ??= fetch('/api/me', { headers: { Accept: 'application/json' } })
    .then((res) => (res.ok ? res.json() : { signedIn: false }))
    .catch(() => ({ signedIn: false }))
    .then((me) => ({ signedIn: !!me.signedIn, pins: new Set(me.pins ?? []), filters: me.filters ?? [] }))
  return mePromise
}

async function post(path, fields) {
  try {
    const res = await fetch(path, { method: 'POST', body: new URLSearchParams(fields), headers: { Accept: 'application/json' } })
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) }
  } catch {
    return { ok: false, status: 0, data: {} }
  }
}

/** Pin or unpin; resolves to the new state, or null when the server said no. */
export async function setPinned(eventId, pinned) {
  const res = await post('/api/me/pins', { event: eventId, pinned: pinned ? '1' : '0' })
  return res.ok ? !!res.data.pinned : null
}

/** Save a view (a query string in the list's own language) under a label. */
export async function saveView(label, query) {
  const res = await post('/api/me/filters', { label, query })
  return res.ok ? { ok: true, id: res.data.id, query: res.data.query } : { ok: false, error: res.data.error ?? 'failed' }
}

/** Where a signed-out reader goes to sign in and come straight back here. */
export const signInHref = () => `/account/signin?next=${encodeURIComponent(location.pathname + location.search)}`

/*
 * The event page's Pin button: rendered hidden for everyone, shown here. Signed out it
 * still shows, and takes the reader to sign in and back again — the button is how most
 * readers will find out accounts exist.
 */
for (const button of document.querySelectorAll('button[data-pin-page]')) {
  const id = button.dataset.pinPage
  fetchMe().then((me) => {
    let pinned = me.signedIn && me.pins.has(id)
    const draw = () => {
      button.textContent = pinned ? 'Pinned' : 'Pin'
      button.setAttribute('aria-pressed', String(pinned))
    }
    draw()
    button.hidden = false
    button.addEventListener('click', async () => {
      if (!me.signedIn) {
        location.href = signInHref()
        return
      }
      button.disabled = true
      const now = await setPinned(id, !pinned)
      if (now !== null) pinned = now
      button.disabled = false
      draw()
    })
  })
}
