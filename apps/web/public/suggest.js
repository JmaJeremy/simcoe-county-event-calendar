/**
 * The suggestion form: fields that follow the kind of suggestion, the Turnstile bot
 * check, and sending without leaving the page.
 */

const $ = (id) => document.getElementById(id)
const form = $('suggest-form')
const error = $('form-error')
const submit = $('submit')

/**
 * Turnstile. The site key is public by design; the secret lives only on the worker.
 * The action must match TURNSTILE_ACTION in ../src/suggest.ts, which checks it.
 */
const TURNSTILE_SITE_KEY = '0x4AAAAAAE0QZZaEVJGV6HhE'
let widget = null

/** Matches MAX_POSTER_BYTES in ../src/image.ts, which enforces it. */
const MAX_POSTER_BYTES = 5 * 1024 * 1024

/**
 * The site's address, assembled at runtime so it never appears whole in this file for a
 * harvester to find. Server messages mark where it goes with {contact}.
 */
const CONTACT = ['contact', ['outinsimcoe', 'ca'].join('.')].join('@')
const withContact = (message) => message.replaceAll('{contact}', CONTACT)

const TURNSTILE_BLOCKED = withContact(
  "The check that keeps bots out didn't load. If you use a content blocker, allow challenges.cloudflare.com — or email your suggestion to {contact}.",
)

/**
 * Load Turnstile and render once it says it is ready.
 *
 * Injected with this callback named in its URL, so rendering waits for the API itself
 * rather than on script order. (The widget once failed to appear at all, with "render is
 * not a function": the cause was its container's id, see suggest.html, not the loading.)
 */
function loadTurnstile() {
  window.onTurnstileLoad = renderTurnstile
  const script = document.createElement('script')
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad'
  script.async = true
  script.onerror = () => {
    showError(TURNSTILE_BLOCKED)
    submit.disabled = true
  }
  document.head.append(script)
}

function renderTurnstile() {
  widget = window.turnstile.render('#turnstile-widget', {
    sitekey: TURNSTILE_SITE_KEY,
    action: 'suggest',
    size: 'flexible',
    // The site's own switch wins; with none chosen, follow the system like the page does.
    theme: document.documentElement.dataset.theme ?? 'auto',
    'error-callback': () => {
      showError(withContact("The bot check couldn't finish. Reload the page and try again, or email {contact}."))
    },
  })
}

/** A token is single-use and lasts five minutes, so every answer needs a fresh one. */
const resetTurnstile = () => {
  if (widget !== null) window.turnstile?.reset(widget)
}

/** A website suggestion has no date, time or description; hide rather than confuse. */
function applyKind() {
  const kind = form.elements.kind.value === 'website' ? 'website' : 'event'
  for (const el of form.querySelectorAll('[data-kind]')) el.hidden = el.dataset.kind !== kind
  for (const label of form.querySelectorAll('label[data-event]')) label.textContent = label.dataset[kind]
}

function showSent(sent) {
  $('form-view').hidden = sent
  $('sent-view').hidden = !sent
  window.scrollTo({ top: 0 })
}

function showError(message) {
  error.textContent = message
  error.hidden = !message
}

for (const radio of form.elements.kind) radio.addEventListener('change', applyKind)
applyKind()
loadTurnstile()

// Arriving from a script-free post, which the worker redirects here.
if (new URLSearchParams(location.search).get('sent') === '1') showSent(true)

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  showError('')
  // Said before the upload rather than after five megabytes of it.
  const poster = form.elements.poster.files[0]
  if (poster && !form.elements.poster.closest('[data-kind]').hidden && poster.size > MAX_POSTER_BYTES) {
    showError('That image is too big. Please use one under 5 MB.')
    return
  }
  // No widget means no token is coming, and the server would only refuse it.
  const token = widget === null ? '' : window.turnstile.getResponse(widget)
  if (!token) {
    showError('Please wait for the check above the Send button to finish, then send again.')
    return
  }
  submit.disabled = true
  submit.textContent = 'Sending…'
  try {
    // Multipart, for the poster. No Content-Type header: the browser writes it, with the
    // boundary the body needs.
    const body = new FormData(form)
    // Fields hidden for this kind are not part of the suggestion.
    for (const el of form.querySelectorAll('[data-kind][hidden] [name]')) body.delete(el.name)
    // An empty file input still sends an empty file.
    if (!(body.get('poster')?.size > 0)) body.delete('poster')
    const response = await fetch(form.action, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body,
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok || !result.ok) {
      showError(withContact(result.error || 'Something went wrong sending that. Please try again in a moment.'))
      return
    }
    form.reset()
    applyKind()
    showSent(true)
  } catch {
    showError("Couldn't reach the site. Check your connection and try again.")
  } finally {
    resetTurnstile()
    submit.disabled = false
    submit.textContent = 'Send suggestion'
  }
})

$('another').addEventListener('click', () => {
  history.replaceState(null, '', location.pathname)
  showSent(false)
  $('s-title').focus()
})
