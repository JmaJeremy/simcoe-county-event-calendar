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

const savedRow = (f: SavedFilter) => `<li>
  <a href="/${f.query ? `?${escapeHtml(f.query)}` : ''}">${escapeHtml(f.label)}</a>
  <span class="pin-when">${escapeHtml(describeSaved(f.query))}</span>
  <form method="post" action="/account/filters/remove" class="inline-form"><input type="hidden" name="id" value="${escapeHtml(f.id)}"><button class="linkish" type="submit" aria-label="Remove ${escapeHtml(f.label)}">Remove</button></form>
</li>`

export interface AccountView {
  email: string
  pins: Pin[]
  live: Map<string, PinnedEvent>
  filters: SavedFilter[]
  today: string
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
    ? '<p class="account-empty">Nothing pinned yet. Use the Pin button on any event, in the list or on its own page, and it will be kept here.</p>'
    : `${upcoming.length ? `<ul class="pin-list">${upcoming.map(livePin).join('')}</ul>` : '<p class="account-empty">Nothing coming up.</p>'}
${withdrawn.length ? `<h3>No longer listed</h3><ul class="pin-list">${withdrawn.map(withdrawnPin).join('')}</ul>` : ''}
${past.length ? `<details class="pin-past"><summary>Past (${past.length})</summary><ul class="pin-list">${past.join('')}</ul></details>` : ''}`

  const filtersHtml = view.filters.length === 0
    ? '<p class="account-empty">No saved views yet. Filter the calendar the way you like it, open Subscribe, and save the view there.</p>'
    : `<ul class="pin-list">${view.filters.map(savedRow).join('')}</ul>`

  return `<p class="lead">Signed in as <strong>${escapeHtml(view.email)}</strong>.</p>
<section class="account-section" aria-labelledby="pins-h"><h2 id="pins-h">Pinned events</h2>
${pinsHtml}
</section>
<section class="account-section" aria-labelledby="views-h"><h2 id="views-h">Saved views</h2>
${filtersHtml}
</section>
<form method="post" action="/account/signout" class="account-signout"><button class="btn ghost" type="submit">Sign out</button></form>`
}
