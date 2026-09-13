import { contentHash, listingId } from './identity.ts'
import { resolveMunicipality } from './municipalities.ts'
import { analyzeTitle, isCivicMeeting } from './title.ts'
import { toWallString, wallDate, wallTime, wallTimeToUtc } from './time.ts'
import type { Category, Cost, Listing, RawEvent, Source } from './types.ts'

/**
 * Rows that are not public events at all. Dropped at normalization, in one tested place,
 * rather than filtered in the UI.
 */
const NON_EVENT_PATTERNS: RegExp[] = [
  /^\s*$/,
  /^test\b/i,
  /^placeholder\b/i,
  // Waste-collection reminders sit on several township calendars (Severn puts "Garbage
  // Cart and Organics Cart Pick-up" on every Tuesday). Not something to attend.
  /\b(garbage|recycling|organics|yard waste|blue box|green bin)\b.*\b(pick-?up|collection|day)\b/i,
  /\b(office|facility|arena|library|landfill|transfer station) (closed|closure)\b/i,
  /^(holiday|statutory holiday)\b/i,
]

export function isPublicEvent(event: RawEvent): boolean {
  const candidates = [event.title, ...event.categories]
  return !candidates.some((value) => NON_EVENT_PATTERNS.some((re) => re.test(value.trim())))
}

const clean = (value: string | undefined | null): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed.length > 0 ? trimmed : null
}

/* ---------- cost ---------- */

const FREE = /\b(free|no charge|no cost|pwyc|pay what you can|by donation|admission is free|free admission|free of charge|complimentary)\b/i
/** "$5", "$ 12.50", "5 dollars", "tickets $", "admission: $", "registration fee". */
const PAID =
  /(\$\s?\d|\d+(\.\d{2})?\s?(dollars|cad)\b|\b(tickets? (required|available|on sale)|admission( fee)?:?\s?\$|registration fee|cover charge|per person|per child|per family|per ticket|\d+\s?\/\s?(person|child|adult|family))\b)/i
/** "free" inside a phrase that is not about cost. */
const FREE_FALSE_FRIENDS = /\b(free parking|scent[- ]free|nut[- ]free|smoke[- ]free|barrier[- ]free|gluten[- ]free|hands[- ]free|free play|freestyle|free-?style|free the|duty[- ]free|free[- ]range|free[- ]standing|free[- ]roam)\b/gi
const stripFalseFriends = (text: string): string => text.replace(FREE_FALSE_FRIENDS, ' ')

/**
 * Whether attending costs money. The source's structured flag wins; otherwise the cost
 * text, then the title and description, are read for the words people actually use.
 *
 * "Free" phrases are checked before "$" so "Free — donations welcome ($5 suggested)" stays
 * free, and an event that is both free to enter and sells food is still free.
 */
export function classifyCost(parts: {
  isFree?: boolean
  costText?: string | null
  title?: string | null
  description?: string | null
}): Cost {
  if (parts.isFree === true) return 'free'

  const costText = stripFalseFriends(parts.costText?.trim() ?? '')
  if (costText) {
    if (/^\s*(\$?\s?0(\.00)?|none|n\/a|nil)\s*$/i.test(costText)) return 'free'
    if (FREE.test(costText)) return 'free'
    if (PAID.test(costText)) return 'paid'
  }
  if (parts.isFree === false) return 'paid'

  const text = stripFalseFriends(`${parts.title ?? ''}\n${parts.description ?? ''}`)
  if (FREE.test(text)) return 'free'
  if (PAID.test(text)) return 'paid'
  return 'unknown'
}

/* ---------- category ---------- */

/**
 * Source category names → our taxonomy. Each source has its own vocabulary ("Library
 * Happenings", "Recreation Programs and Events", "Arts & Culture"); the rules are keyword
 * based so a new calendar's labels mostly land somewhere sensible without a per-site map.
 * Order matters: first match wins, and the title is consulted only when no category hit.
 */
const CATEGORY_RULES: Array<[Category, RegExp]> = [
  ['civic-meeting', /\b(council|committee|public meeting|meetings?)\b/i],
  ['markets', /\b(markets?|farmers'? markets?|craft (sale|show)|garage sale|yard sale|bazaar|swap|flea)\b/i],
  ['music', /\b(music|concerts?|bands?|choirs?|orchestra|jazz|folk|blues|karaoke|open mic|singing|drum)\b/i],
  ['arts', /\b(art|arts|gallery|galleries|theatre|theater|films?|movies?|cinema|dance|drama|craft|pottery|painting|photograph|exhibit|museum|heritage|culture|cultural|literary|author|poetry|quilt|knit|stitch|weave)\b/i],
  ['family', /\b(family|families|kids?|child|children|toddler|baby|babies|preschool|youth|teen|tween|story ?time|storytime|circle time|parent|lego|play ?group)\b/i],
  ['sports', /\b(sport|sports|hockey|soccer|baseball|basketball|skating|skate|swim|run|race|marathon|5k|10k|golf|tennis|pickleball|curling|fitness|yoga|zumba|tai chi|bike|cycling|cornhole|bowling|shinny|tournament)\b/i],
  ['outdoors', /\b(outdoors?|hikes?|hiking|walks?|walking|trails?|parks?|nature|gardens?|beach(es)?|camps?|camping|fishing|derby|paddle|paddling|canoe|kayak|birds?|birding|forest|conservation|earth day|trees?|rides?)\b/i],
  ['education', /\b(workshops?|class(es)?|courses?|lectures?|talks?|seminars?|webinar|training|learn|lessons?|tutorial|book club|genealogy|history|science|tech|computer|literacy|clinic|information session|info session|for beginners|101)\b/i],
  ['community', /\b(community|volunteers?|fundrais\w*|charity|church|legion|seniors?|social|celebrations?|festivals?|fairs?|parades?|bbq|barbecue|dinners?|breakfasts?|lunch|potluck|open house|remembrance|canada day|christmas|halloween|easter|holiday|santa|tree lighting|fireworks|ceremony|flag raising|meet and greet|drop-?in|club|bingo|euchre|cribbage|mahjong|trivia|games? night|board games|coffee|tea|social)\b/i],
]

/**
 * Category labels that say nothing: every govStack calendar files most things under
 * "Community Events", so it must not pull every fall fair, hike and concert into
 * `community` before the title has been read.
 */
const GENERIC_CATEGORY = /^(community (events|calendar)|events?|calendar|programs?( and events)?|recreation programs and events|general|all|other|misc|featured|homepage featured)$/i

export function classifyCategory(title: string, sourceCategories: string[]): Category {
  if (isCivicMeeting(title, sourceCategories)) return 'civic-meeting'
  const informative = sourceCategories.filter((c) => !GENERIC_CATEGORY.test(c.trim()))
  for (const [category, rule] of CATEGORY_RULES) {
    if (category === 'civic-meeting') continue
    if (informative.some((c) => rule.test(c))) return category
  }
  for (const [category, rule] of CATEGORY_RULES) {
    if (category === 'civic-meeting') continue
    if (rule.test(title)) return category
  }
  return 'other'
}

/* ---------- the pipeline ---------- */

/**
 * Turn one adapter-produced event into a Listing, resolving its wall-clock time against
 * the source's zone. Pure and synchronous, so adapters can be tested from saved fixtures
 * with no network and no clock dependency.
 */
export function normalizeEvent(source: Source, event: RawEvent): Listing {
  const wall = toWallString(event.localStart)
  const startsAt = wallTimeToUtc(wall, source.timezone)
  const endWall = event.localEnd ? toWallString(event.localEnd) : null
  const endsAt = endWall ? wallTimeToUtc(endWall, source.timezone) : null

  // Sources announce cancellations in free text as often as they remove the listing.
  const analysis = analyzeTitle(event.title ?? '')
  const title = clean(analysis.title) ?? 'Untitled event'
  const description = clean(event.description)
  const categories = event.categories.map((c) => c.trim()).filter(Boolean)

  const id = listingId(source, event.externalId)

  return {
    id,
    sourceSlug: source.slug,
    sourceKind: source.kind,
    externalId: event.externalId,
    // Where it is, not who listed it: municipal calendars happily carry the neighbouring
    // town's fall fair, and the copy on the neighbour's own calendar must land in the same
    // municipality or the de-duplicator will never see the two as one event. The address
    // wins; the source's municipality is the fallback; the title is consulted only for
    // sources with no municipality of their own, because "Meet Hospice Orillia" at the
    // Ramara library is in Ramara.
    municipalitySlug:
      resolveMunicipality(event.municipalityHint, event.address, event.venueName) ??
      source.municipalitySlug ??
      resolveMunicipality(event.title) ??
      resolveMunicipality(description),

    title,
    description,
    category: classifyCategory(title, categories),
    sourceCategories: categories,

    startsAtUtc: startsAt.toISOString(),
    // An end before the start is a data-entry slip; drop it rather than emit a negative span.
    endsAtUtc: endsAt && endsAt.getTime() >= startsAt.getTime() ? endsAt.toISOString() : null,
    localDate: wallDate(wall),
    localTime: wallTime(wall),
    timezone: source.timezone,
    timePrecision: event.timePrecision ?? 'exact',
    allDay: event.allDay ?? false,

    venueName: clean(event.venueName),
    address: clean(event.address),
    cost: classifyCost({ isFree: event.isFree, costText: event.costText, title, description }),
    costText: clean(event.costText),
    organizer: clean(event.organizer),
    imageUrl: clean(event.imageUrl),
    url: event.url,

    status: analysis.status ?? 'scheduled',
    contentHash: contentHash(event),
  }
}

export interface NormalizeResult {
  listings: Listing[]
  skipped: Array<{ externalId: string; reason: string }>
}

/** Normalize a source's whole batch, dropping non-events and anything unparseable. */
export function normalizeAll(source: Source, events: RawEvent[]): NormalizeResult {
  const listings: Listing[] = []
  const skipped: NormalizeResult['skipped'] = []
  const seen = new Set<string>()

  for (const event of events) {
    if (!isPublicEvent(event)) {
      skipped.push({ externalId: event.externalId, reason: 'not a public event' })
      continue
    }
    if (seen.has(event.externalId)) {
      // Some list pages repeat an occurrence (govStack's "featured" strip duplicates rows).
      skipped.push({ externalId: event.externalId, reason: 'duplicate external id in batch' })
      continue
    }
    seen.add(event.externalId)
    try {
      listings.push(normalizeEvent(source, event))
    } catch (err) {
      // One malformed row must not lose the rest of a source's calendar.
      skipped.push({ externalId: event.externalId, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return { listings, skipped }
}
