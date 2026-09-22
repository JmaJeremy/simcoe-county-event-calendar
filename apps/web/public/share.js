/**
 * The share dialog, used by both the event list and a single event page.
 *
 * Builds its own markup so the two pages — one static shell, one server-rendered — do not
 * have to keep duplicate copies in step. Any element with data-share opens it; the link
 * shared is that element's data-share-url, falling back to the page's canonical URL.
 */

const TITLE = document.querySelector('meta[property="og:title"]')?.content ?? document.title

/**
 * The site's Facebook app id. Public by design — it identifies the app to Facebook and is
 * meant to be read by every visitor; it is NOT the app secret or the Page access token the
 * social poster holds, neither of which may ever appear in a file the site serves.
 *
 * It buys one thing here: the Send Dialog, the only route to Messenger that works without
 * the app being installed, so the button finally does something on a desktop. Touch devices
 * keep the `fb-messenger://` deep link, which opens the app directly and needs no app id —
 * the dialog would be a worse experience there and a regression if the app is ever
 * misconfigured. The main Facebook button deliberately stays on `sharer.php`: it needs no
 * app, no configuration and no Live-mode review, so it cannot break.
 */
const FB_APP_ID = '1400817094828583'

/**
 * Where Facebook returns the sender afterwards. The Send Dialog demands it, and Facebook
 * checks it against the app's allowed domains — so it must be the canonical host, never
 * whatever host answered (the workers.dev fallback serves the identical site and is not,
 * and should not be, on that list).
 */
function canonicalOrigin() {
  const link = document.querySelector('link[rel="canonical"]')?.href
  try {
    return new URL(link || location.href).origin
  } catch {
    return location.origin
  }
}

const onTouch = () => matchMedia('(pointer: coarse)').matches

function canonicalUrl() {
  const link = document.querySelector('link[rel="canonical"]')?.href
  // The list carries its filters in the query string, so share what is actually on screen.
  return link && !location.search ? link : location.href
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

let dialog

function build() {
  dialog = document.createElement('dialog')
  dialog.className = 'modal share-modal'
  dialog.id = 'share-modal'
  dialog.setAttribute('aria-labelledby', 'share-title')
  dialog.innerHTML = `
    <div class="modal-inner">
      <header class="modal-head">
        <h2 id="share-title">Share</h2>
        <button type="button" class="modal-close" id="share-close" aria-label="Close">&times;</button>
      </header>
      <div class="modal-body">
        <p class="share-what" id="share-what"></p>
        <div class="share-link">
          <input type="text" id="share-url" readonly aria-label="Link to copy">
          <button type="button" class="btn" id="share-copy">Copy</button>
        </div>
        <p class="share-status" id="share-status" role="status" aria-live="polite"></p>
        <div class="share-targets">
          <a class="share-target" id="share-fb" target="_blank" rel="noopener noreferrer">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 5.02 3.66 9.18 8.44 9.94v-7.03H7.9v-2.91h2.54V9.85c0-2.52 1.5-3.91 3.77-3.91 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.78-1.63 1.57v1.89h2.78l-.45 2.91h-2.33V22c4.78-.76 8.44-4.92 8.44-9.94Z"/></svg>
            <span>Facebook</span>
          </a>
          <a class="share-target" id="share-messenger">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 2C6.36 2 2 6.13 2 11.7c0 2.91 1.19 5.44 3.14 7.19.16.15.26.35.27.57l.05 1.78c.02.57.6.94 1.12.71l1.98-.87c.17-.07.36-.09.53-.04 1.06.29 2.2.45 3.41.45 5.64 0 10-4.13 10-9.79C22 6.13 17.64 2 12 2Zm6 7.46-2.94 4.66c-.47.74-1.47.93-2.18.41l-2.34-1.75a.6.6 0 0 0-.72 0l-3.16 2.4c-.42.32-.97-.18-.69-.63l2.94-4.66c.47-.74 1.47-.93 2.18-.41l2.34 1.75a.6.6 0 0 0 .72 0l3.16-2.4c.42-.32.97.18.69.63Z"/></svg>
            <span>Messenger</span>
          </a>
          <a class="share-target" id="share-x" target="_blank" rel="noopener noreferrer">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M17.53 3h3.05l-6.67 7.62L21.75 21h-6.14l-4.81-6.29L5.3 21H2.25l7.13-8.15L2.25 3H8.5l4.35 5.75L17.53 3Zm-1.07 16.17h1.69L7.62 4.74H5.8l10.66 14.43Z"/></svg>
            <span>X</span>
          </a>
          <a class="share-target" id="share-email">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><rect x="2.75" y="4.75" width="18.5" height="14.5" rx="2.25" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 6.5 12 12.5l8.5-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span>Email</span>
          </a>
        </div>
        <p class="share-follow">
          <a href="https://www.facebook.com/OutInSimcoe/" target="_blank" rel="noopener noreferrer">Follow Out in Simcoe on Facebook</a>
        </p>
      </div>
    </div>`
  document.body.appendChild(dialog)

  dialog.querySelector('#share-close').onclick = () => dialog.close()
  // A <dialog> does not dismiss on a backdrop click by itself.
  dialog.addEventListener('click', (ev) => {
    if (ev.target === dialog) dialog.close()
  })
  dialog.addEventListener('close', () => document.body.classList.remove('modal-open'))
  // A desktop opens the Send Dialog in a tab; the deep link hands off to the app instead,
  // and must not be given a target, or a blank tab is left behind after the app takes over.
  if (!onTouch()) {
    const messenger = dialog.querySelector('#share-messenger')
    messenger.target = '_blank'
    messenger.rel = 'noopener noreferrer'
  }
  dialog.querySelector('#share-copy').onclick = copy
  dialog.querySelector('#share-url').onclick = (ev) => ev.target.select()
}

async function copy() {
  const input = dialog.querySelector('#share-url')
  const status = dialog.querySelector('#share-status')
  try {
    await navigator.clipboard.writeText(input.value)
    status.textContent = 'Link copied.'
  } catch {
    // Clipboard access needs a secure context and can be refused outright; selecting the
    // text at least leaves the reader one keystroke from copying it themselves.
    input.select()
    status.textContent = 'Press ⌘C or Ctrl+C to copy.'
  }
  setTimeout(() => (status.textContent = ''), 2600)
}

function open(url, what) {
  if (!dialog) build()
  const text = what || TITLE

  dialog.querySelector('#share-what').textContent = text
  dialog.querySelector('#share-url').value = url
  dialog.querySelector('#share-status').textContent = ''
  dialog.querySelector('#share-fb').href =
    `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`
  dialog.querySelector('#share-messenger').href = onTouch()
    ? `fb-messenger://share?link=${encodeURIComponent(url)}`
    : `https://www.facebook.com/dialog/send?app_id=${FB_APP_ID}&link=${encodeURIComponent(url)}` +
      `&redirect_uri=${encodeURIComponent(canonicalOrigin() + '/')}`
  dialog.querySelector('#share-x').href =
    `https://x.com/intent/post?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`
  dialog.querySelector('#share-email').href =
    `mailto:?subject=${encodeURIComponent(text)}&body=${encodeURIComponent(`${text}\n\n${url}`)}`

  document.body.classList.add('modal-open')
  dialog.showModal()
  dialog.querySelector('#share-url').focus({ preventScroll: true })
}

document.addEventListener('click', (ev) => {
  const trigger = ev.target.closest('[data-share]')
  if (!trigger) return
  ev.preventDefault()
  open(trigger.dataset.shareUrl || canonicalUrl(), trigger.dataset.shareText || TITLE)
})
