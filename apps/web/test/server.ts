import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'

/** Kept as a URL so it can serve as a base for resolving request paths. */
const PUBLIC = new URL('../public/', import.meta.url)

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
}

/** Enough shape to drive the UI: the county plus several municipalities. */
export const MUNICIPALITIES = [
  { slug: 'simcoe-county', name: 'County of Simcoe', short_name: 'Simcoe County', level: 'county', parent_slug: null },
  { slug: 'tay', name: 'Township of Tay', short_name: 'Tay', level: 'township', parent_slug: 'simcoe-county' },
  { slug: 'barrie', name: 'City of Barrie', short_name: 'Barrie', level: 'city', parent_slug: null },
  { slug: 'wasaga-beach', name: 'Town of Wasaga Beach', short_name: 'Wasaga Beach', level: 'town', parent_slug: 'simcoe-county' },
]

export const SOURCES = [
  { slug: 'tay', name: 'Township of Tay', kind: 'municipal', homepage: 'https://example.invalid' },
  { slug: 'barrietoday', name: 'BarrieToday', kind: 'media', homepage: 'https://example.invalid' },
]

const future = (days: number): string => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Each municipality gets a run of events on consecutive days starting tomorrow, so the
 * list view always has upcoming events. Which month those land in depends on today's
 * date, so calendar tests derive the month from EVENTS rather than assuming the current
 * one. Enough events that the list pages more than once.
 */
const PER_PLACE: Array<[string, string, string]> = [
  ['Fall Fair', 'community', 'free'],
  ['Farmers Market', 'markets', 'free'],
  ['Story Time', 'family', 'free'],
  ['Trail Hike', 'outdoors', 'unknown'],
  ['Jazz Night', 'music', 'paid'],
  ['Art Show', 'arts', 'free'],
  ['Pickleball Drop-in', 'sports', 'unknown'],
  ['Genealogy Talk', 'education', 'free'],
  ['Council Meeting', 'civic-meeting', 'free'],
  ['Corn Roast', 'community', 'free'],
  ['Book Sale', 'markets', 'unknown'],
  ['Open House', 'community', 'free'],
]

const PLACED = MUNICIPALITIES.flatMap((place, i) =>
  PER_PLACE.map(([title, category, cost], k) => ({
    id: `${place.slug}:${k}`,
    shortCode: `${place.slug.slice(0, 3)}${k}`,
    representativeId: `${place.slug}:${k}`,
    listingIds: [`${place.slug}:${k}`],
    sourceSlugs: k % 3 === 0 ? [place.slug, 'barrietoday'] : [place.slug],
    municipalitySlug: place.slug,
    municipalityName: place.name,
    title,
    description: null,
    category,
    startsAtUtc: `${future(i * PER_PLACE.length + k + 1)}T13:00:00.000Z`,
    endsAtUtc: null,
    localDate: future(i * PER_PLACE.length + k + 1),
    localTime: '09:00',
    timezone: 'America/Toronto',
    timePrecision: 'exact',
    allDay: false,
    venueName: 'Community Centre',
    address: null,
    cost,
    costText: cost === 'paid' ? '$10' : null,
    organizer: null,
    imageUrl: null,
    url: 'https://example.invalid',
    status: 'scheduled',
    active: true,
  })),
)

/**
 * Events no municipality could be resolved for — in production these are news-site
 * listings that name no address. They share dates with placed events so the calendar
 * still has at most a couple of chips a day.
 */
const UNPLACED_EVENTS = [
  ['Quilt Guild Meeting', 'community'],
  ['Legion Lunch', 'community'],
  ['Bridge Lessons', 'education'],
].map(([title, category], k) => ({
  ...PLACED[k]!,
  id: `unplaced:${k}`,
  shortCode: `unp${k}`,
  representativeId: `unplaced:${k}`,
  listingIds: [`unplaced:${k}`],
  sourceSlugs: ['barrietoday'],
  municipalitySlug: null as string | null,
  municipalityName: null as string | null,
  title,
  category,
  cost: 'free',
  costText: null,
}))

/** Sorted the way the real API returns them: by start, so day grouping holds. */
export const EVENTS = [...PLACED, ...UNPLACED_EVENTS].sort((a, b) => a.startsAtUtc.localeCompare(b.startsAtUtc))

/** What the default view shows: no paid events, no council meetings. */
export const VISIBLE = EVENTS.filter((e) => e.cost !== 'paid' && e.category !== 'civic-meeting')

/** Months the stub actually placed events in, earliest first. */
export const EVENT_MONTHS = [...new Set(EVENTS.map((e) => e.localDate.slice(0, 7)))].sort()

/** Serves the real public/ directory with the API stubbed, so the UI runs unmodified. */
export async function startServer(): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (url.pathname.startsWith('/api/events')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ count: EVENTS.length, events: EVENTS }))
    }
    if (url.pathname.startsWith('/api/municipalities')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(MUNICIPALITIES))
    }
    if (url.pathname.startsWith('/api/sources')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(SOURCES))
    }

    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    try {
      const body = await readFile(new URL(name, PUBLIC))
      const ext = name.slice(name.lastIndexOf('.'))
      res.writeHead(200, { 'Content-Type': TYPES[ext] ?? 'application/octet-stream' })
      if (name === 'index.html') {
        const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
        return res.end(body.toString('utf8').replaceAll('__ORIGIN__', origin))
      }
      res.end(body)
    } catch {
      res.writeHead(404).end('not found')
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
