import { sourceBySlug, type Municipality } from '@scec/core'
import type { PublicEvent } from './query.ts'
import {
  COPYRIGHT,
  MARK,
  REGION_ADDRESS,
  SITE_NAME,
  WIP_TAG,
  escapeHtml,
  formatDate,
  formatTime,
  localDateOf,
  localTimeOf,
  renderHead,
  titleCase,
} from './html.ts'

const COST_LABEL: Record<string, string> = { free: 'Free', paid: 'Paid', unknown: 'Cost not listed' }

const SCHEMA_STATUS: Record<string, string> = {
  scheduled: 'https://schema.org/EventScheduled',
  cancelled: 'https://schema.org/EventCancelled',
  rescheduled: 'https://schema.org/EventRescheduled',
}

export const eventUrl = (origin: string, event: { shortCode: string }): string =>
  `${origin}/e/${event.shortCode}`
export const placeUrl = (origin: string, slug: string): string => `${origin}/place/${slug}`

/**
 * Whether a source's own image can be used as the share card.
 *
 * govStack calendars sit behind a WAF that answers 403 to anything that does not look
 * like a browser, share crawlers included: the poster renders perfectly for a visitor and
 * not at all for Facebook or Slack, which would turn every share of those events into a
 * broken image. They keep the poster on the page and the site's own card in the preview.
 */
export const shareableImage = (event: PublicEvent): string | null => {
  if (!event.imageUrl) return null
  const host = URL.parse?.(event.imageUrl)?.hostname ?? ''
  return /^(calendar|events)\./i.test(host) ? null : event.imageUrl
}

/** One phrase for when an event is, honest about sources that publish no time. */
export function describeWhen(event: PublicEvent): string {
  return event.allDay || event.timePrecision === 'date-only'
    ? `${formatDate(event.localDate)}${event.endsAtUtc ? ` to ${formatDate(localDateOf(event.endsAtUtc, event.timezone))}` : ''} · all day`
    : `${formatDate(event.localDate)} at ${formatTime(event.localTime)}${event.endsAtUtc ? ` to ${formatTime(localTimeOf(event.endsAtUtc, event.timezone))}` : ''}`
}

/** The machine-readable half of a `<time>`: a date alone when that is all we know. */
const isoAttr = (event: PublicEvent): string =>
  event.allDay || event.timePrecision === 'date-only' ? event.localDate : event.startsAtUtc

/**
 * Breadcrumbs, both as markup and as structured data.
 *
 * They exist for the crawler as much as the reader: an event page reached from a shared
 * link is otherwise a dead end, and `/e/{code}` is opaque enough that nothing about the
 * URL says which town it belongs to.
 */
function breadcrumbs(trail: { name: string; url: string }[]): { html: string; jsonLd: unknown } {
  const html = `<nav class="crumbs" aria-label="Breadcrumb"><ol>${trail
    .map((step, i) =>
      i === trail.length - 1
        ? `<li aria-current="page">${escapeHtml(step.name)}</li>`
        : `<li><a href="${escapeHtml(step.url)}">${escapeHtml(step.name)}</a></li>`,
    )
    .join('')}</ol></nav>`
  return {
    html,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: trail.map((step, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: step.name,
        item: step.url,
      })),
    },
  }
}

/**
 * Structured data for one event, so a shared link can surface as a rich result rather
 * than a bare URL. Every property Google requires is emitted, which notably includes a
 * `location` carrying an `address` — a venue name on its own is not one, and an event
 * with neither still has the town it is in.
 */
function eventJsonLd(event: PublicEvent, canonical: string): unknown {
  const dateOnly = event.allDay || event.timePrecision === 'date-only'
  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: event.title,
    startDate: dateOnly ? event.localDate : event.startsAtUtc,
    eventStatus: SCHEMA_STATUS[event.status] ?? SCHEMA_STATUS.scheduled,
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    url: canonical,
  }
  // Said only when a source said it. "Cost not listed" is most events here, and `false`
  // for those would tell search engines every one of them charges admission.
  if (event.cost !== 'unknown') data.isAccessibleForFree = event.cost === 'free'
  // The same precision at both ends: an all-day span's end is stored as 23:59 on its last
  // day, and as a UTC instant that reads as the following morning.
  if (event.endsAtUtc) data.endDate = dateOnly ? localDateOf(event.endsAtUtc, event.timezone) : event.endsAtUtc
  if (event.description) data.description = event.description.slice(0, 500)
  if (event.imageUrl) data.image = event.imageUrl
  if (event.organizer) data.organizer = { '@type': 'Organization', name: event.organizer }
  data.location = {
    '@type': 'Place',
    name: event.venueName ?? event.address ?? event.municipalityName ?? 'Simcoe County',
    address: {
      '@type': 'PostalAddress',
      ...(event.address ? { streetAddress: event.address } : {}),
      ...(event.municipalityName ? { addressLocality: event.municipalityName } : {}),
      ...REGION_ADDRESS,
    },
  }
  return data
}

export function renderEventPage(event: PublicEvent, origin: string, backHref = '/'): string {
  const when = describeWhen(event)
  const place = [event.venueName, event.address].filter((v): v is string => !!v).join(', ')
  const cost = event.cost === 'free' ? 'Free' : event.costText ?? COST_LABEL[event.cost] ?? ''
  // A share preview is often all someone sees: the event, when, and where.
  const title = event.municipalityName ? `${event.title} — ${event.municipalityName}` : event.title
  const prefix = event.status === 'cancelled' ? 'CANCELLED · ' : event.status === 'rescheduled' ? 'RESCHEDULED · ' : ''
  const description = `${prefix}${[when, place || event.municipalityName, cost].filter(Boolean).join(' · ')}`
  const canonical = eventUrl(origin, event)

  const crumbs = breadcrumbs([
    { name: SITE_NAME, url: `${origin}/` },
    ...(event.municipalitySlug && event.municipalityName
      ? [{ name: event.municipalityName, url: placeUrl(origin, event.municipalitySlug) }]
      : []),
    { name: event.title, url: canonical },
  ])

  const listedOn = event.sourceSlugs.map((slug) => sourceBySlug(slug)?.name ?? slug)
  // The listing lives on someone else's site: open it in a new tab so this page, and
  // whatever the reader was scrolling through to reach it, stays where it was.
  const links: string[] = [
    `<a class="btn" href="${escapeHtml(event.url)}" target="_blank" rel="noopener noreferrer">View the listing <span class="ext" aria-hidden="true">&#8599;</span></a>`,
    `<button class="btn ghost" type="button" data-share aria-haspopup="dialog"
       data-share-url="${escapeHtml(canonical)}"
       data-share-text="${escapeHtml(`${event.title} · ${when}`)}">Share</button>`,
  ]

  const notices: string[] = []
  if (event.status === 'cancelled') notices.push('<p class="notice cancelled">This event has been cancelled.</p>')
  if (event.status === 'rescheduled') notices.push('<p class="notice moved">This event has been rescheduled — check the listing for the new time.</p>')
  if (event.category === 'civic-meeting') {
    notices.push('<p class="notice">This is a council or committee meeting. Agendas and minutes are on <a href="https://civi-times.ca">Civi-Times</a>.</p>')
  }

  const feed = event.municipalitySlug
    ? `${origin}/calendar.ics?m=${encodeURIComponent(event.municipalitySlug)}`
    : undefined

  return `<!doctype html><html lang="en-CA"><head>
${renderHead(
  {
    title,
    description,
    canonical,
    image: shareableImage(event) ?? undefined,
    twitterCard: shareableImage(event) ? 'summary' : 'summary_large_image',
    ...(feed ? { feed } : {}),
    jsonLd: [eventJsonLd(event, canonical), crumbs.jsonLd],
    extraHead: '<script type="module" src="/share.js"></script>',
  },
  origin,
)}
</head><body class="event-page">
<header class="topbar"><a href="${escapeHtml(backHref)}" class="home">${MARK}<span>&larr; All events</span></a>${WIP_TAG}</header>
<main class="card" data-cat="${escapeHtml(event.category)}">
  ${crumbs.html}
  <p class="eyebrow">${escapeHtml(event.municipalityName ?? 'Simcoe County')} · ${escapeHtml(titleCase(event.category))}</p>
  <h1>${escapeHtml(event.title)}</h1>
  <p class="when"><time datetime="${escapeHtml(isoAttr(event))}">${escapeHtml(when)}</time></p>
  ${place ? `<p class="where">${escapeHtml(place)}</p>` : ''}
  <p class="cost ${escapeHtml(event.cost)}">${escapeHtml(cost)}</p>
  ${notices.join('')}
  ${event.imageUrl ? `<img class="hero" src="${escapeHtml(event.imageUrl)}" alt="">` : ''}
  ${event.description ? `<div class="description">${escapeHtml(event.description).replace(/\n+/g, '<br>')}</div>` : ''}
  ${event.organizer ? `<p class="organizer">Organized by ${escapeHtml(event.organizer)}</p>` : ''}
  <div class="actions">${links.join('')}</div>
  <p class="listed">Listed on ${listedOn.map((n) => escapeHtml(n)).join(', ')}. Details come from those sites; confirm with the organizer before you go.</p>
  ${
    event.municipalitySlug && feed
      ? `<p class="subscribe"><a href="${escapeHtml(feed)}">Subscribe to ${escapeHtml(event.municipalityName ?? '')} events</a>
         · <a href="/place/${escapeHtml(event.municipalitySlug)}">Everything on in ${escapeHtml(event.municipalityName ?? '')}</a></p>`
      : ''
  }
</main>
<footer class="page-foot"><p class="copyright">${COPYRIGHT}</p></footer>
</body></html>`
}

/* --------------------------------------------------------------- municipality pages */

/**
 * One indexable page per municipality.
 *
 * The home page is a filterable app: every view of it is a query string, and it renders
 * from JSON after the fact. That is right for someone using the site and useless for
 * someone searching "things to do in Collingwood", because there is no page whose subject
 * is Collingwood. These are that page — and they are also the only crawlable path to the
 * `/e/{code}` permalinks, which are otherwise reachable only from a shared link.
 *
 * Unlike the list, these show paid events alongside free ones. The list defaults to
 * hiding paid because most readers want the free things; a page answering "what is on in
 * this town" that silently omitted every ticketed concert would be answering a different
 * question. Civic meetings stay out — those are civi-times' job, as everywhere else here.
 */
export function renderPlacePage(
  place: Municipality,
  upcoming: PublicEvent[],
  past: PublicEvent[],
  others: Municipality[],
  origin: string,
  /** Every upcoming event, not just the ones listed; the list is capped. */
  upcomingTotal = upcoming.length,
): string {
  const heading = `Things to do in ${place.shortName}`
  const next = upcoming[0]
  const total = Math.max(upcomingTotal, upcoming.length)
  const description = next
    ? `${total} upcoming ${total === 1 ? 'event' : 'events'} in ${place.shortName}, Ontario — next is ${next.title} on ${formatDate(next.localDate)}. Fairs, markets, concerts and family days, gathered from every local calendar with duplicates removed.`
    : `Community events in ${place.shortName}, Ontario — fairs, markets, concerts and family days, gathered from every local calendar with duplicates removed, and a feed you can subscribe to.`

  const canonical = placeUrl(origin, place.slug)
  const feed = `${origin}/calendar.ics?m=${encodeURIComponent(place.slug)}`
  const crumbs = breadcrumbs([
    { name: SITE_NAME, url: `${origin}/` },
    { name: place.name, url: canonical },
  ])

  const listJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: heading,
    numberOfItems: upcoming.length,
    itemListElement: upcoming.slice(0, 50).map((event, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: event.title,
      url: eventUrl(origin, event),
    })),
  }

  const more =
    total > upcoming.length
      ? `<p class="more-note">Showing the next ${upcoming.length} of ${total}.
         <a href="/?m=${encodeURIComponent(place.slug)}&amp;cost=all">See all ${total} on the calendar</a>.</p>`
      : ''
  const body = upcoming.length
    ? `<ol class="events">${upcoming.map(eventRow).join('')}</ol>${more}`
    : `<p class="empty">Nothing is listed in ${escapeHtml(place.shortName)} just yet. Organisers usually post a few
       weeks ahead, so check back — or subscribe below and events will appear in your calendar as they are
       published. If you know of something, <a href="/suggest">suggest an event</a>.</p>`

  return `<!doctype html><html lang="en-CA"><head>
${renderHead(
  {
    title: `${heading} — ${SITE_NAME}`,
    description,
    canonical,
    feed,
    jsonLd: [crumbs.jsonLd, listJsonLd],
  },
  origin,
)}
</head><body class="event-page place-page">
<header class="topbar"><a href="/" class="home">${MARK}<span>&larr; All events</span></a>${WIP_TAG}</header>
<main class="card">
  ${crumbs.html}
  <p class="eyebrow">${escapeHtml(place.level === 'county' ? 'Upper tier' : titleCase(place.level))} · Simcoe County, Ontario</p>
  <h1>${escapeHtml(heading)}</h1>
  <p class="lead">${escapeHtml(
    upcoming.length
      ? `${total} upcoming ${total === 1 ? 'event' : 'events'} in ${place.name}, gathered from every calendar that lists them and de-duplicated, so each one appears once.`
      : `Community events in ${place.name}, gathered from every calendar that lists them and de-duplicated, so each one appears once.`,
  )}</p>

  <h2>What's on</h2>
  ${body}

  ${past.length ? `<h2>Recently listed</h2><ol class="events past">${past.map(eventRow).join('')}</ol>` : ''}

  <p class="subscribe"><a href="${escapeHtml(feed)}">Subscribe to ${escapeHtml(place.name)} events</a>
     in Google Calendar, Apple Calendar or Outlook · <a href="/suggest">Suggest an event</a></p>

  <nav class="other-places" aria-label="Other municipalities">
    <h2>Elsewhere in Simcoe County</h2>
    <ul>${others
      .map((m) => `<li><a href="/place/${escapeHtml(m.slug)}">${escapeHtml(m.shortName)}</a></li>`)
      .join('')}</ul>
  </nav>
</main>
<footer class="page-foot"><p class="copyright">${COPYRIGHT}</p></footer>
</body></html>`
}

function eventRow(event: PublicEvent): string {
  /*
   * Cost is flagged both ways, never left blank. Labelling only the free ones would leave
   * a reader unable to tell a ticketed concert from one nobody has priced — and the price
   * is the first thing anyone wants from a list like this.
   */
  const flag =
    event.status === 'cancelled'
      ? '<span class="flag stop">Cancelled</span>'
      : event.status === 'rescheduled'
        ? '<span class="flag warn">Rescheduled</span>'
        : event.cost === 'free'
          ? '<span class="flag free">Free</span>'
          : event.cost === 'paid'
            ? `<span class="flag paid">${escapeHtml(event.costText ?? 'Paid')}</span>`
            : ''
  const detail = [
    event.allDay || event.timePrecision === 'date-only' ? 'all day' : formatTime(event.localTime),
    event.venueName ?? event.address,
  ]
    .filter(Boolean)
    .join(' · ')
  return `<li>
    <a href="/e/${escapeHtml(event.shortCode)}">${escapeHtml(event.title)}</a>${flag}
    <span class="row-when"><time datetime="${escapeHtml(isoAttr(event))}">${escapeHtml(formatDate(event.localDate))}</time>${detail ? ` · ${escapeHtml(detail)}` : ''}</span>
  </li>`
}

/**
 * A real 404 rather than a bare string. `noindex` because a mistyped short code is a URL
 * a crawler can reach and should not keep; `follow` so the links out of it still count.
 */
export function renderNotFound(heading: string, detail: string, origin: string): string {
  return `<!doctype html><html lang="en-CA"><head>
${renderHead({ title: `${heading} — ${SITE_NAME}`, description: detail, canonical: `${origin}/`, noindex: true }, origin)}
</head><body class="event-page">
<header class="topbar"><a href="/" class="home">${MARK}<span>&larr; All events</span></a>${WIP_TAG}</header>
<main class="card">
  <h1>${escapeHtml(heading)}</h1>
  <p class="lead">${escapeHtml(detail)}</p>
  <div class="actions"><a class="btn" href="/">Browse every event</a></div>
</main>
<footer class="page-foot"><p class="copyright">${COPYRIGHT}</p></footer>
</body></html>`
}
