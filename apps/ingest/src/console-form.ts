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
  TIME_FIELDS,
  type EventOverrides,
  type OverrideField,
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

/**
 * Typed text that keeps its lines: spaces tidied within each line, at most one blank line
 * between paragraphs. `normalizeEvent` flattens every run of whitespace to one space, which
 * suits text scraped out of HTML but erases the line breaks someone typed on purpose.
 */
const keepLines = (value: string | null): string | null => {
  if (!value) return null
  const tidy = value
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return tidy || null
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
    // Only the stored text changes; the content hash already covers the raw description,
    // line breaks included, so an edit that only adds one still reads as a change.
    description: keepLines(input.description),
    // The hash covers the raw fields only, so fold the choices in too: an edit that only
    // moves an event to another town must still read as a change to dedup's verdict cache.
    contentHash: fnv1a64(`${listing.contentHash}|${JSON.stringify(overrides)}`),
  }
}

/* -------------------------------------------------------------- edits to any event */

/**
 * The event form's fields in groups, with the event fields each sets. An edit pins a whole
 * group; the four date and time inputs are one group because they set TIME_FIELDS together.
 */
export const OVERRIDE_GROUPS: ReadonlyArray<{ key: string; label: string; form: readonly string[]; event: readonly OverrideField[] }> = [
  { key: 'title', label: 'Title', form: ['title'], event: ['title'] },
  { key: 'municipality', label: 'Municipality', form: ['municipality'], event: ['municipalitySlug'] },
  { key: 'category', label: 'Category', form: ['category'], event: ['category'] },
  { key: 'when', label: 'Date and time', form: ['date', 'start_time', 'end_date', 'end_time'], event: TIME_FIELDS },
  { key: 'venue', label: 'Venue', form: ['venue'], event: ['venueName'] },
  { key: 'address', label: 'Address', form: ['address'], event: ['address'] },
  { key: 'cost', label: 'Cost', form: ['cost'], event: ['cost'] },
  { key: 'cost_text', label: 'Price details', form: ['cost_text'], event: ['costText'] },
  { key: 'description', label: 'Description', form: ['description'], event: ['description'] },
  { key: 'organizer', label: 'Organizer', form: ['organizer'], event: ['organizer'] },
  { key: 'url', label: 'Link', form: ['url'], event: ['url'] },
  { key: 'image_url', label: 'Poster image', form: ['image_url'], event: ['imageUrl'] },
  { key: 'status', label: 'Status', form: ['status'], event: ['status'] },
]

/** Each field's value as the form was filled in, posted back beside it as orig_{name}. */
export const ORIGINAL_PREFIX = 'orig_'

const hasKey = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key)

/** The groups an override pins, in form order. */
export const editedGroups = (overrides: EventOverrides): string[] =>
  OVERRIDE_GROUPS.filter((g) => g.event.some((field) => hasKey(overrides, field))).map((g) => g.key)

/** An override with some groups — or every field edit, keeping hidden — taken back out. */
export function withoutGroups(overrides: EventOverrides, keys: readonly string[] | 'all'): EventOverrides {
  const out: Record<string, unknown> = { ...overrides }
  for (const group of OVERRIDE_GROUPS) {
    if (keys === 'all' || keys.includes(group.key)) for (const field of group.event) delete out[field]
  }
  return out as EventOverrides
}

export type OverrideResult =
  | { ok: true; overrides: EventOverrides; changed: string[] }
  | { ok: false; errors: Record<string, string>; values: Record<string, string> }

const posted = (form: Record<string, unknown>, key: string): string => {
  const value = form[key]
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : ''
}

/**
 * The override a submitted edit form makes: what was there, plus every group edited now.
 *
 * A group counts as edited only when what was posted differs from what the form was filled
 * in with — never from the stored event. Scraped values do not survive a round trip through
 * the form (an http poster fails the https rule, a link gains a trailing slash, whitespace
 * is tidied), so comparing with the database would pin such fields on the first save and
 * quietly cut them off from their sources.
 */
export function overridesFromForm(form: Record<string, unknown>, existing: EventOverrides): OverrideResult {
  const touched = OVERRIDE_GROUPS.filter((g) => g.form.some((key) => posted(form, key) !== posted(form, `${ORIGINAL_PREFIX}${key}`)))
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(form)) if (typeof value === 'string') values[key] = value

  let parsed = parseEventForm(form)
  if (!parsed.ok) {
    // A field nobody touched is not being set, so the source's value need not pass the
    // form's rules: clear those and check the rest again.
    const touchedKeys = new Set(touched.flatMap((g) => g.form))
    const untouched = Object.keys(parsed.errors).filter((key) => !touchedKeys.has(key))
    if (untouched.length) parsed = parseEventForm({ ...form, ...Object.fromEntries(untouched.map((key) => [key, ''])) })
  }
  if (!parsed.ok) return { ok: false, errors: parsed.errors, values }
  if (!touched.length) return { ok: true, overrides: existing, changed: [] }

  // The same conversion a hand-entered event gets: wall time to UTC exactly once.
  const listing = buildManualListing(parsed.input, 'override')
  const overrides: Record<string, unknown> = { ...existing }
  for (const group of touched) for (const field of group.event) overrides[field] = listing[field]
  return { ok: true, overrides: overrides as EventOverrides, changed: touched.map((g) => g.key) }
}
