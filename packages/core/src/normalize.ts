import { contentHash, listingId } from './identity.ts'
import { GAZETTEER, resolveMunicipality } from './municipalities.ts'
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
  // Library feeds publish the building's status as if it were a programme: Bradford's
  // "CLOSED" for Truth and Reconciliation Day, Clearview's "CLOSED - All Branches",
  // New Tecumseth's "Christmas Closure", Springwater's "... All Branches CLOSED",
  // Clearview's "Christmas Eve - OPEN Special Hours (9am - 12pm)". Only the title is read,
  // anchored at its start or end, because the word alone is everywhere in real events:
  // "Museum After Hours", "Medicine Garden Closing and Gathering", and a parade whose
  // description lists the roads closed for it. Measured against all 2,037 live titles
  // (2026-09-21): 21 matched, 64 listings across five libraries, every one a notice.
  // Not bare /^closed\b/: that would take "Closed Captioned Movie Matinee" with it.
  /^closed\s*($|[-–—:(]|(for|on|today)\b)/i,
  /\b(closed|closure)\s*$/i,
  /\bbranches (are |will be )?closed\b/i,
  /\b(special|regular|holiday|modified|reduced) hours\b/i,
  /^(holiday|statutory holiday)\b/i,
  // Collingwood's events view carries council proclamations and the nightly colour of the
  // clock tower. Civic notices, not things to attend.
  /^proclamation\b/i,
  /\b(clock tower|town hall|bridge) (illuminated|lit) /i,
  /^flag[- ]raising\b.*\b(proclamation)\b/i,
]

/**
 * Days on the calendar rather than things happening on them.
 *
 * Collingwood's events view and simcoe.com both carry the same list of observances —
 * "Remembrance Day", "Diwali", "Hispanic Heritage Month", "International Men's Day", four
 * kinds of "PA Day" — each a date with a paragraph about what the day commemorates, and
 * nothing to attend. Neither source labels them, and their pages sit on the same path as
 * real events, so the title is the only signal — and the title alone is not enough:
 * "PA Day: Rollercoaster Science" is a camp, "PA Day Fun at the Penetanguishene Museum" is
 * a museum programme, New Tecumseth's "Family Day" is an afternoon at the community
 * centre. What those have and the observances lack is a start time. So an observance is
 * an observance-shaped title AND no time given.
 *
 * Description length was measured as a signal and rejected: the observances run 27 to
 * 300 characters, interleaved with real events ("Barrie Film Festival" at 173). The bare
 * holiday names are only the ones seen in the data; an untimed "Canada Day" on a town
 * calendar may well be the town's own celebration, and is left alone until one shows up.
 * Measured on all live listings (2026-09-21): 35 dropped, every one an observance; 17
 * titles of the same shape carry a time and are kept.
 */
const OBSERVANCE_PATTERNS: RegExp[] = [
  /\b(heritage|history|awareness) month$/i,
  /^(international|world|national)\b.*\bday\b/i,
  /^(remembrance day|thanksgiving( day)?|halloween|diwali|family day|inuit day|franco-ontarian day|indigenous veterans day|human rights day|(autumn|fall|spring) equinox|(summer|winter) solstice)$/i,
  /^(chanukah|hanukkah|ramadan|passover|lent) (begins|ends)$/i,
  /^pa day\b/i,
]

function isObservance(event: RawEvent): boolean {
  const untimed = event.allDay || event.timePrecision === 'date-only'
  return !!untimed && OBSERVANCE_PATTERNS.some((re) => re.test(event.title.trim()))
}

export function isPublicEvent(event: RawEvent): boolean {
  const candidates = [event.title, ...event.categories]
  if (candidates.some((value) => NON_EVENT_PATTERNS.some((re) => re.test(value.trim())))) return false
  return !isObservance(event)
}

const clean = (value: string | undefined | null): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed.length > 0 ? trimmed : null
}

/* ---------- cost ---------- */

/** Words that mean money is being asked for attendance, as opposed to merely mentioned. */
const PRICE_WORD =
  /(admission|tickets?|cost|fees?|prices?|entry|entrance|adults?|seniors?|students?|child(ren)?|youth|members?|non-?members?|drop-?in|per person|per family|at the door|in advance|registration|rates?)/i
/** A sum of money: "$5", "$ 12.50", "$1,200", "10 dollars". */
const MONEY = /\$\s?\d[\d,]*(\.\d{1,2})?|\b\d+(\.\d{2})?\s?(dollars|cad)\b/i

/** Said plainly, about getting in: strong enough to believe on its own. */
const FREE_ADMISSION =
  /\b(free admission|admission is free|free of charge|free to attend|free event|free program|free drop-?in|no charge|no cost|no fee|free entry|entry is free|pwyc|pay what you can|by donation|donations? (are )?(welcome|appreciated|accepted|gratefully)|free will offering|complimentary)\b/i
/** Just the word, anywhere: believable, but not on its own for a long page of text. */
const FREE_WORD = /\bfree\b/i
/** Money is being asked for, without a number attached. */
const PAID_PHRASE =
  /\b(tickets? (are )?(required|available|on sale)|registration fee|admission fee|cover charge|paid admission|purchase tickets?|buy tickets?)\b/i
/** "free" inside a phrase that is not about cost. */
const FREE_FALSE_FRIENDS = /\b(free parking|scent[- ]free|nut[- ]free|smoke[- ]free|barrier[- ]free|gluten[- ]free|hands[- ]free|free play|freestyle|free-?style|free the|duty[- ]free|free[- ]range|free[- ]standing|free[- ]roam|free wi-?fi|free refreshments|free coffee|free popcorn)\b/gi
const stripFalseFriends = (text: string): string => text.replace(FREE_FALSE_FRIENDS, ' ')

/** How far from a sum of money a price word still explains it. */
const NEAR_BEFORE = 34
const NEAR_AFTER = 26

/**
 * A sum of money with a price word beside it — "Adults: $50.00", "$7 per child",
 * "Tickets $25" — and the snippet that says so.
 *
 * The proximity test is the whole point. A description that mentions "$20,000 raised for
 * charity" is not a $20,000 event, and once full descriptions arrive from detail pages,
 * incidental amounts outnumber real prices. A bare sum is left for the judge to read.
 */
function priceInContext(text: string): string | undefined {
  for (const m of text.matchAll(new RegExp(MONEY.source, 'gi'))) {
    const before = text.slice(Math.max(0, m.index - NEAR_BEFORE), m.index)
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + NEAR_AFTER)
    if (PRICE_WORD.test(before) || PRICE_WORD.test(after)) {
      // The line the price is written on reads better than a window around it:
      // "Adults: $50.00 | Seniors: $45.00", not "…theatricalrights.com Adults: $50.00".
      const lineStart = text.lastIndexOf('\n', m.index) + 1
      const lineBreak = text.indexOf('\n', m.index)
      const line = text.slice(lineStart, lineBreak < 0 ? text.length : lineBreak).trim()
      if (line && line.length <= 120) return line
      return text.slice(Math.max(0, m.index - NEAR_BEFORE), m.index + m[0].length + NEAR_AFTER).trim()
    }
  }
  return undefined
}

/** Whether a sum of money appears at all, wherever it came from. */
export const containsMoney = (text: string): boolean => new RegExp(MONEY.source, 'i').test(text)

/**
 * Money being counted rather than charged: a total raised, a prize, a grant, the value of
 * an auction lot. The phrases that most often look like a price and are not.
 */
export const looksLikeFundraising = (text: string): boolean =>
  /\b(raise[ds]?|raising|proceeds|donated|donation of|grants?|prizes?|jackpot|goal|target|worth|valued at|awards?|scholarships?)\b/i.test(text)

export type CostConfidence = 'high' | 'low'

export interface CostVerdict {
  cost: Cost
  /** 'low' means "this is a guess worth a second opinion", not "probably wrong". */
  confidence: CostConfidence
  /** The words that decided it, for display and for anything asked to check the work. */
  evidence?: string
}

const snippet = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 90)

/**
 * Whether attending costs money, and how sure that is.
 *
 * The source's own structured answer wins outright. Otherwise the text is read for the
 * phrases people actually use, and "free" is checked before any sum, so "Free — donations
 * welcome ($5 suggested)" stays free and an event that is free to enter but sells food
 * still is too.
 */
export function assessCost(parts: {
  isFree?: boolean
  costText?: string | null
  title?: string | null
  description?: string | null
}): CostVerdict {
  if (parts.isFree === true) return { cost: 'free', confidence: 'high' }

  const costText = stripFalseFriends(parts.costText?.trim() ?? '')
  if (costText) {
    // A field the source labelled "Cost" is an answer, not a hint, however short.
    if (/^\s*(\$?\s?0(\.00)?|none|n\/a|nil)\s*$/i.test(costText)) return { cost: 'free', confidence: 'high', evidence: snippet(costText) }
    if (FREE_ADMISSION.test(costText) || FREE_WORD.test(costText)) return { cost: 'free', confidence: 'high', evidence: snippet(costText) }
    if (MONEY.test(costText) || PAID_PHRASE.test(costText) || PRICE_WORD.test(costText)) {
      return { cost: 'paid', confidence: 'high', evidence: snippet(costText) }
    }
  }
  if (parts.isFree === false) return { cost: 'paid', confidence: 'high' }

  const title = stripFalseFriends(parts.title ?? '')
  const text = stripFalseFriends(`${parts.title ?? ''}\n${parts.description ?? ''}`)

  const freeMatch = FREE_ADMISSION.exec(text)
  if (freeMatch) return { cost: 'free', confidence: 'high', evidence: snippet(freeMatch[0]) }

  const priced = priceInContext(text)
  if (priced) return { cost: 'paid', confidence: 'high', evidence: snippet(priced) }

  const paidPhrase = PAID_PHRASE.exec(text)
  if (paidPhrase) return { cost: 'paid', confidence: 'high', evidence: snippet(paidPhrase[0]) }

  // A title is short enough that one word in it is about the event itself.
  if (FREE_WORD.test(title)) return { cost: 'free', confidence: 'high', evidence: snippet(title) }
  if (FREE_WORD.test(text)) return { cost: 'free', confidence: 'low', evidence: snippet(text.slice(Math.max(0, text.search(FREE_WORD) - 40), text.search(FREE_WORD) + 50)) }

  const bare = MONEY.exec(text)
  if (bare) {
    // Money with nothing to say it is the price of entry: honest answer is "not stated".
    return { cost: 'unknown', confidence: 'low', evidence: snippet(text.slice(Math.max(0, bare.index - 40), bare.index + 50)) }
  }
  return { cost: 'unknown', confidence: 'low' }
}

/** The verdict alone, which is what normalization stores. */
export function classifyCost(parts: Parameters<typeof assessCost>[0]): Cost {
  return assessCost(parts).cost
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
  ['music', /\b(music|concerts?|bands?|choirs?|orchestra|jazz|folk|blues|karaoke|open mic|singing|drum|tribute)\b/i],
  ['arts', /\b(art|arts|gallery|galleries|theatre|theater|films?|movies?|cinema|dance(?! fitness)|drama|craft|pottery|painting|photograph|exhibit|museum|heritage|culture|cultural|literary|author|poetry|quilt\w*|knit\w*|crochet\w*|sew(ing)?|stitch\w*|weav\w*|embroider\w*|bead\w*|jewel(le)?ry[- ]making)\b/i],
  ['family', /\b(family|families|kids?|child|children|toddler|baby|babies|preschool|youth|teen|tween|story ?time|storytime|circle time|parent|lego|play ?group)\b/i],
  ['sports', /\b(sport|sports|hockey|soccer|baseball|basketball|skating|skate|swim|run|race|marathon|5k|10k|golf|tennis|pickleball|curling|fitness|yoga|zumba|tai chi|pilates|hiit|aerobics?|workouts?|exercise|weights|strength|stretch\w*|spin|badminton|volleyball|shuffleboard|bike|cycling|cornhole|bowling|shinny|tournament)\b/i],
  ['outdoors', /\b(outdoors?|hikes?|hiking|walks?|walking|trails?|parks?|nature|gardens?|beach(es)?|camps?|camping|fishing|derby|paddle|paddling|canoe|kayak|birds?|birding|forest|conservation|earth day|trees?(?! lighting)|rides?)\b/i],
  ['education', /\b(workshops?|class(es)?|courses?|lectures?|talks?|seminars?|webinar|training|learn|lessons?|tutorial|book club|genealogy|history|science|tech|computer|literacy|clinic|information session|info session|for beginners|101)\b/i],
  ['community', /\b(community|volunteers?|fundrais\w*|charity|church|legion|seniors?|social|celebrations?|festivals?|fairs?|parades?|bbq|barbecue|dinners?|breakfasts?|lunch|potluck|open house|remembrance|canada day|christmas|halloween|easter|holiday|santa|tree lighting|fireworks|ceremony|flag raising|meet and greet|drop-?in|club|bingo|euchre|cribbage|mahjong|trivia|games? night|board games|chess|coffee|tea|social)\b/i],
]

/**
 * Category labels that say nothing: every govStack calendar files most things under
 * "Community Events", so it must not pull every fall fair, hike and concert into
 * `community` before the title has been read. Place names are removed before this test,
 * so "Orillia events" and "Penetanguishene Event" are caught as "events".
 */
const GENERIC_CATEGORY =
  /^((special |public library )?events?|calendar|programs?( and events)?|recreation programs and events|general|all|other|misc|featured|homepage featured|things to do|happening soon|library happenings|registered|free program|pop-up|ongoing\/weekly event|)$/i

/**
 * A municipal department, not a subject. Severn files every recreation programme —
 * yoga, beading, chess — under "Recreation, Parks, and Facilities events", and the word
 * "Parks" made all 227 of them outdoors.
 */
const DEPARTMENT_LABEL = /^(recreation|parks?|facilities|culture)(,? *(and |& )?(recreation|parks?|facilities|culture))+( events?)?$/i

/**
 * Who an event is for, or how it runs — not what it is — plus the catch-all "Community
 * Event" labels, which are right as a last resort and wrong as a first. "Adults",
 * "Seniors" and "Drop-in" are among the most used labels, and read before the title they filed a seniors' yoga
 * class under community. They are consulted only when neither a subject label nor the
 * title says anything. Children's labels are not in this list on purpose: `family` IS an
 * audience category, and a child's storytime belongs there whatever else it is.
 */
const AUDIENCE_LABEL =
  /^(for )?(adults?( programming)?|seniors?|55\+|all[- ]ages|drop[- ]?in( programs)?|newcomers|2slgbtq\+|allies|((external|town organized|community hosted) )?community( events?| calendar)?)$/i

const PLACE_NAME = new RegExp(
  `\\b(${Object.values(GAZETTEER)
    .flat()
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[- ]/g, '[- ]'))
    .join('|')})\\b`,
  'gi',
)

/** "Wasaga Beach Chess Club" is about chess, not the beach. */
const withoutPlaces = (text: string): string => text.replace(PLACE_NAME, ' ').replace(/\s+/g, ' ').trim()

const firstRule = (texts: string[]): Category | null => {
  for (const [category, rule] of CATEGORY_RULES) {
    if (category === 'civic-meeting') continue
    if (texts.some((t) => rule.test(t))) return category
  }
  return null
}

/**
 * What an event is about, read in order of how much each input says: the source's own
 * subject labels, then the title, then its audience labels, then nothing.
 */
export function classifyCategory(title: string, sourceCategories: string[]): Category {
  if (isCivicMeeting(title, sourceCategories)) return 'civic-meeting'
  const labels = sourceCategories
    .map((c) => withoutPlaces(c.trim()))
    .filter((c) => !GENERIC_CATEGORY.test(c) && !DEPARTMENT_LABEL.test(c))
  const audience = labels.filter((c) => AUDIENCE_LABEL.test(c))
  const subject = labels.filter((c) => !AUDIENCE_LABEL.test(c))
  return firstRule(subject) ?? firstRule([withoutPlaces(title)]) ?? firstRule(audience) ?? 'other'
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
    active: true,
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
