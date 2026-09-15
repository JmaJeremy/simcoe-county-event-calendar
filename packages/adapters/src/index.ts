import type { Adapter, EventDetail, Platform, Source } from '@scec/core'
import { fetchCitySpark } from './cityspark.ts'
import { fetchDrupal, fetchDrupalDetail } from './drupal.ts'
import { fetchEventbrite } from './eventbrite.ts'
import { fetchEventon } from './eventon.ts'
import { fetchSpaces } from './spaces.ts'
import { fetchGovstack, fetchGovstackDetail } from './govstack.ts'
import { fetchTicketmaster } from './ticketmaster.ts'
import { fetchTribe } from './tribe.ts'

/**
 * Platform -> adapter. Adding a site that runs one of these means adding a row to the
 * source registry and touching nothing here.
 */
/** Not every platform is fetched: 'manual' listings are typed in, so it has no adapter. */
export const ADAPTERS: Partial<Record<Platform, Adapter>> = {
  govstack: fetchGovstack,
  'drupal-events': fetchDrupal,
  eventon: fetchEventon,
  tribe: fetchTribe,
  spaces: fetchSpaces,
  cityspark: fetchCitySpark,
  eventbrite: fetchEventbrite,
  ticketmaster: fetchTicketmaster,
}

/**
 * Platform -> a reader for one event's own page, where there is anything worth reading.
 *
 * Only the two platforms that publish a truncated list row: govStack and Drupal keep the
 * price, the poster and the rest of the text on the event page. The others already hand
 * over everything they have in the list response, and fetching a page each would be
 * thousands of requests for nothing.
 */
export const DETAIL_FETCHERS: Partial<Record<Platform, (source: Source, url: string) => Promise<EventDetail>>> = {
  govstack: fetchGovstackDetail,
  'drupal-events': fetchDrupalDetail,
}

export const hasDetailFetcher = (platform: Platform): boolean => platform in DETAIL_FETCHERS

export const adapterFor = (platform: Platform): Adapter => {
  const adapter = ADAPTERS[platform]
  if (!adapter) throw new Error(`No adapter registered for platform "${platform}"`)
  return adapter
}

export * from './cityspark.ts'
export * from './drupal.ts'
export * from './eventbrite.ts'
export * from './eventon.ts'
export * from './spaces.ts'
export * from './govstack.ts'
export * from './ticketmaster.ts'
export * from './tribe.ts'
export * from './html.ts'
export * from './http.ts'
