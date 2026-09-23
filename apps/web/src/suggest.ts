/**
 * The "Are we missing something?" form: what a submission may contain, and the two
 * emails it produces.
 *
 * Kept free of Worker bindings so all of it runs under vitest. Everything here arrives
 * from a stranger's browser — or from a bot pretending to be one — so every field is
 * capped, the link must really be a web address, and nothing a visitor typed is ever
 * placed in a mail header where a line break could forge another one.
 */

export type SuggestionKind = 'event' | 'website'

export interface Suggestion {
  kind: SuggestionKind
  name: string | null
  email: string | null
  title: string | null
  url: string | null
  date: string | null
  time: string | null
  description: string | null
  comments: string | null
}

export type Validation =
  | { ok: true; suggestion: Suggestion }
  | { ok: false; error: string }
  /** A bot filled the hidden field. Answered as a success so it learns nothing. */
  | { ok: 'spam' }

/** The hidden field. A person never sees it; a form-filling bot fills everything. */
export const HONEYPOT = 'company'

const LIMITS = { name: 100, email: 254, title: 200, url: 2000, description: 5000, comments: 5000 } as const

/** Deliberately plain: one @, no spaces, a dot in the domain. Browsers check the rest. */
const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

const text = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/\r\n?/g, '\n').trim()
  return trimmed ? trimmed.slice(0, max) : null
}

/**
 * @param options.hasPoster An image came with it. A poster says what the event is on its
 *   own, so it counts as content for the "not all empty" rule.
 */
export function validateSuggestion(form: Record<string, unknown>, options: { hasPoster?: boolean } = {}): Validation {
  if (text(form[HONEYPOT], 200)) return { ok: 'spam' }

  const kind: SuggestionKind = form.kind === 'website' ? 'website' : 'event'
  const email = text(form.email, LIMITS.email)
  if (email && !EMAIL.test(email)) {
    return { ok: false, error: "That email address doesn't look right. Leave it blank if you'd rather not say." }
  }

  const rawUrl = text(form.url, LIMITS.url)
  let url: string | null = null
  if (rawUrl) {
    // Forgive a missing scheme — "barrieconcerts.org" is what people paste.
    const candidate = /^[a-z][a-z\d+.-]*:/i.test(rawUrl) ? rawUrl : `https://${rawUrl}`
    const parsed = URL.parse(candidate)
    if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !parsed.hostname.includes('.')) {
      return { ok: false, error: "That link doesn't look like a web address." }
    }
    url = parsed.toString()
  }

  // Only meaningful for a single event; a website's dates are the site's business.
  const date = kind === 'event' ? text(form.date, 10) : null
  const time = kind === 'event' ? text(form.time, 5) : null

  const suggestion: Suggestion = {
    kind,
    name: text(form.name, LIMITS.name),
    email,
    title: text(form.title, LIMITS.title),
    url,
    date: date && DATE.test(date) ? date : null,
    time: time && TIME.test(time) ? time : null,
    description: kind === 'event' ? text(form.description, LIMITS.description) : null,
    comments: text(form.comments, LIMITS.comments),
  }

  // Every field is optional, but not all of them at once: a name and an email alone
  // suggest nothing.
  const poster = kind === 'event' && options.hasPoster === true
  if (!suggestion.title && !suggestion.url && !suggestion.description && !suggestion.comments && !poster) {
    return {
      ok: false,
      error:
        kind === 'website'
          ? 'Add the website’s address, or a note about it, so we know what to look at.'
          : 'Add at least a title, a link or a few words about the event, so we know what to look for.',
    }
  }
  return { ok: true, suggestion }
}

export interface Mail {
  subject: string
  text: string
}

/** Visitor text headed for a Subject line: one line, and short. */
const oneLine = (value: string, max: number): string => {
  const flat = value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const KIND_LABEL: Record<SuggestionKind, string> = { event: 'Event', website: 'Website' }

function details(s: Suggestion): string {
  const rows: Array<[string, string | null]> = [
    ['Type', s.kind === 'event' ? 'A single event' : 'A website that lists events'],
    ['Title', s.title],
    ['Link', s.url],
    ['Date', s.date],
    ['Time', s.time],
    ['Description', s.description],
    ['Comments', s.comments],
  ]
  return rows
    .filter(([, value]) => value)
    .map(([label, value]) => (value!.includes('\n') ? `${label}:\n${value}` : `${label}: ${value}`))
    .join('\n\n')
}

export interface AdminMailMeta {
  id: string
  receivedAt: string
  /** The suggestion's page in the console, where it can be turned into an event. */
  reviewUrl?: string | null
  /** Where the uploaded poster can be opened — the console, behind Access. */
  posterUrl?: string | null
  /** Why a poster that was sent could not be kept. */
  posterProblem?: string | null
}

/** To the site's inbox. Reply-To is set to the suggester separately, when they gave one. */
export function adminMail(s: Suggestion, meta: AdminMailMeta): Mail {
  const about = s.title ?? s.url ?? 'no title given'
  const from = [s.name, s.email ? `<${s.email}>` : null].filter(Boolean).join(' ') || 'Anonymous (no name or email given)'
  return {
    subject: `Suggestion (${KIND_LABEL[s.kind].toLowerCase()}): ${oneLine(about, 90)}`,
    text: [
      `A new suggestion came in through outinsimcoe.ca.`,
      `From: ${from}`,
      details(s),
      ...(meta.posterUrl ? [`Poster (opens after signing in to the console):\n${meta.posterUrl}`] : []),
      ...(meta.posterProblem ? [`Poster: one was attached but could not be kept (${meta.posterProblem}).`] : []),
      ...(meta.reviewUrl ? [`Review it, or turn it into an event:\n${meta.reviewUrl}`] : []),
      `—\nReceived ${meta.receivedAt} · suggestion ${meta.id}` +
        (s.email ? `\nReplying to this email goes to the person who sent it.` : ''),
    ].join('\n\n'),
  }
}

/**
 * To the suggester, only when they left an address. Reply-To is the site's inbox.
 *
 * Nothing the visitor typed appears in it — not the event, not even their name. Anyone
 * can put anyone's address in the form, so a thank-you that echoed the submission would
 * let a stranger send their own words to a third party from outinsimcoe.ca. A fixed
 * message is useless to them; the real suggester already knows what they sent.
 */
export function thanksMail(s: Suggestion): Mail {
  const what = s.kind === 'website' ? 'the website you suggested' : 'the event you suggested'
  return {
    subject: 'Thanks for your suggestion — Out in Simcoe',
    text: [
      'Hi,',
      `Thanks for telling us about ${what}. Out in Simcoe is still growing, and suggestions like yours are how it finds the events the town calendars miss.`,
      "We read every one. If it fits — a public event in Simcoe County, or a site that lists them — we'll add it. This is a small hobby project, so it may take a little while.",
      'If you want to add anything, just reply to this email.',
      "If you didn't send a suggestion, someone typed your address into our form by mistake. You can ignore this; we won't write again.",
      '— Out in Simcoe\nhttps://outinsimcoe.ca',
    ].join('\n\n'),
  }
}

/*
 * Cloudflare Turnstile: proof the form was filled in by a person in a browser.
 *
 * The honeypot and the hourly limit only stop lazy bots, and this form sends mail from
 * outinsimcoe.ca — to an address the visitor types — which makes it worth a determined
 * one's time. Every token is checked here, server-side, before anything is stored.
 */

/** Set on the widget in public/suggest.js and required back from siteverify. */
export const TURNSTILE_ACTION = 'suggest'
/** The field the widget adds to the form. */
export const TURNSTILE_FIELD = 'cf-turnstile-response'
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
/** Cloudflare's own ceiling; anything longer is not a token. */
const MAX_TOKEN = 2048

export type TurnstileResult =
  | { ok: true }
  /** `codes` are Cloudflare's error codes, or ours in the same style, for the log. */
  | { ok: false; status: number; error: string; codes: string[] }

type FetchLike = (input: string, init: { method: string; body: URLSearchParams }) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>

const TRY_AGAIN = 'The check that keeps bots out did not pass. Please try sending again.'

export async function verifyTurnstile(
  token: unknown,
  options: { secret: string; remoteip?: string | null; hostname: string; action?: string },
  fetchImpl: FetchLike = fetch,
): Promise<TurnstileResult> {
  if (typeof token !== 'string' || !token) {
    return {
      ok: false,
      status: 400,
      error: 'Please wait for the check above the Send button to finish, then send again.',
      codes: ['missing-input-response'],
    }
  }
  if (token.length > MAX_TOKEN) return { ok: false, status: 400, error: TRY_AGAIN, codes: ['invalid-input-response'] }

  const body = new URLSearchParams({ secret: options.secret, response: token })
  if (options.remoteip) body.set('remoteip', options.remoteip)

  let outcome: { success?: boolean; action?: string; hostname?: string; 'error-codes'?: string[] }
  try {
    const response = await fetchImpl(SITEVERIFY, { method: 'POST', body })
    if (!response.ok) throw new Error(`siteverify answered ${response.status}`)
    outcome = (await response.json()) as typeof outcome
  } catch {
    // Cloudflare unreachable. Refuse rather than wave the submission through: an outage
    // is exactly when nobody would notice the form had quietly stopped checking.
    return {
      ok: false,
      status: 503,
      error: "We couldn't check the form just now. Please try again in a minute.",
      codes: ['siteverify-unreachable'],
    }
  }

  if (!outcome.success) {
    const codes = outcome['error-codes'] ?? []
    const expired = codes.includes('timeout-or-duplicate')
    return {
      ok: false,
      status: 403,
      error: expired ? 'That check expired while the form was open. Please send again.' : TRY_AGAIN,
      codes,
    }
  }
  // A token is only proof for the widget and page it was issued on. Without these, one
  // solved on another site sharing the key — or for another action — would do here too.
  if (outcome.action !== (options.action ?? TURNSTILE_ACTION)) return { ok: false, status: 403, error: TRY_AGAIN, codes: ['action-mismatch'] }
  if (outcome.hostname !== options.hostname) return { ok: false, status: 403, error: TRY_AGAIN, codes: ['hostname-mismatch'] }
  return { ok: true }
}

