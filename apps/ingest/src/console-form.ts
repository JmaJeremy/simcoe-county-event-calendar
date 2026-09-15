import {
  MANUAL_SOURCE_SLUG,
  MUNICIPALITIES,
  fnv1a64,
  normalizeEvent,
  sourceBySlug,
  type Category,
  type Cost,
  type EventStatus,
  type Listing,
  type RawEvent,
} from '@scec/core'

/**
 * What the admin console's event form may contain, and how it becomes a listing.
 *
 * A hand-entered event is a listing from the `manual` source, built by the same
 * `normalizeEvent` every scraped one goes through — so its time is converted from
 * Simcoe County wall time exactly once, and its id and content hash follow the same rules
 * dedup relies on. Kept free of bindings so all of it runs under vitest.
 */

export const CATEGORY_OPTIONS: ReadonlyArray<readonly [Category, string]> = [
  ['community', 'Community'],
  ['arts', 'Arts & culture'],
  ['music', 'Music'],
  ['family', 'Family & kids'],
  ['outdoors', 'Outdoors'],
  ['markets', 'Markets & sales'],
  ['sports', 'Sports & fitness'],
  ['education', 'Talks & workshops'],
  ['civic-meeting', 'Council meetings'],
  ['other', 'Other'],
]

/** Let normalization pick the category from the title, as it does for scraped events. */
export const AUTO_CATEGORY = 'auto'

export const COST_OPTIONS: ReadonlyArray<readonly [Cost, string]> = [
  ['unknown', 'Not listed'],
  ['free', 'Free'],
  ['paid', 'Paid'],
]

export const STATUS_OPTIONS: ReadonlyArray<readonly [EventStatus, string]> = [
  ['scheduled', 'Going ahead'],
  ['cancelled', 'Cancelled'],
  ['rescheduled', 'Rescheduled'],
]

export interface ManualEventInput {
  title: string
  /** Null for "not specified". */
  municipalitySlug: string | null
  category: Category | typeof AUTO_CATEGORY
  date: string
  /** Null makes the event all day. */
  startTime: string | null
  endDate: string | null
  endTime: string | null
  venueName: string | null
  address: string | null
  cost: Cost
  costText: string | null
  description: string | null
  organizer: string | null
  url: string | null
  imageUrl: string | null
  status: EventStatus
}

export type FormResult =
  | { ok: true; input: ManualEventInput }
  /** `values` echoes what was typed, so the form comes back filled in. */
  | { ok: false; errors: Record<string, string>; values: Record<string, string> }

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

const LIMITS = {
  title: 200,
  venue: 200,
  address: 300,
  cost_text: 120,
  // The same ceiling enrichment puts on a scraped description.
  description: 4000,
  organizer: 200,
  url: 2000,
  image_url: 2000,
} as const

const text = (form: Record<string, unknown>, key: string, max = 2000): string | null => {
  const value = form[key]
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/\r\n?/g, '\n').trim()
  return trimmed ? trimmed.slice(0, max) : null
}

/** A web address, forgiving a missing scheme. Null when it is not one. */
const webAddress = (raw: string, httpsOnly: boolean): string | null => {
  const parsed = URL.parse(/^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`)
  if (!parsed || !parsed.hostname.includes('.')) return null
  if (parsed.protocol === 'https:' || (!httpsOnly && parsed.protocol === 'http:')) return parsed.toString()
  return null
}

const oneOf = <T extends string>(options: ReadonlyArray<readonly [T, string]>, value: string | null): T | null =>
  options.find(([key]) => key === value)?.[0] ?? null

export function parseEventForm(form: Record<string, unknown>): FormResult {
  const errors: Record<string, string> = {}
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(form)) if (typeof value === 'string') values[key] = value

  const title = text(form, 'title', LIMITS.title)
  if (!title) errors.title = 'Give the event a title.'

  const place = text(form, 'municipality')
  const municipalitySlug = place ? MUNICIPALITIES.find((m) => m.slug === place)?.slug ?? null : null
  if (place && !municipalitySlug) errors.municipality = 'Pick a municipality from the list.'

  const categoryValue = text(form, 'category') ?? AUTO_CATEGORY
  const category = categoryValue === AUTO_CATEGORY ? AUTO_CATEGORY : oneOf(CATEGORY_OPTIONS, categoryValue)
  if (!category) errors.category = 'Pick a category from the list.'

  const date = text(form, 'date')
  if (!date) errors.date = 'Add the date it starts.'
  else if (!DATE.test(date)) errors.date = 'That date is not in YYYY-MM-DD form.'

  const startTime = text(form, 'start_time')
  if (startTime && !TIME.test(startTime)) errors.start_time = 'That start time is not in HH:MM form.'
  const endTime = text(form, 'end_time')
  if (endTime && !TIME.test(endTime)) errors.end_time = 'That end time is not in HH:MM form.'
  if (endTime && !startTime) errors.end_time = 'Add a start time too, or clear this for an all-day event.'

  const endDate = text(form, 'end_date')
  if (endDate && !DATE.test(endDate)) errors.end_date = 'That date is not in YYYY-MM-DD form.'
  else if (endDate && date && endDate < date) errors.end_date = 'It cannot end before it starts.'

  if (!errors.date && !errors.start_time && !errors.end_time && !errors.end_date && date && startTime && endTime) {
    // Same-format wall strings compare correctly as text.
    if (`${endDate ?? date}T${endTime}` <= `${date}T${startTime}`) {
      errors.end_time = endDate && endDate > date ? 'It cannot end before it starts.' : 'It ends before it starts — set an end date if it runs past midnight.'
    }
  }

  const rawUrl = text(form, 'url', LIMITS.url)
  const url = rawUrl ? webAddress(rawUrl, false) : null
  if (rawUrl && !url) errors.url = 'That link does not look like a web address.'

  // https only: an http image on an https page is blocked by the browser as mixed content.
  const rawImage = text(form, 'image_url', LIMITS.image_url)
  const imageUrl = rawImage ? webAddress(rawImage, true) : null
  if (rawImage && !imageUrl) errors.image_url = 'Use an https:// image address.'

  const cost = oneOf(COST_OPTIONS, text(form, 'cost') ?? 'unknown')
  if (!cost) errors.cost = 'Pick free, paid or not listed.'
  const status = oneOf(STATUS_OPTIONS, text(form, 'status') ?? 'scheduled')
  if (!status) errors.status = 'Pick a status from the list.'

  if (Object.keys(errors).length) return { ok: false, errors, values }
  return {
    ok: true,
    input: {
      title: title!,
      municipalitySlug,
      category: category!,
      date: date!,
      startTime,
      endDate: endDate && endDate > date! ? endDate : null,
      endTime,
      venueName: text(form, 'venue', LIMITS.venue),
      address: text(form, 'address', LIMITS.address),
      cost: cost!,
      costText: text(form, 'cost_text', LIMITS.cost_text),
      description: text(form, 'description', LIMITS.description),
      organizer: text(form, 'organizer', LIMITS.organizer),
      url,
      imageUrl,
      status: status!,
    },
  }
}

/**
 * The listing a form describes.
 *
 * @param externalId A UUID minted on create and kept for every later edit, so the listing
 *   id — and with it the event's short link — never changes.
 */
export function buildManualListing(input: ManualEventInput, externalId: string): Listing {
  const source = sourceBySlug(MANUAL_SOURCE_SLUG)
  if (!source) throw new Error('The manual source is missing from the registry')

  const allDay = !input.startTime
  // All-day spans end at 23:59 on their last day, the convention the scrapers use and the
  // site's "has it finished" rule reads. A one-day all-day event has no end at all.
  let localEnd: string | undefined
  if (allDay) localEnd = input.endDate ? `${input.endDate}T23:59` : undefined
  else if (input.endTime) localEnd = `${input.endDate ?? input.date}T${input.endTime}`
  else if (input.endDate) localEnd = `${input.endDate}T23:59`

  const place = MUNICIPALITIES.find((m) => m.slug === input.municipalitySlug)
  const raw: RawEvent = {
    externalId,
    title: input.title,
    description: input.description ?? undefined,
    localStart: `${input.date}T${input.startTime ?? '00:00'}`,
    localEnd,
    allDay,
    timePrecision: allDay ? 'date-only' : 'exact',
    venueName: input.venueName ?? undefined,
    address: input.address ?? undefined,
    municipalityHint: place?.name,
    costText: input.costText ?? undefined,
    isFree: input.cost === 'free' ? true : undefined,
    categories: [],
    organizer: input.organizer ?? undefined,
    imageUrl: input.imageUrl ?? undefined,
    // NOT NULL in the schema. Empty means "no page elsewhere": the event page then drops
    // its "View the listing" button, and dedup's URL signal cannot match an empty string
    // against any scraped listing, which always has one.
    url: input.url ?? '',
    raw: { enteredBy: 'console' },
  }

  const listing = normalizeEvent(source, raw)
  /*
   * What the form says wins over what normalization infers. Someone who picked "not
   * specified" meant it, even if the address names a town; "not listed" is a choice, not an
   * invitation to guess from the description; and a status is set, not read from the title.
   */
  const overrides = {
    municipalitySlug: input.municipalitySlug,
    category: input.category === AUTO_CATEGORY ? listing.category : input.category,
    cost: input.cost,
    status: input.status,
  }
  return {
    ...listing,
    ...overrides,
    // The hash covers the raw fields only, so fold the choices in too: an edit that only
    // moves an event to another town must still read as a change to dedup's verdict cache.
    contentHash: fnv1a64(`${listing.contentHash}|${JSON.stringify(overrides)}`),
  }
}
