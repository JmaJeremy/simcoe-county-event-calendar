import { MARK, SITE_NAME, WIP_TAG, escapeHtml, renderHead } from '../html.ts'

/**
 * The account pages: plain server-rendered forms in the console's shape — POST, 303 on
 * success, no client framework. Every page is noindex and no-store (set by the caller in
 * routes.ts), and the only scripts are Turnstile's, on the two pages that carry a widget.
 *
 * The Turnstile site key is public and appears in public/suggest.js too; the widget
 * ("outinsimcoe.ca suggestion form") allows the apex, localhost and workers.dev.
 * TURNSTILE_PAGES marks which forms carry it: sign-up and reset-request, where abuse is
 * free — and deliberately NOT sign-in, which must keep working with JavaScript off; the
 * rate limiter covers credential stuffing. See docs/user-accounts.md.
 */
const TURNSTILE_SITE_KEY = '0x4AAAAAAE0QZZaEVJGV6HhE'
/** The widget action for every account form, checked back from siteverify in routes.ts. */
export const ACCOUNT_TURNSTILE_ACTION = 'account'

const turnstileWidget = `<div class="turnstile-widget"><div class="cf-turnstile" data-sitekey="${TURNSTILE_SITE_KEY}" data-action="${ACCOUNT_TURNSTILE_ACTION}"></div></div>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`

interface PageOptions {
  title: string
  heading: string
  origin: string
  /** One-line status above the form: "Signed out.", an error, a "check your inbox". */
  notice?: string
  /** True renders the notice in the error style. */
  isError?: boolean
  body: string
}

export function accountPage(options: PageOptions): string {
  const notice = options.notice
    ? `<p class="${options.isError ? 'form-error' : 'lead'}" role="status">${escapeHtml(options.notice)}</p>`
    : ''
  return `<!doctype html><html lang="en-CA"><head>
${renderHead(
  { title: `${options.title} — ${SITE_NAME}`, description: 'Your Out in Simcoe account.', canonical: `${options.origin}/account`, noindex: true },
  options.origin,
)}
</head><body class="event-page account-page">
<header class="topbar"><a href="/" class="home">${MARK}<span>&larr; All events</span></a>${WIP_TAG}</header>
<main class="card">
  <h1>${escapeHtml(options.heading)}</h1>
  ${notice}
  ${options.body}
</main>
</body></html>`
}

// The suggest form's field styles, reused: .form-field, .form-error and .turnstile-widget
// all live in style.css already.
const emailField = (value = '') =>
  `<div class="form-field"><label for="email">Email</label>
<input type="email" id="email" name="email" required maxlength="254" autocomplete="email" value="${escapeHtml(value)}"></div>`

const passwordField = (label: string, autocomplete: 'current-password' | 'new-password') =>
  `<div class="form-field"><label for="password">${label}</label>
<input type="password" id="password" name="password" required minlength="8" maxlength="200" autocomplete="${autocomplete}"></div>`

const googleImage = (theme: 'light' | 'dark') =>
  `<img class="google-${theme}" src="/google/signin-${theme}.png" srcset="/google/signin-${theme}@2x.png 2x, /google/signin-${theme}@3x.png 3x" width="180" height="40" alt="Sign in with Google" loading="lazy">`

/**
 * A plain link, not a POST: the start route only mints a signed cookie and redirects.
 * The button is Google's own artwork from its branding pack (public/google/), served
 * from here rather than drawn by Google's script, which would bring its own sign-in
 * flow and a third party onto the page. Both themes ship; CSS shows the one that
 * matches the reader's, and `loading="lazy"` keeps the hidden one from downloading.
 */
const googleButton = `<p class="account-google"><a href="/account/google/start">${googleImage('light')}${googleImage('dark')}</a></p>`

export const signInForm = (email = '', google = false): string => `<form method="post" action="/account/signin" class="account-form">
${emailField(email)}
${passwordField('Password', 'current-password')}
<button class="btn" type="submit">Sign in</button>
</form>
${google ? googleButton : ''}
<p class="account-links"><a href="/account/signup">Create an account</a> · <a href="/account/reset">Forgot your password?</a></p>`

export const signUpForm = (email = '', google = false): string => `<form method="post" action="/account/signup" class="account-form">
${emailField(email)}
${passwordField('Choose a password (at least 8 characters)', 'new-password')}
${turnstileWidget}
<button class="btn" type="submit">Create account</button>
</form>
${google ? googleButton : ''}
<p class="account-links">Already have one? <a href="/account/signin">Sign in</a></p>`

export const resetRequestForm = (email = ''): string => `<form method="post" action="/account/reset" class="account-form">
${emailField(email)}
${turnstileWidget}
<button class="btn" type="submit">Send a reset link</button>
</form>
<p class="account-links"><a href="/account/signin">Back to sign in</a></p>`

export const resetConfirmForm = (token: string): string => `<form method="post" action="/account/reset/confirm" class="account-form">
<input type="hidden" name="token" value="${escapeHtml(token)}">
${passwordField('New password (at least 8 characters)', 'new-password')}
<button class="btn" type="submit">Set the new password</button>
</form>`

/** The minimal signed-in page; the real account page arrives with SCEC-106. */
export const accountBody = (email: string, verified: boolean): string => `<p class="lead">Signed in as <strong>${escapeHtml(email)}</strong>${verified ? '' : ' (email not yet verified)'}.</p>
<form method="post" action="/account/signout"><button class="btn" type="submit">Sign out</button></form>`
