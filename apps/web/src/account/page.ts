import { MUNICIPALITIES } from '@scec/core'
import { escapeHtml, formatDate, formatTime, localDateOf, titleCase } from '../html.ts'
import { UNPLACED } from '../query.ts'
import type { Pin, PinnedEvent, SavedFilter } from './store.ts'

/**
 * The account page's body: pins and saved views, each with its own remove form. Rendered
 * by routes.ts inside accountPage(), so it is no-store and noindex like the rest of
 * /account. Everything a reader typed (a view's label) and everything a source wrote (an
 * event's title) is escaped on the way out.
 */

const SITE_TZ = 'America/Toronto'

/** The last day an event runs, so a festival that started last week is still upcoming. */
const lastDay = (e: PinnedEvent): string => (e.endsAtUtc ? localDateOf(e.endsAtUtc, SITE_TZ) : e.localDate)

const whenLine = (e: PinnedEvent): string => {
  const untimed = e.allDay || e.timePrecision === 'date-only'
  const last = lastDay(e)
  const date = last > e.localDate ? `${formatDate(e.localDate)} to ${formatDate(last)}` : formatDate(e.localDate)
  return [date, untimed ? null : formatTime(e.localTime), e.municipalityName].filter(Boolean).join(' · ')
}

const removePin = (eventId: string, title: string) =>
  `<form method="post" action="/account/pins/remove" class="inline-form"><input type="hidden" name="event" value="${escapeHtml(eventId)}"><button class="linkish" type="submit" aria-label="Unpin ${escapeHtml(title)}">Unpin</button></form>`

const livePin = (e: PinnedEvent) => `<li>
  <a href="/e/${escapeHtml(e.shortCode)}">${escapeHtml(e.title)}</a>${e.status === 'cancelled' ? ' <span class="tag cancelled">Cancelled</span>' : ''}
  <span class="pin-when">${escapeHtml(whenLine(e))}</span>
  ${removePin(e.id, e.title)}
</li>`

/** A pin whose event is gone: say what it was, never a blank row (docs/user-accounts.md). */
const withdrawnPin = (p: Pin) => `<li class="withdrawn">
  <span class="pin-title">${escapeHtml(p.title)}</span>
  <span class="pin-when">Was ${escapeHtml(formatDate(p.localDate))}. No longer listed — its organizer took it down or moved it. <a href="/?from=${escapeHtml(p.localDate)}">See what else is on</a>.</span>
  ${removePin(p.eventId, p.title)}
</li>`

const placeLabel = (slug: string): string =>
  slug === UNPLACED ? 'Not specified' : MUNICIPALITIES.find((m) => m.slug === slug)?.shortName ?? slug

const COST_WORDS: Record<string, string> = { free: 'Free only', paid: 'Paid only', all: 'Free and paid' }

/** A saved view in words, so a reader can tell two apart without opening them. */
export function describeSaved(query: string): string {
  const p = new URLSearchParams(query)
  const list = (key: string) => (p.get(key) ?? '').split(',').filter(Boolean)
  const parts = [
    list('m').map(placeLabel).join(', ') || 'Everywhere',
    list('cat').map(titleCase).join(', ') || null,
    COST_WORDS[p.get('cost') ?? ''] ?? null,
    p.get('civic') === '1' ? 'with council meetings' : null,
    p.get('from') || p.get('to')
      ? [p.get('from') ? `from ${formatDate(p.get('from')!)}` : null, p.get('to') ? `to ${formatDate(p.get('to')!)}` : null].filter(Boolean).join(' ')
      : null,
  ]
  return parts.filter(Boolean).join(' · ')
}

/** A saved view is already a public feed: /calendar.ics reads the same query string. */
const savedRow = (f: SavedFilter, origin: string) => `<li>
  <a href="/${f.query ? `?${escapeHtml(f.query)}` : ''}">${escapeHtml(f.label)}</a>
  <span class="pin-when">${escapeHtml(describeSaved(f.query))} · <a href="${escapeHtml(webcal(`${origin}/calendar.ics${f.query ? `?${f.query}` : ''}`))}">Subscribe</a></span>
  <form method="post" action="/account/filters/remove" class="inline-form"><input type="hidden" name="id" value="${escapeHtml(f.id)}"><button class="linkish" type="submit" aria-label="Remove ${escapeHtml(f.label)}">Remove</button></form>
</li>`

export interface AccountView {
  email: string
  pins: Pin[]
  live: Map<string, PinnedEvent>
  filters: SavedFilter[]
  today: string
  origin: string
  /** The private feed's URL, or null when FEED_TOKEN_KEY is not configured. */
  feedUrl: string | null
  /** The shared calendar's URL, or null when sharing is off. */
  shareUrl: string | null
  /** Email digest settings, as stored (account/calendar.ts). */
  digest: { cadence: 'none' | 'daily' | 'weekly'; hour: number; day: number }
}

/** The hours a digest can go out, in Simcoe County time: early morning to evening. */
export const DIGEST_HOURS = Array.from({ length: 17 }, (_, i) => i + 5)
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const hourLabel = (h: number) => formatTime(`${String(h).padStart(2, '0')}:00`)

function digestSection(view: AccountView): string {
  const d = view.digest
  const option = (value: string | number, label: string, selected: boolean) =>
    `<option value="${value}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`
  const radio = (value: string, label: string) =>
    `<label class="radio"><input type="radio" name="digest" value="${value}"${d.cadence === value ? ' checked' : ''}> ${label}</label>`
  const state =
    d.cadence === 'none'
      ? 'Digests are off.'
      : d.cadence === 'daily'
        ? `A digest goes out every morning at about ${hourLabel(d.hour)}, when there is something in it.`
        : `A digest goes out every ${DAY_NAMES[d.day]} at about ${hourLabel(d.hour)}, covering the week ahead, when there is something in it.`
  return `<section class="account-section" id="digest" aria-labelledby="digest-h"><h2 id="digest-h">Email digest</h2>
<p class="account-empty">Your pinned events and saved views, by email. ${escapeHtml(state)} Every digest has a one-click unsubscribe link.</p>
<form method="post" action="/account/digest" class="digest-form">
<fieldset><legend>How often</legend>${radio('none', 'Never')}${radio('daily', 'Every day, for that day')}${radio('weekly', 'Once a week, for the week ahead')}</fieldset>
<div class="digest-when">
<label>At <select name="hour">${DIGEST_HOURS.map((h) => option(h, hourLabel(h), h === d.hour)).join('')}</select></label>
<label>Weekly on <select name="day">${DAY_NAMES.map((n, i) => option(i, n, i === d.day)).join('')}</select></label>
</div>
<div class="account-actions"><button class="btn" type="submit">Save</button></div>
</form>
<form method="post" action="/account/digest/preview" class="inline-form"><button class="linkish" type="submit">Email me a preview now</button></form>
</section>`
}

/** Calendar apps open webcal: links as "subscribe" rather than downloading a file. */
const webcal = (url: string): string => url.replace(/^https?:/, 'webcal:')

/** A link to copy: a read-only field, which selects cleanly on every device with no script. */
const copyField = (id: string, label: string, value: string) =>
  `<label class="copy-label" for="${id}">${label}</label><input class="copy-field" id="${id}" type="text" readonly value="${escapeHtml(value)}">`

function calendarSection(view: AccountView): string {
  const feed = view.feedUrl
    ? `<h3>Subscribe to your pins</h3>
<p class="account-empty">Add your pinned events to Google Calendar, Apple Calendar or Outlook. The calendar updates on its own as you pin and unpin.</p>
${copyField('feed-url', 'Your private feed', view.feedUrl)}
<div class="account-actions"><a class="btn" href="${escapeHtml(webcal(view.feedUrl))}">Subscribe in your calendar</a>
<form method="post" action="/account/calendar/rotate" class="inline-form"><button class="btn ghost" type="submit">Make a new link</button></form></div>
<p class="field-hint">Keep this link to yourself: anyone who has it can see your pinned events. If it gets out, make a new one and the old link stops working.</p>`
    : '<h3>Subscribe to your pins</h3><p class="account-empty">Calendar feeds are not available right now.</p>'
  const share = view.shareUrl
    ? `<h3>Share your pins</h3>
${copyField('share-url', 'Your share link', view.shareUrl)}
<div class="account-actions"><a class="btn ghost" href="${escapeHtml(view.shareUrl)}">Open it</a>
<form method="post" action="/account/calendar/share" class="inline-form"><input type="hidden" name="on" value="0"><button class="btn ghost" type="submit">Stop sharing</button></form></div>
<p class="field-hint">Anyone with this link sees your upcoming pinned events, and can subscribe to them. It never shows your name or email address, and search engines are told to ignore it. Stopping kills the link; sharing again makes a new one.</p>`
    : `<h3>Share your pins</h3>
<p class="account-empty">Make a link that shows your upcoming pinned events to anyone you send it to. It never shows your name or email address.</p>
<form method="post" action="/account/calendar/share"><input type="hidden" name="on" value="1"><button class="btn ghost" type="submit">Create a share link</button></form>`
  return `<section class="account-section" id="calendar" aria-labelledby="calendar-h"><h2 id="calendar-h">Your calendar</h2>
${feed}
${share}
</section>`
}

export function accountHome(view: AccountView): string {
  const upcoming: PinnedEvent[] = []
  const past: string[] = []
  const withdrawn: Pin[] = []
  for (const p of view.pins) {
    const e = view.live.get(p.eventId)
    if (e) {
      if (lastDay(e) >= view.today) upcoming.push(e)
      else past.push(livePin(e))
    } else if (p.localDate >= view.today) withdrawn.push(p)
    else past.push(withdrawnPin(p))
  }
  upcoming.sort((a, b) => a.localDate.localeCompare(b.localDate) || a.localTime.localeCompare(b.localTime))

  const pinsHtml = view.pins.length === 0
    ? '<p class="account-empty">Nothing pinned yet. Tap the pin beside any event’s title, in the list or on its own page, and it will be kept here.</p>'
    : `${upcoming.length ? `<ul class="pin-list">${upcoming.map(livePin).join('')}</ul>` : '<p class="account-empty">Nothing coming up.</p>'}
${withdrawn.length ? `<h3>No longer listed</h3><ul class="pin-list">${withdrawn.map(withdrawnPin).join('')}</ul>` : ''}
${past.length ? `<details class="pin-past"><summary>Past (${past.length})</summary><ul class="pin-list">${past.join('')}</ul></details>` : ''}`

  const filtersHtml = view.filters.length === 0
    ? '<p class="account-empty">No saved views yet. Filter the calendar the way you like it, open Subscribe, and save the view there.</p>'
    : `<ul class="pin-list">${view.filters.map((f) => savedRow(f, view.origin)).join('')}</ul>`

  return `<p class="lead">Signed in as <strong>${escapeHtml(view.email)}</strong>.</p>
<section class="account-section" aria-labelledby="pins-h"><h2 id="pins-h">Pinned events</h2>
${pinsHtml}
</section>
${calendarSection(view)}
${digestSection(view)}
<section class="account-section" aria-labelledby="views-h"><h2 id="views-h">Saved views</h2>
${filtersHtml}
</section>
<form method="post" action="/account/signout" class="account-signout"><button class="btn ghost" type="submit">Sign out</button></form>`
}
