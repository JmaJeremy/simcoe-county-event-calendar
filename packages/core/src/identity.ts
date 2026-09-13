import type { RawEvent, Source } from './types.ts'

/**
 * Listing identity and change detection.
 *
 * Identity uses the platform's own id for the occurrence and ONLY that. Keying on content
 * (the trap civi-times' predecessor fell into) turns every reschedule into a new row and
 * orphans the old one. Content hashing is a separate concern, below.
 */

/** Deterministic primary key. Re-ingesting the same occurrence always lands on the same row. */
export function listingId(source: Source, externalId: string): string {
  return `${source.slug}:${externalId}`
}

/**
 * 64-bit FNV-1a, as two 32-bit halves with different offset bases.
 *
 * Deliberately not SHA-256: this is change detection, not security, and a synchronous
 * hash keeps normalization a pure function that tests can call without awaiting. A hash
 * is only ever compared against the previous hash *of the same listing*.
 */
export function fnv1a64(input: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

/**
 * A short, stable handle for a public event, for links people paste into messages.
 *
 * Derived from the cluster id, which is sticky for the life of the event. Seven base-36
 * characters is about 78 billion values against a few thousand events; the unique index
 * on the column makes a collision loud rather than silently serving the wrong event.
 */
export function shortCode(id: string): string {
  return fnv1a64(id).replace(/^0+/, '').slice(0, 7).padStart(7, '0')
}

/**
 * Hash of the fields a source may legitimately revise after first publishing an event.
 * Excludes `externalId` (identity) and `raw` (noisy: view counters, formatting churn).
 */
export function contentHash(event: RawEvent): string {
  return fnv1a64(
    JSON.stringify([
      event.title,
      event.description ?? null,
      event.localStart,
      event.localEnd ?? null,
      event.allDay ?? false,
      event.timePrecision ?? 'exact',
      event.venueName ?? null,
      event.address ?? null,
      event.costText ?? null,
      event.isFree ?? null,
      event.categories,
      event.organizer ?? null,
      event.imageUrl ?? null,
      event.url,
    ]),
  )
}
