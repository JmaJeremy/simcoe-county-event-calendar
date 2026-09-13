import type { Adapter, Platform } from '@scec/core'
import { fetchCitySpark } from './cityspark.ts'
import { fetchDrupal } from './drupal.ts'
import { fetchEventon } from './eventon.ts'
import { fetchSpaces } from './spaces.ts'
import { fetchGovstack } from './govstack.ts'
import { fetchTribe } from './tribe.ts'

/**
 * Platform -> adapter. Adding a site that runs one of these means adding a row to the
 * source registry and touching nothing here.
 */
export const ADAPTERS: Record<Platform, Adapter> = {
  govstack: fetchGovstack,
  'drupal-events': fetchDrupal,
  eventon: fetchEventon,
  tribe: fetchTribe,
  spaces: fetchSpaces,
  cityspark: fetchCitySpark,
}

export const adapterFor = (platform: Platform): Adapter => {
  const adapter = ADAPTERS[platform]
  if (!adapter) throw new Error(`No adapter registered for platform "${platform}"`)
  return adapter
}

export * from './cityspark.ts'
export * from './drupal.ts'
export * from './eventon.ts'
export * from './spaces.ts'
export * from './govstack.ts'
export * from './tribe.ts'
export * from './html.ts'
export * from './http.ts'
