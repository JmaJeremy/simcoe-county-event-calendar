import type { Source, SourceConfig, SourceKind } from './types.ts'
import { TICKETMASTER_VENUES } from './ticketmaster-venues.ts'

const TZ = 'America/Toronto'

/**
 * Every calendar we ingest. This is data, not code: adding a site that runs a platform we
 * already support means adding a row here and nothing else.
 *
 * Priorities decide which listing represents a cluster when several sources carry the
 * same event: a municipality's own calendar beats the county's, which beats a library's,
 * which beats a news site's user-submitted copy. Ties break on completeness.
 */
export const PRIORITY: Record<SourceKind, number> = {
  // An event someone typed into the admin console on purpose outranks every scraped copy
  // of it, so its title, time and details are the ones a merged cluster shows.
  manual: 5,
  // A festival or gallery knows its own programme best, better than a town calendar's
  // repost of it; the two rarely overlap anything else.
  organization: 8,
  municipal: 10,
  county: 20,
  library: 30,
  tourism: 40,
  // Organizers type these themselves, so the time is usually right, but the titles are
  // sales copy; they beat a news site's user-typed copy and lose to everything official.
  ticketing: 45,
  media: 50,
}

interface Row {
  slug: string
  name: string
  kind: SourceKind
  municipalitySlug: string | null
  config: SourceConfig
  homepage: string
  enabled?: boolean
}

const row = (r: Row): Source => ({
  slug: r.slug,
  name: r.name,
  kind: r.kind,
  platform: r.config.platform,
  municipalitySlug: r.municipalitySlug,
  priority: PRIORITY[r.kind],
  timezone: TZ,
  config: r.config,
  homepage: r.homepage,
  enabled: r.enabled ?? true,
})

/** Twelve calendars on Granicus govStack Events, served from a `calendar.` or `events.` subdomain. */
const govstack = (slug: string, name: string, municipalitySlug: string, host: string, kind: SourceKind = 'municipal'): Source =>
  row({
    slug,
    name,
    kind,
    municipalitySlug,
    // Council and committee meetings are civi-times' job; skipping their calendar
    // categories at fetch time saves a page or two per run. Anything that slips through
    // is still tagged civic-meeting by normalization.
    config: { platform: 'govstack', host, excludeCategories: ['Public Meeting', 'Council Meetings', 'Committee Meetings', 'Council', 'Committees'] },
    homepage: `https://${host}/`,
  })

/** Listings entered through the admin console at console.outinsimcoe.ca. */
export const MANUAL_SOURCE_SLUG = 'manual'

export const SOURCES: Source[] = [
  // ---- Hand-entered ---------------------------------------------------------------------
  // Never fetched: disabled, so the ingest loop, enrichment and the public sources list all
  // skip it. Still registered, because listings reference their source (D1 enforces the
  // foreign key), and sourceBySlug still finds it for dedup priority and "Listed on".
  row({
    slug: MANUAL_SOURCE_SLUG,
    name: 'Out in Simcoe',
    kind: 'manual',
    municipalitySlug: null,
    config: { platform: 'manual' },
    homepage: 'https://outinsimcoe.ca/',
    enabled: false,
  }),

  // ---- County -------------------------------------------------------------------------
  row({
    slug: 'simcoe-county',
    name: 'County of Simcoe',
    kind: 'county',
    municipalitySlug: null,
    config: { platform: 'eventon', origin: 'https://simcoe.ca' },
    homepage: 'https://simcoe.ca/events/',
  }),

  // ---- Municipal calendars: govStack --------------------------------------------------
  govstack('orillia', 'City of Orillia', 'orillia', 'calendar.orillia.ca'),
  govstack('midland', 'Town of Midland', 'midland', 'calendar.midland.ca'),
  govstack('bradford-west-gwillimbury', 'Town of Bradford West Gwillimbury', 'bradford-west-gwillimbury', 'calendar.townofbwg.com'),
  govstack('springwater', 'Township of Springwater', 'springwater', 'calendar.springwater.ca'),
  govstack('oro-medonte', 'Township of Oro-Medonte', 'oro-medonte', 'events.oro-medonte.ca'),
  govstack('severn', 'Township of Severn', 'severn', 'calendar.severn.ca'),
  govstack('tay', 'Township of Tay', 'tay', 'events.tay.ca'),
  govstack('ramara', 'Township of Ramara', 'ramara', 'calendar.ramara.ca'),
  govstack('penetanguishene', 'Town of Penetanguishene', 'penetanguishene', 'calendar.penetanguishene.ca'),
  govstack('essa', 'Township of Essa', 'essa', 'calendar.essatownship.on.ca'),
  govstack('wasaga-beach', 'Town of Wasaga Beach', 'wasaga-beach', 'calendar.wasagabeach.com'),

  // ---- Municipal calendars: Drupal (Upanup) event views -------------------------------
  row({
    slug: 'barrie',
    name: 'City of Barrie',
    kind: 'municipal',
    municipalitySlug: 'barrie',
    config: { platform: 'drupal-events', origin: 'https://www.barrie.ca', listPath: '/community-recreation-environment/community-events', mode: 'fullcalendar' },
    homepage: 'https://www.barrie.ca/community-recreation-environment/community-events',
  }),
  row({
    slug: 'innisfil',
    name: 'Town of Innisfil',
    kind: 'municipal',
    municipalitySlug: 'innisfil',
    config: { platform: 'drupal-events', origin: 'https://www.innisfil.ca', listPath: '/community-recreation/events', mode: 'rows' },
    homepage: 'https://www.innisfil.ca/community-recreation/events',
  }),
  row({
    slug: 'collingwood',
    name: 'Town of Collingwood',
    kind: 'municipal',
    municipalitySlug: 'collingwood',
    config: { platform: 'drupal-events', origin: 'https://www.collingwood.ca', listPath: '/arts-culture-heritage/community-public-events', mode: 'rows' },
    homepage: 'https://www.collingwood.ca/arts-culture-heritage/community-public-events',
  }),
  row({
    slug: 'tiny',
    name: 'Township of Tiny',
    kind: 'municipal',
    municipalitySlug: 'tiny',
    config: { platform: 'drupal-events', origin: 'https://www.tiny.ca', listPath: '/recreation-community/events', mode: 'fullcalendar' },
    homepage: 'https://www.tiny.ca/recreation-community/events',
  }),
  row({
    slug: 'clearview',
    name: 'Township of Clearview',
    kind: 'municipal',
    municipalitySlug: 'clearview',
    config: { platform: 'drupal-events', origin: 'https://www.clearview.ca', listPath: '/news-events-meetings/events-calendar', mode: 'fullcalendar' },
    homepage: 'https://www.clearview.ca/news-events-meetings/events-calendar',
  }),

  // ---- Municipal calendars: WordPress -------------------------------------------------
  row({
    slug: 'adjala-tosorontio',
    name: 'Township of Adjala-Tosorontio',
    kind: 'municipal',
    municipalitySlug: 'adjala-tosorontio',
    config: { platform: 'eventon', origin: 'https://adjtos.ca' },
    homepage: 'https://adjtos.ca/community/events/',
  }),
  row({
    slug: 'new-tecumseth',
    name: 'Town of New Tecumseth',
    kind: 'municipal',
    municipalitySlug: 'new-tecumseth',
    config: { platform: 'tribe', origin: 'https://www.newtecumseth.ca' },
    homepage: 'https://www.newtecumseth.ca/live-here/events/town-calendar/',
  }),

  // ---- Libraries ----------------------------------------------------------------------
  govstack('orillia-library', 'Orillia Public Library', 'orillia', 'events.orilliapubliclibrary.ca', 'library'),
  row({
    // Communico. The events page is a JS app; the calendar behind it answers the whole
    // window in one request. 827 of 848 events are in person, across three branches.
    slug: 'barrie-library',
    name: 'Barrie Public Library',
    kind: 'library',
    municipalitySlug: 'barrie',
    config: { platform: 'communico', host: 'barrielibrary.libnet.info' },
    homepage: 'https://www.barrielibrary.ca/events',
  }),
  row({
    // LibCal, one feed per calendar: children's, adult, teen.
    slug: 'springwater-library',
    name: 'Springwater Public Library',
    kind: 'library',
    municipalitySlug: 'springwater',
    config: { platform: 'libcal', host: 'springwater-ca.libcal.com', calendarIds: [8312, 8313, 8317] },
    homepage: 'https://springwaterlibrary.ca/programs-and-events/',
  }),
  row({
    // Tockify, which publishes the whole board as iCal: 613 events, 370 in the window.
    slug: 'bradford-library',
    name: 'Bradford West Gwillimbury Public Library',
    kind: 'library',
    municipalitySlug: 'bradford-west-gwillimbury',
    config: { platform: 'ics', urls: ['https://tockify.com/api/feeds/ics/bwgplcc'] },
    homepage: 'https://tockify.com/bwgplcc/agenda',
  }),
  row({
    slug: 'clearview-library',
    name: 'Clearview Public Library',
    kind: 'library',
    municipalitySlug: 'clearview',
    config: { platform: 'libcal', host: 'clearviewlibrary.libcal.com', calendarIds: [8690] },
    homepage: 'https://clearviewpubliclibrary.ca/',
  }),
  row({
    // The Events Calendar, like New Tecumseth's town calendar: 237 events in the window,
    // mostly storytimes, clubs and workshops the town calendar never carries.
    slug: 'midland-library',
    name: 'Midland Public Library',
    kind: 'library',
    municipalitySlug: 'midland',
    config: { platform: 'tribe', origin: 'https://midlandlibrary.com' },
    homepage: 'https://midlandlibrary.com/events/',
  }),
  row({
    // Four branches across the town, and the only library here that states a price: most
    // of its events say "Free" outright.
    slug: 'new-tecumseth-library',
    name: 'New Tecumseth Public Library',
    kind: 'library',
    municipalitySlug: 'new-tecumseth',
    config: { platform: 'tribe', origin: 'https://ntpl.ca' },
    homepage: 'https://ntpl.ca/events-calendar/',
  }),

  // ---- Local media: Village Media SPACES ----------------------------------------------
  // Each *Today site fronts a `<town>.spaces.ca` instance; the news sites themselves
  // refuse non-browser clients (403), the SPACES hosts do not.
  row({
    slug: 'barrietoday',
    name: 'BarrieToday',
    kind: 'media',
    municipalitySlug: null,
    config: { platform: 'spaces', host: 'barrie.spaces.ca' },
    homepage: 'https://www.barrietoday.com/local-events',
  }),
  row({
    slug: 'orilliamatters',
    name: 'OrilliaMatters',
    kind: 'media',
    municipalitySlug: null,
    config: { platform: 'spaces', host: 'orillia.spaces.ca' },
    homepage: 'https://www.orilliamatters.com/events',
  }),
  row({
    slug: 'midlandtoday',
    name: 'MidlandToday',
    kind: 'media',
    municipalitySlug: null,
    config: { platform: 'spaces', host: 'midland.spaces.ca' },
    homepage: 'https://www.midlandtoday.ca/local-events',
  }),
  row({
    slug: 'collingwoodtoday',
    name: 'CollingwoodToday',
    kind: 'media',
    municipalitySlug: null,
    config: { platform: 'spaces', host: 'collingwood.spaces.ca' },
    homepage: 'https://www.collingwoodtoday.ca/local-events',
  }),
  row({
    // Answered 503 throughout research (Sept 2026). Re-enable when it responds.
    slug: 'bradfordtoday',
    name: 'BradfordToday',
    kind: 'media',
    municipalitySlug: null,
    config: { platform: 'spaces', host: 'bradford.spaces.ca' },
    homepage: 'https://www.bradfordtoday.ca/local-events',
    enabled: false,
  }),

  // ---- Organizations' own calendars ---------------------------------------------------
  row({
    // Suggested through the site's form. Enabled before its October programme is posted:
    // a new source returning nothing is not an outage to reconcile(), only a quiet one.
    slug: 'barrie-film-festival',
    name: 'Barrie Film Festival',
    kind: 'organization',
    municipalitySlug: 'barrie',
    config: { platform: 'tribe', origin: 'https://barriefilmfestival.ca' },
    homepage: 'https://barriefilmfestival.ca/now-playing/',
  }),

  row({
    // The Opera House's TIXHUB box office, which also sells Mariposa Arts Theatre's main
    // stage, the Leacock Museum's events and the jazz festival: 34 shows (2026-09-18),
    // none of them on any other source we read.
    slug: 'orillia-opera-house',
    name: 'Orillia Opera House',
    kind: 'organization',
    municipalitySlug: 'orillia',
    config: { platform: 'tixhub', tenant: 'Orillia-OH' },
    homepage: 'https://www.orilliaoperahouse.ca/',
  }),
  row({
    // Mariposa Arts Theatre's TIFF Film Circuit series at Galaxy Cinemas, since 1996:
    // two screenings per film, published only as prose on the theatre's Wix page.
    slug: 'mat-film-nights',
    name: 'MAT Film Nights (Mariposa Arts Theatre)',
    kind: 'organization',
    municipalitySlug: 'orillia',
    config: {
      platform: 'mat-film-nights',
      url: 'https://www.mariposaartstheatre.com/filmnights',
      venue: 'Galaxy Cinemas Orillia',
      address: '865 West Ridge Blvd, Orillia',
      admission: '$10 regular admission, $5 student',
    },
    homepage: 'https://www.mariposaartstheatre.com/filmnights',
    // CFB Borden, on the CFMWS site. The page embeds its whole list as JSON; most of it
    // is national online webinars, dropped, leaving the base's own events.
    slug: 'cfb-borden',
    name: 'CFB Borden (CFMWS)',
    kind: 'organization',
    municipalitySlug: 'cfb-borden',
    config: { platform: 'cfmws', origin: 'https://cfmws.ca', eventsPath: '/borden/events-activities/events', place: 'CFB Borden' },
    homepage: 'https://cfmws.ca/borden/events-activities/events',
  }),

  // ---- Tourism ------------------------------------------------------------------------
  row({
    // Sitefinity's OData service: 100 upcoming events in one request (2026-09-18), 48 of
    // them on no other source we read. Regional despite the name, from Cookstown to
    // Penetanguishene, so events are placed one by one and the source claims no town.
    slug: 'tourism-barrie',
    name: 'Tourism Barrie',
    kind: 'tourism',
    municipalitySlug: null,
    config: { platform: 'sitefinity', origin: 'https://www.tourismbarrie.com', detailPath: '/festivals-events/details' },
    homepage: 'https://www.tourismbarrie.com/festivals-events',
  }),

  // ---- Local media: Barrie 360 --------------------------------------------------------
  row({
    // The Events Calendar's REST API: 336 events in the next six months (2026-09-18),
    // county-wide despite the name.
    slug: 'barrie360',
    name: 'Barrie 360',
    kind: 'media',
    municipalitySlug: null,
    config: { platform: 'tribe', origin: 'https://barrie360.com' },
    homepage: 'https://barrie360.com/events/',
  }),

  // ---- Local media: Metroland simcoe.com on CitySpark --------------------------------
  row({
    slug: 'simcoe-com',
    name: 'Simcoe.com',
    kind: 'media',
    municipalitySlug: null,
    // 75 km from downtown Barrie reaches Collingwood (~50 km) and Penetanguishene (~45 km).
    // Out-of-county results (Gravenhurst, Newmarket, Orangeville) are dropped when the
    // gazetteer cannot place them in a Simcoe municipality.
    config: { platform: 'cityspark', portal: 'Simcoe', ppid: 9299, lat: 44.389, lng: -79.69, distanceKm: 75 },
    homepage: 'https://www.simcoe.com/events/',
  }),

  // ---- Ticketing platforms ------------------------------------------------------------
  row({
    slug: 'eventbrite',
    name: 'Eventbrite',
    kind: 'ticketing',
    municipalitySlug: null,
    // West of Collingwood to east of Ramara, south of Bradford to north of Midland. The box
    // reaches Newmarket and Shelburne too; the adapter drops what the gazetteer cannot place.
    config: { platform: 'eventbrite', bbox: '-80.45,43.95,-79.1,44.95' },
    homepage: 'https://www.eventbrite.ca/d/canada--barrie/events/',
  }),
  row({
    slug: 'ticketmaster',
    name: 'Ticketmaster',
    kind: 'ticketing',
    municipalitySlug: null,
    config: { platform: 'ticketmaster', venueIds: TICKETMASTER_VENUES.map((v) => v.id) },
    homepage: 'https://www.ticketmaster.ca/',
  }),
]

export const sourceBySlug = (slug: string): Source | undefined => SOURCES.find((s) => s.slug === slug)

export const enabledSources = (): Source[] => SOURCES.filter((s) => s.enabled)
