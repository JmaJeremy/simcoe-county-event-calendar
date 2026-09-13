import type { Adapter, Platform } from '@scec/core'
import { fetchGovstack } from './govstack.ts'

const notYet = (platform: Platform): Adapter => async () => {
  throw new Error(`Adapter for platform "${platform}" is not implemented yet`)
}

/**
 * Platform -> adapter. Adding a site that runs one of these means adding a row to the
 * source registry and touching nothing here.
 */
export const ADAPTERS: Record<Platform, Adapter> = {
  govstack: fetchGovstack,
  'drupal-events': notYet('drupal-events'),
  eventon: notYet('eventon'),
  tribe: notYet('tribe'),
  spaces: notYet('spaces'),
  cityspark: notYet('cityspark'),
}

export const adapterFor = (platform: Platform): Adapter => {
  const adapter = ADAPTERS[platform]
  if (!adapter) throw new Error(`No adapter registered for platform "${platform}"`)
  return adapter
}

export * from './govstack.ts'
export * from './html.ts'
export * from './http.ts'
