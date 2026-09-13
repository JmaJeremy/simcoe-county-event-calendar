import { shortCode } from './identity.ts'
import { GAZETTEER } from './municipalities.ts'
import type { Event, Listing } from './types.ts'

/**
 * Cross-source de-duplication.
 *
 * The same fall fair is routinely listed by the township, the county, the library and a
 * news site, each with its own id, title wording, and idea of the venue. This module
 * decides which listings are the same event and builds clusters from the answer. It is
 * pure: no database, no clock, no network. The LLM step lives behind a `Judge` interface
 * that the ingest app supplies; everything here can be tested from plain objects.
 *
 * Shape of the problem, measured on real data (2,295 listings): the dangerous mistakes
 * are false merges, not misses. Two townships each holding a "Farmers' Market" at 9:00 on
 * the same Saturday are two events, and a weekly "Genealogy Club" is a different event
 * every week. So candidates are gated hard by DATE and MUNICIPALITY before any similarity
 * is computed, and same-source pairs are never candidates at all (a source's own repeats
 * are separate occurrences by construction).
 */

export type Verdict = 'same' | 'distinct' | 'ambiguous'

export interface PairScore {
  a: string
  b: string
  score: number
  title: number
  time: number
  place: number
  url: number
}

export const MERGE_THRESHOLD = 0.85
export const DISTINCT_THRESHOLD = 0.45
/** Bump when scoring changes: cached rule verdicts carry it and are recomputed when it differs. */
export const RULES_VERSION = 'rule:v2'

/* ---------- text normalisation ---------- */

const PLACE_NAMES = new Set(Object.values(GAZETTEER).flat().map((n) => n.toLowerCase()))
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', '&', 'at', 'in', 'on', 'for', 'to', 'with', 'by', 'presented', 'presents',
  'annual', 'event', 'events', 'township', 'town', 'city', 'county', 'public', 'library', 'community',
  'centre', 'center', 'park', 'hall', 'free', 'am', 'pm', 'edition',
  // Dates are not identity: "Women Connect - September" is "Women Connect - Sep 2026".
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'mondays', 'tuesdays', 'wednesdays', 'thursdays', 'fridays', 'saturdays', 'sundays',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
])
const ORDINAL = /^\d+(st|nd|rd|th)$/

/** Lowercase, punctuation out, ordinals/years/place names/filler out. What is left is what the event IS. */
export function normalizeTitle(title: string): string[] {
  const words = title
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  // Drop multi-word place names first ("wasaga beach", "victoria harbour"), then single words.
  let stripped = ` ${words.join(' ')} `
  for (const name of PLACE_NAMES) {
    if (name.includes(' ') && stripped.includes(` ${name} `)) stripped = stripped.replaceAll(` ${name} `, ' ')
  }
  return stripped
    .trim()
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w) && !PLACE_NAMES.has(w) && !ORDINAL.test(w) && !/^(19|20)\d\d$/.test(w))
}

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 && b.size === 0) return 1
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

const trigrams = (s: string): Set<string> => {
  const padded = `  ${s} `
  const out = new Set<string>()
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3))
  return out
}

const dice = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 && b.size === 0) return 1
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return (2 * inter) / (a.size + b.size)
}

/** 0-1. Token overlap catches reordering; trigrams catch spelling ("Habour"); containment catches "X" vs "X at Y". */
export function titleSimilarity(a: string, b: string): number {
  const ta = normalizeTitle(a)
  const tb = normalizeTitle(b)
  const sa = new Set(ta)
  const sb = new Set(tb)
  const j = jaccard(sa, sb)
  const d = dice(trigrams(ta.join(' ')), trigrams(tb.join(' ')))
  const smaller = Math.min(sa.size, sb.size)
  let contained = 0
  if (smaller >= 2) {
    let inter = 0
    for (const x of sa) if (sb.has(x)) inter++
    contained = inter / smaller
  }
  // Containment is capped below the merge threshold on its own: "Harvest Supper" inside
  // "Coldwater United Church Harvest Supper" is likely, not certain, and goes to the judge.
  return Math.max(0.5 * j + 0.5 * d, contained * 0.8)
}

/* ---------- other signals ---------- */

const MINUTE = 60_000

export function timeAgreement(a: Listing, b: Listing): number {
  const aDated = a.allDay || a.timePrecision === 'date-only'
  const bDated = b.allDay || b.timePrecision === 'date-only'
  if (aDated && bDated) return 0.8
  if (aDated !== bDated) return 0.4
  const delta = Math.abs(Date.parse(a.startsAtUtc) - Date.parse(b.startsAtUtc))
  if (delta <= 15 * MINUTE) return 1
  if (delta <= 60 * MINUTE) return 0.5
  if (delta <= 3 * 60 * MINUTE) return 0.2
  return 0
}

const STREET_ABBREVIATIONS: Record<string, string> = {
  highway: 'hwy', road: 'rd', street: 'st', avenue: 'ave', drive: 'dr', boulevard: 'blvd', crescent: 'cres',
  concession: 'conc', sideroad: 'sdrd', line: 'ln', lane: 'ln', court: 'crt', place: 'pl', trail: 'trl',
  north: 'n', south: 's', east: 'e', west: 'w',
}

/** '2297 Highway 12, Brechin' and '2297 Hwy 12' both become '2297 hwy'. */
const streetKey = (address: string | null): string | null => {
  if (!address) return null
  const words = address
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((w) => STREET_ABBREVIATIONS[w] ?? w)
  const i = words.findIndex((w) => /^\d+[a-z]?$/.test(w))
  if (i < 0 || !words[i + 1]) return null
  return `${words[i]} ${words[i + 1]}`
}

const placeTokens = (l: Listing): Set<string> =>
  new Set(
    `${l.venueName ?? ''} ${l.address ?? ''}`
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !PLACE_NAMES.has(w)),
  )

/** 0-1, or 0.5 when either side says nothing about where (unknown, not disagreeing). */
export function placeSimilarity(a: Listing, b: Listing): number {
  const ka = streetKey(a.address)
  const kb = streetKey(b.address)
  if (ka && kb) return ka === kb ? 1 : 0
  const pa = placeTokens(a)
  const pb = placeTokens(b)
  if (pa.size === 0 || pb.size === 0) return 0.5
  const j = jaccard(pa, pb)
  return j >= 0.34 ? 1 : j > 0 ? 0.6 : 0
}

const canonicalUrl = (url: string): string =>
  url
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/[?#].*$/, '')
    .replace(/\/$/, '')

export function urlMatch(a: Listing, b: Listing): number {
  return canonicalUrl(a.url) === canonicalUrl(b.url) ? 1 : 0
}

/* ---------- gating and scoring ---------- */

/** 'YYYY-MM-DD' of the last day a listing spans, in its own zone. */
export function lastDate(l: Listing): string {
  if (!l.endsAtUtc) return l.localDate
  const end = new Intl.DateTimeFormat('en-CA', { timeZone: l.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(l.endsAtUtc))
  return end > l.localDate ? end : l.localDate
}

const MAX_SPAN_DAYS = 14

/** Every date a listing occupies, capped so a season-long series does not block everything. */
export function datesSpanned(l: Listing): string[] {
  const out: string[] = []
  const end = lastDate(l)
  const d = new Date(`${l.localDate}T00:00:00Z`)
  for (let i = 0; i < MAX_SPAN_DAYS; i++) {
    const iso = d.toISOString().slice(0, 10)
    out.push(iso)
    if (iso >= end) break
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

export function compatibleMunicipality(a: Listing, b: Listing): boolean {
  return !a.municipalitySlug || !b.municipalitySlug || a.municipalitySlug === b.municipalitySlug
}

/**
 * Pairs worth scoring: different sources, a shared date, compatible municipality.
 * Returned with a.id < b.id so a pair has one identity for the decision cache.
 */
export function candidatePairs(listings: Listing[]): Array<[Listing, Listing]> {
  const byDate = new Map<string, Listing[]>()
  for (const l of listings) {
    if (!l.active) continue
    for (const d of datesSpanned(l)) {
      const bucket = byDate.get(d) ?? []
      bucket.push(l)
      byDate.set(d, bucket)
    }
  }
  const seen = new Set<string>()
  const pairs: Array<[Listing, Listing]> = []
  for (const bucket of byDate.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const [a, b] = bucket[i]!.id < bucket[j]!.id ? [bucket[i]!, bucket[j]!] : [bucket[j]!, bucket[i]!]
        if (a.sourceSlug === b.sourceSlug) continue
        if (!compatibleMunicipality(a, b)) continue
        const key = `${a.id} ${b.id}`
        if (seen.has(key)) continue
        seen.add(key)
        pairs.push([a, b])
      }
    }
  }
  return pairs
}

export function scorePair(a: Listing, b: Listing): PairScore {
  const title = titleSimilarity(a.title, b.title)
  const time = timeAgreement(a, b)
  const place = placeSimilarity(a, b)
  const url = urlMatch(a, b)
  // A shared link is close to proof; otherwise the title carries most of the weight, the
  // time is the next best discriminator, and place mostly breaks ties.
  let score = 0.55 * title + 0.3 * time + 0.15 * place
  // A title that says little in common cannot be rescued by time and place alone:
  // "Wildcard Wednesday" and "Wednesday Line Dancing" share a weekday, not an event.
  if (title < 0.45) score = Math.min(score, DISTINCT_THRESHOLD)
  // Except by a shared link, which is close to proof whatever the wording.
  if (url) score = Math.max(score, 0.9)
  // Different start dates only meet through a multi-day span: a week-long theatre run on
  // one site against a single performance on another. Never auto-merge those; the judge
  // can decide whether the single day IS the event.
  if (a.localDate !== b.localDate) score = Math.min(score, MERGE_THRESHOLD - 0.01)
  return { a: a.id, b: b.id, score: Math.min(1, score), title, time, place, url }
}

export function verdictByRules(s: PairScore): Verdict {
  if (s.score >= MERGE_THRESHOLD) return 'same'
  if (s.score <= DISTINCT_THRESHOLD) return 'distinct'
  return 'ambiguous'
}

/* ---------- clustering ---------- */

class UnionFind {
  parent = new Map<string, string>()

  find(x: string): string {
    let root = x
    while (this.parent.has(root) && this.parent.get(root) !== root) root = this.parent.get(root)!
    let cur = x
    while (this.parent.has(cur) && this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!
      this.parent.set(cur, root)
      cur = next
    }
    if (!this.parent.has(x)) this.parent.set(x, root)
    return root
  }

  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
}

export type ClusterableListing = Listing & { clusterId?: string | null }

export interface ClusterInput {
  listings: ClusterableListing[]
  /** Pairs judged the same, by listing id, with an optional score (higher is applied first). */
  sameEdges: Array<[string, string, number?]>
  /** Clusters already on record in this window, for sticky ids. */
  existingClusters: Array<{ id: string; createdAt: string }>
  /** Source priority by slug; lower wins. */
  priorityOf: (sourceSlug: string) => number
}

export interface ClusterOutput {
  events: Event[]
  assignments: Array<{ listingId: string; clusterId: string }>
  /** Existing cluster ids in the window that own nothing any more. */
  closed: string[]
}

const completeness = (l: Listing): number =>
  [l.description, l.venueName, l.address, l.costText, l.imageUrl, l.endsAtUtc, l.organizer].filter(Boolean).length +
  (l.timePrecision === 'exact' ? 2 : 0)

const firstOf = <K extends keyof Listing>(members: Listing[], key: K): Listing[K] | null => {
  for (const m of members) if (m[key]) return m[key]
  return null
}

/**
 * Connected components over "same" edges become clusters. Each cluster keeps the id it
 * had (the oldest existing cluster among its members), or takes its representative's id
 * when new. The representative is the highest-priority source's listing, ties broken by
 * how much it says.
 */
export function buildClusters(input: ClusterInput): ClusterOutput {
  const uf = new UnionFind()
  const byId = new Map(input.listings.map((l) => [l.id, l]))
  for (const l of input.listings) uf.find(l.id)

  /*
   * Municipality consistency, transitively. A listing with no municipality (a news-site
   * copy typed by an organiser) may legitimately merge with a placed listing on either
   * side of a county line — but never with both, or Barrie's and Penetanguishene's
   * ceremonies on the same morning become one event via the copy in between. Edges are
   * applied strongest first; one that would join two different placed municipalities is
   * dropped.
   */
  const municipalityOf = new Map<string, string | null>()
  for (const l of input.listings) municipalityOf.set(uf.find(l.id), l.municipalitySlug)
  const edges = [...input.sameEdges].sort((x, y) => (y[2] ?? 0) - (x[2] ?? 0))
  for (const [a, b] of edges) {
    if (!byId.has(a) || !byId.has(b)) continue
    const ra = uf.find(a)
    const rb = uf.find(b)
    if (ra === rb) continue
    const ma = municipalityOf.get(ra) ?? null
    const mb = municipalityOf.get(rb) ?? null
    if (ma && mb && ma !== mb) continue
    uf.union(a, b)
    municipalityOf.set(uf.find(a), ma ?? mb)
  }

  const groups = new Map<string, ClusterableListing[]>()
  for (const l of input.listings) {
    const root = uf.find(l.id)
    const g = groups.get(root) ?? []
    g.push(l)
    groups.set(root, g)
  }

  const createdAt = new Map(input.existingClusters.map((c) => [c.id, c.createdAt]))
  const events: Event[] = []
  const assignments: ClusterOutput['assignments'] = []
  const used = new Set<string>()

  for (const members of groups.values()) {
    const active = members.filter((m) => m.active)
    const pool = active.length ? active : members
    const representative = [...pool].sort(
      (x, y) =>
        input.priorityOf(x.sourceSlug) - input.priorityOf(y.sourceSlug) ||
        completeness(y) - completeness(x) ||
        x.id.localeCompare(y.id),
    )[0]!

    // Sticky id: the oldest cluster any member already belonged to, if it is not yet
    // claimed by another group this pass (a split leaves the id with one side).
    const previous = members
      .map((m) => m.clusterId)
      .filter((id): id is string => !!id && createdAt.has(id) && !used.has(id))
      .sort((x, y) => createdAt.get(x)!.localeCompare(createdAt.get(y)!) || x.localeCompare(y))
    const id = previous[0] ?? representative.id
    used.add(id)

    const listingIds = members.map((m) => m.id).sort()
    const sourceSlugs = [...new Set(members.map((m) => m.sourceSlug))].sort()
    // Whether the event is on: any active member's source text saying "cancelled" wins.
    const status = members.some((m) => m.active && m.status === 'cancelled') ? 'cancelled' : representative.status
    const others = members.filter((m) => m !== representative)

    events.push({
      id,
      shortCode: shortCode(id),
      representativeId: representative.id,
      listingIds,
      sourceSlugs,
      municipalitySlug: representative.municipalitySlug ?? firstOf(others, 'municipalitySlug'),
      title: representative.title,
      description: representative.description ?? firstOf(others, 'description'),
      category: representative.category,
      startsAtUtc: representative.startsAtUtc,
      endsAtUtc: representative.endsAtUtc ?? firstOf(others, 'endsAtUtc'),
      localDate: representative.localDate,
      localTime: representative.localTime,
      timezone: representative.timezone,
      timePrecision: representative.timePrecision,
      allDay: representative.allDay,
      venueName: representative.venueName ?? firstOf(others, 'venueName'),
      address: representative.address ?? firstOf(others, 'address'),
      // Any member that knows the cost beats "unknown".
      cost: representative.cost !== 'unknown' ? representative.cost : (others.find((m) => m.cost !== 'unknown')?.cost ?? 'unknown'),
      costText: representative.costText ?? firstOf(others, 'costText'),
      organizer: representative.organizer ?? firstOf(others, 'organizer'),
      imageUrl: representative.imageUrl ?? firstOf(others, 'imageUrl'),
      url: representative.url,
      status,
      active: active.length > 0,
    })
    for (const m of members) assignments.push({ listingId: m.id, clusterId: id })
  }

  const closed = input.existingClusters.map((c) => c.id).filter((id) => !used.has(id))
  return { events, assignments, closed }
}
