/**
 * The suggestion form. It works as a plain form post without this script; this adds
 * the fields that follow the kind of suggestion, and sends without leaving the page.
 */

const $ = (id) => document.getElementById(id)
const form = $('suggest-form')
const error = $('form-error')
const submit = $('submit')

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

// Arriving from a script-free post, which the worker redirects here.
if (new URLSearchParams(location.search).get('sent') === '1') showSent(true)

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  showError('')
  submit.disabled = true
  submit.textContent = 'Sending…'
  try {
    const body = new URLSearchParams(new FormData(form))
    // Fields hidden for this kind are not part of the suggestion.
    for (const el of form.querySelectorAll('[data-kind][hidden] [name]')) body.delete(el.name)
    const response = await fetch(form.action, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body,
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok || !result.ok) {
      showError(result.error || 'Something went wrong sending that. Please try again in a moment.')
      return
    }
    form.reset()
    applyKind()
    showSent(true)
  } catch {
    showError("Couldn't reach the site. Check your connection and try again.")
  } finally {
    submit.disabled = false
    submit.textContent = 'Send suggestion'
  }
})

$('another').addEventListener('click', () => {
  history.replaceState(null, '', location.pathname)
  showSent(false)
  $('s-title').focus()
})
