/**
 * Domain model.
 *
 * Two ideas carried over from civi-times, one new one:
 *
 *   - Adapters are per PLATFORM, sources are per SITE. Six adapters cover 25 sources.
 *   - Identity is (source, platform id), never a content hash. A retitled or moved event
 *     keeps its row; `contentHash` is a separate, mutable-fields-only change detector.
 *   - New here: a municipality has SEVERAL sources (its own calendar, the county, a
 *     library, the local news site), so `Municipality` and `Source` are separate, and a
 *     public `Event` is a CLUSTER of `Listing`s that the de-duplicator decided are the same
 *     thing. Listings are what adapters produce and reconciliation tracks; events are what
 *     the site shows.
 */

export type Platform = 'govstack' | 'drupal-events' | 'eventon' | 'tribe' | 'spaces' | 'cityspark' | 'eventbrite' | 'ticketmaster' | 'manual'

/** Who publishes a calendar. Drives the representative choice when listings merge. */
/**
 * `organization` is a group's own calendar for its own events (a festival, a gallery);
 * `ticketing` is a platform organizers sell through (Eventbrite, Ticketmaster).
 */
export type SourceKind = 'municipal' | 'county' | 'library' | 'organization' | 'media' | 'tourism' | 'ticketing' | 'manual'

export type MunicipalityLevel = 'county' | 'city' | 'town' | 'township'

/**
 * What the SOURCE says about the event, read from its text ("CANCELLED - Fall Fair") or
 * from a moved start time on platforms whose ids survive edits. Deliberately NOT inferred
 * from a listing disappearing: on govStack, Drupal rows and SPACES the id encodes the
 * date, time or title, so any edit mints a new id and retires the old one — treating that
 * as a cancellation would put a phantom "CANCELLED" beside every rescheduled fall fair.
 * Whether a listing is still published is `active`, a separate field.
 */
export type EventStatus = 'scheduled' | 'rescheduled' | 'cancelled'

/** Whether the source published a start time, or only a date. */
export type TimePrecision = 'exact' | 'date-only'

/**
 * Whether attending costs money. `unknown` is honest and common: most municipal calendars
 * have no cost field at all, and the word "free" appears only when someone typed it.
 */
export type Cost = 'free' | 'paid' | 'unknown'

/** Small fixed taxonomy every source's own categories are mapped onto. */
export type Category =
  | 'arts'
  | 'music'
  | 'family'
  | 'outdoors'
  | 'markets'
  | 'sports'
  | 'community'
  | 'education'
  | 'civic-meeting'
  | 'other'

export interface Municipality {
  slug: string
  name: string
  /** For chips and crowded views: 'Barrie', 'BWG', 'Oro-Medonte'. */
  shortName: string
  level: MunicipalityLevel
  /** Slug of the county for member municipalities; null for the county and separated cities. */
  parent: string | null
}

/** Per-platform connection details. Full hostnames and origins, never bare tenant slugs. */
export type SourceConfig =
  | { platform: 'govstack'; host: string; excludeCategories?: string[] }
  | {
      platform: 'drupal-events'
      origin: string
      listPath: string
      /** How the site renders its events view: FullCalendar JSON in drupalSettings, or rendered rows. */
      mode: 'fullcalendar' | 'rows'
    }
  | { platform: 'eventon'; origin: string }
  | { platform: 'tribe'; origin: string }
  | { platform: 'spaces'; host: string }
  | { platform: 'cityspark'; portal: string; ppid: number; lat: number; lng: number; distanceKm: number }
  /** Eventbrite's search over a bounding box, 'west,south,east,north'. Needs EVENTBRITE_TOKEN. */
  | { platform: 'eventbrite'; bbox: string }
  /** Ticketmaster's Discovery API, asked by venue. Needs TICKETMASTER_CONSUMER_KEY. */
  | { platform: 'ticketmaster'; venueIds: string[] }
  /** Entered by hand in the admin console. Nothing to fetch. */
  | { platform: 'manual' }

export interface Source {
  slug: string
  name: string
  kind: SourceKind
  platform: Platform
  /** Municipality every listing belongs to, or null when the source is county-wide / regional. */
  municipalitySlug: string | null
  /** Lower wins when a cluster picks its representative listing. */
  priority: number
  timezone: string
  config: SourceConfig
  /** Public-facing page a human should visit. Shown for attribution. */
  homepage: string
  enabled: boolean
}

/**
 * What an adapter produces: platform fields mapped onto common names, times still as
 * NAIVE LOCAL wall-clock strings ('YYYY-MM-DDTHH:mm'). Sources that publish offsets or
 * UTC must emit the local form here; timezone maths happens once, in normalize.
 */
export interface RawEvent {
  /** The platform's own stable id for THIS OCCURRENCE. Never a hash of mutable fields. */
  externalId: string
  title: string
  /** Plain text, HTML stripped, whitespace collapsed. */
  description?: string
  localStart: string
  localEnd?: string
  allDay?: boolean
  /** Defaults to 'exact'; 'date-only' when the source published no time. */
  timePrecision?: TimePrecision
  venueName?: string
  address?: string
  /** Town or village named in the listing, for municipality resolution. */
  municipalityHint?: string
  /** Whatever the source says about cost, verbatim ('$5', 'Free', 'PWYC'). */
  costText?: string
  /** Only when the source states it structurally (CitySpark's `Free` flag). */
  isFree?: boolean
  /** The source's own category names, unmapped. */
  categories: string[]
  organizer?: string
  imageUrl?: string
  url: string
  /** Original payload, kept for debugging and for fields we do not model yet. */
  raw: unknown
}

/** One source's view of one event occurrence, normalized. What reconciliation tracks. */
export interface Listing {
  /** `${sourceSlug}:${externalId}` — deterministic, so re-ingesting is idempotent. */
  id: string
  sourceSlug: string
  sourceKind: SourceKind
  externalId: string
  municipalitySlug: string | null

  title: string
  description: string | null
  category: Category
  sourceCategories: string[]

  /** True instant, DST-correct. The field everything sorts and filters by. */
  startsAtUtc: string
  endsAtUtc: string | null
  /** Wall-clock as published, kept so the UI can show local time without re-converting. */
  localDate: string
  localTime: string
  timezone: string
  timePrecision: TimePrecision
  allDay: boolean

  venueName: string | null
  address: string | null
  cost: Cost
  costText: string | null
  organizer: string | null
  imageUrl: string | null
  url: string

  status: EventStatus
  /** Still published by the source. False once it stops appearing; never deleted. */
  active: boolean
  /** Covers only mutable fields; drives change detection. */
  contentHash: string
}

/**
 * A public event: one cluster of listings the de-duplicator judged to be the same thing.
 * Its canonical fields are copied from the representative listing; the other listings are
 * kept and shown as "also listed on …".
 */
export interface Event {
  /** The representative listing's id at cluster creation. Sticky: never changes afterwards. */
  id: string
  /** Short handle for shareable links, derived from `id`. */
  shortCode: string
  representativeId: string
  listingIds: string[]
  sourceSlugs: string[]
  municipalitySlug: string | null

  title: string
  description: string | null
  category: Category

  startsAtUtc: string
  endsAtUtc: string | null
  localDate: string
  localTime: string
  timezone: string
  timePrecision: TimePrecision
  allDay: boolean

  venueName: string | null
  address: string | null
  cost: Cost
  costText: string | null
  organizer: string | null
  imageUrl: string | null
  url: string

  status: EventStatus
  /** True while at least one listing in the cluster is still published. */
  active: boolean
}

/**
 * What a source's own event page adds to the list row it came from.
 *
 * Several platforms publish a truncated description in their list view and keep the
 * price, the poster and the rest of the text on the event's own page. Everything here is
 * optional: a detail page that says nothing new leaves the listing as it was.
 */
export interface EventDetail {
  /** The full description, untruncated. */
  description?: string
  /** The source's own words about price, e.g. "Adults: $50.00 | Seniors: $45.00". */
  costText?: string
  /** An absolute URL for the event's poster or photo. */
  imageUrl?: string
}

export interface SyncWindow {
  /** Inclusive 'YYYY-MM-DD'. */
  from: string
  /** Inclusive 'YYYY-MM-DD'. */
  to: string
}

/** Every adapter is this shape. Pure over its fetched payload wherever possible. */
/**
 * What an adapter may need beyond its source row: credentials, for the platforms that want
 * them. The worker fills it from its secrets, the dry-run CLI from the environment. An
 * adapter whose credential is missing throws, so the source reports FAIL rather than an
 * empty calendar.
 */
export interface AdapterContext {
  secrets: Partial<
    Record<
      | 'EVENTBRITE_TOKEN'
      | 'TICKETMASTER_CONSUMER_KEY'
      | 'FETCH_PROXY_FUNCTION'
      | 'FETCH_PROXY_REGION'
      | 'FETCH_PROXY_ACCESS_KEY_ID'
      | 'FETCH_PROXY_SECRET_ACCESS_KEY'
      | 'FETCH_PROXY_FORCE',
      string
    >
  >
}

export type Adapter = (source: Source, window: SyncWindow, context?: AdapterContext) => Promise<RawEvent[]>
