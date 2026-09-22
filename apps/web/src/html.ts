/**
 * The pieces every page the worker renders itself is built from.
 *
 * Four surfaces are server-rendered — an event, a municipality, the 404 and the shell's
 * head — and all four need the same metadata: one canonical URL, share cards, the theme
 * script that has to run before the stylesheet. Keeping that in one builder is what stops
 * them drifting, which is the usual way a site ends up with a canonical tag on two of its
 * four page types.
 */

export const SITE_NAME = 'Out in Simcoe'
/**
 * The site's Facebook Page, named in `article:publisher` so a shared link is attributed
 * to it. This is NOT a way to tag the Page in someone's post: `sharer.php` honours only
 * its `u` parameter — `quote` and the rest stopped working years ago — and a tag can only
 * be typed by the person posting. Repeated in `public/index.html`'s own head, as the other
 * og tags are, and in `share.js`'s follow link.
 */
export const FACEBOOK_PAGE = 'https://www.facebook.com/OutInSimcoe/'
/**
 * The Page's numeric id, which `fb:pages` needs and the URL cannot stand in for. Public
 * information — it is on the Page's own transparency panel, and it is published in the
 * head of every page here. It is NOT the app secret or the Page access token the social
 * poster holds; those are secrets and must never reach a file the site serves.
 */
export const FACEBOOK_PAGE_ID = '1312882425245299'
/** The app id, public and repeated in `share.js` and `index.html`. Enables Page Insights. */
export const FACEBOOK_APP_ID = '1400817094828583'

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/**
 * The mark: a sun over a field — the county's fairs and festivals. Inlined so a shared
 * permalink paints it with the first byte, drawn in currentColor to follow the theme.
 */
export const MARK = `<svg class="mark" viewBox="0 0 48 48" fill="none" aria-hidden="true" focusable="false">
  <circle cx="24" cy="19" r="7.5" fill="var(--accent)"/>
  <path d="M24 4.5v4M11 11l2.9 2.9M37 11l-2.9 2.9M4.5 21h4M39.5 21h4" stroke="var(--accent)" stroke-width="3" stroke-linecap="round"/>
  <path d="M0 48V37c6.5-4.5 11-1 16.5-3.5S27 26 33 29.5 42 37 48 33.5V48Z" fill="currentColor"/>
</svg>`

/** Mirror the tag and footer lines in public/index.html and public/suggest.html; change one, change all three. */
export const WIP_TAG = '<p class="wip"><span class="wip-dot" aria-hidden="true"></span>Work in progress &middot; more events being added</p>'
export const FOOTER_NOTES = '<p class="copyright">&copy; 2026 <a href="https://jeremy.click" rel="author">Jeremy Andrews</a> &amp; Torbarrie Tech</p><p class="licence">Free and open source under the GNU GPL v3. <a href="https://github.com/JmaJeremy/simcoe-county-event-calendar">The code is on GitHub</a>.</p><p class="legal-link"><a href="/privacy">Privacy</a></p>'

/**
 * Runs before the first paint. Without it a reader who chose dark gets a white flash on
 * every server-rendered page. Mirrors the copy in public/index.html.
 */
const THEME_SCRIPT = `<script>try { var t = localStorage.getItem('theme'); if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t } catch (e) {}</script>`

export interface PageMeta {
  /** What goes in <title> and og:title. Written for a search result, not for the tab. */
  title: string
  description: string
  /** Absolute, and always on the canonical origin. */
  canonical: string
  /** Share card. Defaults to the site's own og.png. */
  image?: string
  /** 'summary' when the image is a poster rather than a 1200x630 card. */
  twitterCard?: 'summary' | 'summary_large_image'
  /** An iCal feed covering this page's events, advertised as an alternate. */
  feed?: string
  /** Structured data blocks, serialized here so callers cannot forget the escaping. */
  jsonLd?: unknown[]
  noindex?: boolean
  /** Extra tags — share.js on the event page, and nothing on the others. */
  extraHead?: string
}

/**
 * Structured data is serialized through JSON.stringify and then has every `<` escaped:
 * each value originates from a third-party calendar, and a title containing `</script>`
 * would otherwise close the block and inject markup.
 */
export const jsonLdBlock = (data: unknown): string =>
  `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`

/** The head shared by every server-rendered page. */
export function renderHead(meta: PageMeta, origin: string): string {
  const image = meta.image ?? `${origin}/og.png`
  const card = meta.twitterCard ?? 'summary_large_image'
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(meta.title)}</title>
<meta name="description" content="${escapeHtml(meta.description)}">
<meta name="theme-color" content="#e05a17">
${meta.noindex ? '<meta name="robots" content="noindex,follow">\n' : ''}<link rel="canonical" href="${escapeHtml(meta.canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:locale" content="en_CA">
<meta property="og:url" content="${escapeHtml(meta.canonical)}">
<meta property="og:title" content="${escapeHtml(meta.title)}">
<meta property="og:description" content="${escapeHtml(meta.description)}">
<meta property="og:image" content="${escapeHtml(image)}">
<meta property="article:publisher" content="${FACEBOOK_PAGE}">
<meta property="fb:pages" content="${FACEBOOK_PAGE_ID}">
<meta property="fb:app_id" content="${FACEBOOK_APP_ID}">
<meta name="twitter:card" content="${card}">
<meta name="twitter:title" content="${escapeHtml(meta.title)}">
<meta name="twitter:description" content="${escapeHtml(meta.description)}">
<meta name="twitter:image" content="${escapeHtml(image)}">
${meta.feed ? `<link rel="alternate" type="text/calendar" title="${escapeHtml(meta.title)} (iCal)" href="${escapeHtml(meta.feed)}">\n` : ''}<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
${THEME_SCRIPT}
<link rel="stylesheet" href="/style.css">
${meta.extraHead ?? ''}
${(meta.jsonLd ?? []).map(jsonLdBlock).join('\n')}`
}

/**
 * The part of a postal address that is true for every event here.
 *
 * Google treats an Event `location` without an `address` as an error rather than a
 * warning, and a bare venue name ("Legion Hall") is not an address anywhere. Sources
 * publish a street line inconsistently, so this supplies the region that is known to be
 * correct and lets the caller add whatever more it actually has.
 */
export const REGION_ADDRESS = { addressRegion: 'ON', addressCountry: 'CA' } as const

export const titleCase = (slug: string): string =>
  slug.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')

export function formatDate(localDate: string): string {
  const [y, m, d] = localDate.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString('en-CA', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

export function formatTime(localTime: string): string {
  const [h, m] = localTime.split(':').map(Number)
  const suffix = h! >= 12 ? 'p.m.' : 'a.m.'
  const hour = h! % 12 === 0 ? 12 : h! % 12
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`
}

export const localDateOf = (iso: string, tz: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))

export const localTimeOf = (iso: string, tz: string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso))
