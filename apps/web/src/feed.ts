import { buildIcal } from '@scec/core'
import { descriptionText } from './markdown.ts'
import type { PublicEvent } from './query.ts'

/**
 * Every iCal feed the site serves — the public /calendar.ics, a reader's private feed and
 * a shared calendar's — is assembled here, so they cannot drift: same UIDs (a reader
 * subscribed to two of them must see one copy of an event, not two), same plain-text
 * descriptions, same municipality names.
 */
export function renderFeed(events: PublicEvent[], calendarName: string, origin: string): string {
  const names: Record<string, string> = {}
  for (const e of events) if (e.municipalitySlug && e.municipalityName) names[e.municipalitySlug] = e.municipalityName
  // Calendar apps show a description as plain text, so the markdown comes out.
  const plain = events.map((e) => (e.description ? { ...e, description: descriptionText(e.description) } : e))
  return buildIcal(plain, { calendarName, baseUrl: origin, municipalityNames: names })
}
