import type { Event } from './types.ts'

/**
 * Hand edits to events the ingest run builds.
 *
 * Dedup rebuilds every event from its listings on each run, so an edit has to be kept apart
 * and laid back on top every time — by dedup, and by the console when it saves one. An
 * override holds only the fields that were edited; everything else keeps following the
 * sources, so a venue a calendar corrects next week still reaches the site.
 */

/** The fields an override may set. Anything else in a stored override is ignored. */
export const OVERRIDE_FIELDS = [
  'title',
  'description',
  'municipalitySlug',
  'category',
  'startsAtUtc',
  'endsAtUtc',
  'localDate',
  'localTime',
  'allDay',
  'timePrecision',
  'venueName',
  'address',
  'cost',
  'costText',
  'organizer',
  'url',
  'imageUrl',
  'status',
  // false hides an event the sources keep publishing.
  'active',
] as const

export type OverrideField = (typeof OVERRIDE_FIELDS)[number]
export type EventOverrides = Partial<Pick<Event, OverrideField>>

/**
 * When an event happens is six fields that must agree. Pinning some of them would let a
 * source's later change flow through the rest — a new date under a pinned UTC start — so
 * they are stored together or not at all, and a partial set is never applied.
 */
export const TIME_FIELDS = ['startsAtUtc', 'endsAtUtc', 'localDate', 'localTime', 'allDay', 'timePrecision'] as const

const TIME = new Set<string>(TIME_FIELDS)

export function applyOverrides(event: Event, overrides: EventOverrides | null | undefined): Event {
  if (!overrides) return event
  const has = (key: string) => Object.prototype.hasOwnProperty.call(overrides, key)
  const wholeTime = TIME_FIELDS.every(has)
  const out: Record<string, unknown> = { ...event }
  for (const key of OVERRIDE_FIELDS) {
    if (!has(key) || (TIME.has(key) && !wholeTime)) continue
    out[key] = overrides[key]
  }
  return out as unknown as Event
}

/** A stored override, forgiving anything malformed: a broken row edits nothing. */
export function parseOverrides(json: string | null | undefined): EventOverrides {
  if (!json) return {}
  try {
    const value: unknown = JSON.parse(json)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const out: Record<string, unknown> = {}
    for (const key of OVERRIDE_FIELDS) if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = (value as Record<string, unknown>)[key]
    return out as EventOverrides
  } catch {
    return {}
  }
}
