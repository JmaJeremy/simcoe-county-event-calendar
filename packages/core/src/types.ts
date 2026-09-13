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

export type Platform = 'govstack' | 'drupal-events' | 'eventon' | 'tribe' | 'spaces' | 'cityspark'

/** Who publishes a calendar. Drives the representative choice when listings merge. */
export type SourceKind = 'municipal' | 'county' | 'library' | 'media' | 'tourism'

export type MunicipalityLevel = 'county' | 'city' | 'town' | 'township'

/** Lifecycle as *we* observe it. Sources rarely say "cancelled"; we infer it. */
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
  | { platform: 'drupal-events'; origin: string; listPath: string }
  | { platform: 'eventon'; origin: string }
  | { platform: 'tribe'; origin: string }
  | { platform: 'spaces'; host: string }
  | { platform: 'cityspark'; portal: string; ppid: number; lat: number; lng: number; distanceKm: number }

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
}

export interface SyncWindow {
  /** Inclusive 'YYYY-MM-DD'. */
  from: string
  /** Inclusive 'YYYY-MM-DD'. */
  to: string
}

/** Every adapter is this shape. Pure over its fetched payload wherever possible. */
export type Adapter = (source: Source, window: SyncWindow) => Promise<RawEvent[]>
