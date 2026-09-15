import { describe, expect, it } from 'vitest'
import worker, { type Env } from '../src/worker.ts'
import { renderRobots, renderSitemap } from '../src/sitemap.ts'

/**
 * The SEO surface is metadata, which means nothing about it is visible when it breaks —
 * a canonical naming the wrong host, a sitemap advertising the fallback origin, or an
 * event whose structured data is missing the one property Google requires all look
 * exactly like a working site. These assert the parts a human would never notice.
 *
 * The database is a stub that dispatches on the shape of each query rather than a real
 * D1: the queries are covered elsewhere, and what is under test here is what the worker
 * puts in the response.
 */

const APEX = 'outinsimcoe.ca'
const FALLBACK = 'scec-web.thejeremy-net.workers.dev'

const EVENT_ROW = {
  id: 'tay:1',
  short_code: 'tay7',
  representative_id: 'tay:1',
  listing_ids: '["tay:1"]',
  source_slugs: '["tay"]',
  municipality_slug: 'tay',
  municipality_name: 'Township of Tay',
  title: 'Waubaushene Fall Fair',
  description: 'Rides, a midway and the pie tent.',
  category: 'community',
  starts_at_utc: '2026-10-03T14:00:00.000Z',
  ends_at_utc: null,
  local_date: '2026-10-03',
  local_time: '10:00',
  timezone: 'America/Toronto',
  time_precision: 'exact',
  all_day: 0,
  venue_name: 'Waubaushene Memorial Park',
  address: '12 Pine Street',
  cost: 'free',
  cost_text: null,
  organizer: 'Tay Recreation',
  image_url: null,
  url: 'https://example.invalid/fair',
  status: 'scheduled',
  active: 1,
  listing_count: 1,
  updated_at: '2026-09-14T17:00:00.000Z',
}

/** Answers whichever of the worker's queries it recognises, by a phrase unique to each. */
function stubEnv(overrides: Record<string, unknown[]> = {}): Env {
  const answer = (sql: string): unknown[] => {
    for (const [needle, rows] of Object.entries(overrides)) {
      if (sql.includes(needle)) return rows
    }
    if (sql.includes('FROM municipalities m')) {
      return [{ slug: 'tay', lastmod: '2026-09-14T17:00:00.000Z' }]
    }
    if (sql.includes('SELECT short_code')) {
      return [{ short_code: 'tay7', updated_at: '2026-09-14T17:00:00.000Z', local_date: '2026-10-03' }]
    }
    if (sql.includes('local_date <')) return []
    if (sql.includes('FROM events e LEFT JOIN municipalities')) return [EVENT_ROW]
    return []
  }
  const statement = (sql: string) => ({
    bind: () => statement(sql),
    all: async () => ({ results: answer(sql) as any[] }),
    first: async () => (answer(sql)[0] ?? null) as any,
    run: async () => ({}),
  })
  return {
    DB: { prepare: (sql: string) => statement(sql) as any },
    ASSETS: {
      fetch: async () =>
        new Response('<html>__ORIGIN__ __PLACE_LINKS__</html>', { headers: { 'Content-Type': 'text/html' } }),
    },
    CANONICAL_HOST: APEX,
  } as unknown as Env
}

const get = (path: string, host = APEX, env: Env = stubEnv()) =>
  worker.fetch(new Request(`https://${host}${path}`), env)

const jsonLd = (body: string): any[] =>
  [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) =>
    JSON.parse(m[1]!.replace(/\\u003c/g, '<')),
  )

describe('robots.txt', () => {
  it('names the sitemap and keeps crawlers out of the JSON endpoints', () => {
    const body = renderRobots(`https://${APEX}`, true)
    expect(body).toContain(`Sitemap: https://${APEX}/sitemap.xml`)
    expect(body).toContain('Disallow: /api/')
  })

  /*
   * The fallback host must stay crawlable even though it must not be indexed: a
   * `Disallow: /` would stop the crawler ever reading the X-Robots-Tag that does the
   * actual work, and a blocked URL can still be indexed from inbound links.
   */
  it('still allows crawling on the fallback host, and points home', async () => {
    const body = await (await get('/robots.txt', FALLBACK)).text()
    expect(body).not.toContain('Disallow: /\n')
    expect(body).not.toContain('Disallow: /api/')
    expect(body).toContain(`Sitemap: https://${APEX}/sitemap.xml`)
  })
})

describe('sitemap.xml', () => {
  it('writes every URL against the canonical origin, never the serving host', async () => {
    const res = await get('/sitemap.xml', FALLBACK)
    const xml = await res.text()
    expect(res.headers.get('content-type')).toContain('application/xml')
    expect(xml).not.toContain('workers.dev')
    expect(xml).toContain(`<loc>https://${APEX}/</loc>`)
    expect(xml).toContain(`<loc>https://${APEX}/place/tay</loc>`)
    expect(xml).toContain(`<loc>https://${APEX}/e/tay7</loc>`)
    expect(xml).toContain('<lastmod>2026-09-14</lastmod>')
  })

  it('escapes query strings and drops a lastmod it cannot parse', () => {
    const xml = renderSitemap(
      [
        { path: '/?view=calendar&month=2026-09', lastmod: 'not a date' },
        { path: '/e/abc', lastmod: '2026-01-02T03:04:05.000Z' },
      ],
      `https://${APEX}`,
    )
    expect(xml).toContain(`<loc>https://${APEX}/?view=calendar&amp;month=2026-09</loc>`)
    expect(xml).not.toContain('not a date')
    expect(xml).toContain('<lastmod>2026-01-02</lastmod>')
  })
})

describe('event pages', () => {
  it('declares one canonical URL no matter which host served it', async () => {
    for (const host of [APEX, FALLBACK]) {
      const body = await (await get('/e/tay7', host)).text()
      expect(body).toContain(`<link rel="canonical" href="https://${APEX}/e/tay7">`)
      expect(body).toContain(`<meta property="og:url" content="https://${APEX}/e/tay7">`)
    }
  })

  /* The fallback origin serves the identical site; without this it competes for the same
     queries as the apex and search engines pick the winner themselves. */
  it('tells crawlers not to index the fallback origin', async () => {
    expect((await get('/e/tay7', APEX)).headers.get('x-robots-tag')).toBeNull()
    expect((await get('/e/tay7', FALLBACK)).headers.get('x-robots-tag')).toBe('noindex, follow')
  })

  it('emits an Event with the properties a rich result needs', async () => {
    const event = jsonLd(await (await get('/e/tay7')).text()).find((b) => b['@type'] === 'Event')
    expect(event.name).toBe('Waubaushene Fall Fair')
    expect(event.startDate).toBe('2026-10-03T14:00:00.000Z')
    expect(event.url).toBe(`https://${APEX}/e/tay7`)
    expect(event.isAccessibleForFree).toBe(true)
    // A venue name is not an address, and Google treats a location without one as an
    // error rather than a warning.
    expect(event.location.address['@type']).toBe('PostalAddress')
    expect(event.location.address.streetAddress).toBe('12 Pine Street')
    expect(event.location.address.addressLocality).toBe('Township of Tay')
    expect(event.location.address.addressRegion).toBe('ON')
  })

  /* Most of these events have no address at all; an Event with no location is invalid,
     so the town it is in stands in rather than the property going missing. */
  it('still has a location when the source published no venue or address', async () => {
    const env = stubEnv({
      'FROM events e LEFT JOIN municipalities': [{ ...EVENT_ROW, venue_name: null, address: null }],
    })
    const event = jsonLd(await (await get('/e/tay7', APEX, env)).text()).find((b) => b['@type'] === 'Event')
    expect(event.location.name).toBe('Township of Tay')
    expect(event.location.address.addressLocality).toBe('Township of Tay')
    expect(event.location.address.streetAddress).toBeUndefined()
  })

  it('carries breadcrumbs up through its municipality', async () => {
    const body = await (await get('/e/tay7')).text()
    const crumbs = jsonLd(body).find((b) => b['@type'] === 'BreadcrumbList')
    expect(crumbs.itemListElement.map((i: any) => i.item)).toEqual([
      `https://${APEX}/`,
      `https://${APEX}/place/tay`,
      `https://${APEX}/e/tay7`,
    ])
    expect(body).toContain('href="/place/tay"')
  })

  it('answers a bad short code with an HTML 404 that is not indexable', async () => {
    const env = stubEnv({ 'FROM events e LEFT JOIN municipalities': [] })
    const res = await get('/e/nope', APEX, env)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('x-robots-tag')).toBe('noindex, follow')
    expect(await res.text()).toContain('name="robots" content="noindex,follow"')
  })
})

describe('municipality pages', () => {
  it('is a page about one place, linking to each of its events', async () => {
    const res = await get('/place/tay')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('<title>Things to do in Tay — Out in Simcoe</title>')
    expect(body).toContain(`<link rel="canonical" href="https://${APEX}/place/tay">`)
    expect(body).toContain('<h1>Things to do in Tay</h1>')
    // The whole point: a crawlable route to the permalinks, which are otherwise only ever
    // reachable from a link someone shared.
    expect(body).toContain('href="/e/tay7"')
    expect(body).toContain('<link rel="alternate" type="text/calendar"')
  })

  it('lists its events as structured data', async () => {
    const list = jsonLd(await (await get('/place/tay')).text()).find((b) => b['@type'] === 'ItemList')
    expect(list.itemListElement[0].url).toBe(`https://${APEX}/e/tay7`)
  })

  /* The list view hides paid events by default. A page answering "what is on in this
     town" must not, or it answers a different question. */
  it("shows paid events, unlike the list view's default", async () => {
    const env = stubEnv({
      'local_date >=': [{ ...EVENT_ROW, title: 'Jazz at the Legion', cost: 'paid', cost_text: '$20' }],
    })
    const body = await (await get('/place/tay', APEX, env)).text()
    expect(body).toContain('Jazz at the Legion')
  })

  it('404s for a slug we do not cover, without touching the database', async () => {
    const res = await get('/place/toronto')
    expect(res.status).toBe(404)
    expect(res.headers.get('x-robots-tag')).toBe('noindex, follow')
  })

  it('sends a bare /place home rather than into the asset router\'s 404', async () => {
    const res = await get('/place')
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe(`https://${APEX}/`)
  })
})

describe('the shell', () => {
  it('gets the municipality index substituted in, so the place pages are linked', async () => {
    const body = await (await get('/')).text()
    expect(body).not.toContain('__PLACE_LINKS__')
    expect(body).toContain('href="/place/barrie"')
    expect(body).toContain('href="/place/wasaga-beach"')
  })
})
