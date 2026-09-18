import type { Municipality } from './types.ts'

/**
 * The 19 jurisdictions: the County of Simcoe, its 16 member municipalities, and the two
 * separated cities (Barrie and Orillia) that sit inside the county's borders but are not
 * governed by it. Same list as civi-times, so the two sites can link to each other by slug.
 */
export const MUNICIPALITIES: Municipality[] = [
  { slug: 'simcoe-county', name: 'County of Simcoe', shortName: 'Simcoe County', level: 'county', parent: null },
  { slug: 'barrie', name: 'City of Barrie', shortName: 'Barrie', level: 'city', parent: null },
  { slug: 'orillia', name: 'City of Orillia', shortName: 'Orillia', level: 'city', parent: null },
  { slug: 'adjala-tosorontio', name: 'Township of Adjala-Tosorontio', shortName: 'Adjala-Tosorontio', level: 'township', parent: 'simcoe-county' },
  { slug: 'bradford-west-gwillimbury', name: 'Town of Bradford West Gwillimbury', shortName: 'BWG', level: 'town', parent: 'simcoe-county' },
  { slug: 'clearview', name: 'Township of Clearview', shortName: 'Clearview', level: 'township', parent: 'simcoe-county' },
  { slug: 'collingwood', name: 'Town of Collingwood', shortName: 'Collingwood', level: 'town', parent: 'simcoe-county' },
  { slug: 'essa', name: 'Township of Essa', shortName: 'Essa', level: 'township', parent: 'simcoe-county' },
  { slug: 'innisfil', name: 'Town of Innisfil', shortName: 'Innisfil', level: 'town', parent: 'simcoe-county' },
  { slug: 'midland', name: 'Town of Midland', shortName: 'Midland', level: 'town', parent: 'simcoe-county' },
  { slug: 'new-tecumseth', name: 'Town of New Tecumseth', shortName: 'New Tecumseth', level: 'town', parent: 'simcoe-county' },
  { slug: 'oro-medonte', name: 'Township of Oro-Medonte', shortName: 'Oro-Medonte', level: 'township', parent: 'simcoe-county' },
  { slug: 'penetanguishene', name: 'Town of Penetanguishene', shortName: 'Penetanguishene', level: 'town', parent: 'simcoe-county' },
  { slug: 'ramara', name: 'Township of Ramara', shortName: 'Ramara', level: 'township', parent: 'simcoe-county' },
  { slug: 'severn', name: 'Township of Severn', shortName: 'Severn', level: 'township', parent: 'simcoe-county' },
  { slug: 'springwater', name: 'Township of Springwater', shortName: 'Springwater', level: 'township', parent: 'simcoe-county' },
  { slug: 'tay', name: 'Township of Tay', shortName: 'Tay', level: 'township', parent: 'simcoe-county' },
  { slug: 'tiny', name: 'Township of Tiny', shortName: 'Tiny', level: 'township', parent: 'simcoe-county' },
  { slug: 'wasaga-beach', name: 'Town of Wasaga Beach', shortName: 'Wasaga Beach', level: 'town', parent: 'simcoe-county' },
]

export const municipalityBySlug = (slug: string): Municipality | undefined =>
  MUNICIPALITIES.find((m) => m.slug === slug)

/**
 * Communities, villages and hamlets → the municipality they sit in.
 *
 * Needed because county-wide and media sources describe a venue as "Brechin" or
 * "Angus Recreation Centre", never as "Township of Ramara". Names are matched as whole
 * words, case-insensitively, longest name first so "Wasaga Beach" wins over "Wasaga" and
 * "Port Severn" over "Severn". Names shared by two municipalities (Washago straddles
 * Severn and Ramara) are assigned to the one holding the post office.
 *
 * The county's own municipalities are listed under themselves too, so "Township of Tiny"
 * and "Collingwood" resolve without a second table.
 */
export const GAZETTEER: Record<string, string[]> = {
  'simcoe-county': ['Simcoe County', 'County of Simcoe'],
  barrie: ['Barrie', 'City of Barrie'],
  orillia: ['Orillia', 'City of Orillia'],
  'adjala-tosorontio': ['Adjala-Tosorontio', 'Adjala', 'Tosorontio', 'Loretto', 'Everett', 'Lisle', 'Rosemont', 'Colgan', 'Hockley', 'Glencairn'],
  'bradford-west-gwillimbury': ['Bradford West Gwillimbury', 'Bradford', 'Bond Head', 'BWG'],
  clearview: ['Clearview', 'Stayner', 'Creemore', 'Nottawa', 'New Lowell', 'Duntroon', 'Singhampton', 'Dunedin', 'Avening', 'Sunnidale Corners', 'Brentwood'],
  collingwood: ['Collingwood'],
  essa: ['Essa', 'Angus', 'Thornton', 'Baxter', 'Utopia', 'Ivy', 'Egbert'],
  innisfil: ['Innisfil', 'Alcona', 'Stroud', 'Lefroy', 'Cookstown', 'Gilford', 'Churchill', 'Belle Ewart', 'Big Bay Point', 'Sandy Cove'],
  midland: ['Midland'],
  'new-tecumseth': ['New Tecumseth', 'Alliston', 'Beeton', 'Tottenham'],
  'oro-medonte': ['Oro-Medonte', 'Oro Medonte', 'Horseshoe Valley', 'Hawkestone', 'Shanty Bay', 'Moonstone', 'Warminster', 'Craighurst', 'Guthrie', 'Edgar', 'Jarratt', 'Sugarbush', 'Oro Station', 'Oro'],
  penetanguishene: ['Penetanguishene', 'Penetang'],
  ramara: ['Ramara', 'Brechin', 'Atherley', 'Lagoon City', 'Longford Mills', 'Uptergrove', 'Gamebridge', 'Sebright', 'Udney', 'Rama'],
  severn: ['Severn', 'Coldwater', 'Washago', 'Severn Bridge', 'Port Severn', 'Marchmont', 'Fesserton', 'Ardtrea', 'Cumberland Beach', 'Severn Falls'],
  springwater: ['Springwater', 'Elmvale', 'Midhurst', 'Minesing', 'Hillsdale', 'Anten Mills', 'Phelpston', 'Snow Valley', 'Centre Vespra', 'Orr Lake'],
  tay: ['Tay', 'Victoria Harbour', 'Port McNicoll', 'Waubaushene', 'Waverley', 'Vasey'],
  tiny: ['Tiny', 'Lafontaine', 'Perkinsfield', 'Wyevale', 'Balm Beach', 'Woodland Beach', 'Wyebridge', 'Thunder Beach', 'Bluewater Beach'],
  'wasaga-beach': ['Wasaga Beach', 'Wasaga'],
}

interface GazetteerEntry {
  slug: string
  pattern: RegExp
  length: number
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A place name followed by one of these is a street, not the place. Barrie has a Bradford
 * Street, an Essa Road and an Innisfil Street; Horseshoe Valley Road runs through three
 * townships; Orillia has a Coldwater Road. Because longer names are tried first, "80 Bradford
 * Street, Barrie" was filed in Bradford West Gwillimbury even with "Barrie" on the same line.
 * Measured against 4,008 live listings, the rule changed 8 and corrected all 8.
 */
const STREET_WORDS =
  'street|st|road|rd|avenue|ave|drive|dr|boulevard|blvd|crescent|cres|lane|ln|line|court|crt|way|trail|trl|sideroad|sdrd|place|pl|parkway|pkwy|circle|cir|terrace|concession|conc'

const ENTRIES: GazetteerEntry[] = Object.entries(GAZETTEER)
  .flatMap(([slug, names]) =>
    names.map((name) => ({
      slug,
      // Whole-word, hyphen/space tolerant: "Oro-Medonte" matches "Oro Medonte".
      // ...and not when a street word follows it.
      pattern: new RegExp(`(^|[^A-Za-z])${escape(name).replace(/[- ]/g, '[- ]')}(?=$|[^A-Za-z])(?![ ]+(?:${STREET_WORDS})\\b)`, 'i'),
      length: name.length,
    })),
  )
  .sort((a, b) => b.length - a.length)

/**
 * Resolve free text (an address, a venue, a hint like "Alliston") to a municipality slug.
 * Returns null rather than guessing: a listing with no place is better than one filed
 * under the wrong township, and the de-duplicator treats null as "compatible with any".
 *
 * The county itself is only returned when nothing more specific matches, because
 * "Simcoe County Museum, Minesing" is in Springwater.
 */
export function resolveMunicipality(...texts: Array<string | null | undefined>): string | null {
  const haystack = texts.filter((t): t is string => typeof t === 'string' && t.length > 0).join(' | ')
  if (!haystack) return null

  let county: string | null = null
  for (const entry of ENTRIES) {
    if (!entry.pattern.test(haystack)) continue
    if (entry.slug === 'simcoe-county') {
      county = entry.slug
      continue
    }
    return entry.slug
  }
  return county
}
