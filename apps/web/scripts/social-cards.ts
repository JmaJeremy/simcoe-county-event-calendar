/**
 * Renders the Instagram cards the social poster attaches to its posts: one 1080x1080 JPEG per
 * category in three colourways, into public/social/{category}-{0,1,2}.jpg. The web worker
 * serves public/ straight from the edge, so Meta can fetch a card with no route of our own.
 *
 *   node --experimental-strip-types apps/web/scripts/social-cards.ts
 *
 * Cloned from brand.ts, with one difference that matters: Instagram takes JPEG only, so every
 * screenshot here is `type: 'jpeg'`. The poster picks the colourway by hashing the post's key,
 * so two posts in a row rarely look alike. `other` is also the card for anything unmapped.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p))
if (!CHROME) throw new Error('No Chrome found to render the social cards')

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url))
const OUT = `${PUBLIC}social/`

/**
 * The palette, repeated from style.css (and brand.ts) because a screenshot cannot read CSS
 * variables. Change the category colours there, change them here, and re-run this script.
 */
const BG = '#fdf7ed'
const INK = '#231c13'
const INK_2 = '#5d5245'
const NIGHT = '#1e1a17'
const ACCENT = '#e05a17'
const SUN = '#f4b23c'
const PAPER = '#fffdf8'

/** Labels as the site's filter menu writes them (CATEGORY_LABELS in app.js). */
const CATEGORIES = {
  arts: { label: 'Arts & culture', colour: '#7c3aed' },
  music: { label: 'Music', colour: '#d6336c' },
  family: { label: 'Family & kids', colour: '#e8590c' },
  outdoors: { label: 'Outdoors', colour: '#2f9e44' },
  markets: { label: 'Markets & sales', colour: '#dc8a00' },
  sports: { label: 'Sports & fitness', colour: '#1971c2' },
  community: { label: 'Community', colour: '#0f7b8a' },
  education: { label: 'Talks & workshops', colour: '#5f3dc4' },
  other: { label: 'What’s on', colour: '#96825f' },
} as const
type Category = keyof typeof CATEGORIES

/** Mix a colour towards black (amount > 0) or white (amount < 0). */
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16)
  const target = amount > 0 ? 0 : 255
  const a = Math.abs(amount)
  const mix = (c: number) => Math.round(c + (target - c) * a).toString(16).padStart(2, '0')
  return `#${mix(n >> 16)}${mix((n >> 8) & 255)}${mix(n & 255)}`
}

/**
 * One glyph per category on a 100-unit square. Strokes take the glyph colour; `.f` parts are
 * filled with it; `.s` parts take the sun, so every card carries a little of the mark's warmth.
 */
const GLYPHS: Record<Category, string> = {
  arts: `<path d="M50 12C27 12 10 28 10 48c0 20 16 34 34 34 6 0 8-4 8-8s-3-6-3-10 3-7 8-7h10c12 0 23-8 23-22C90 23 72 12 50 12Z"/>
    <circle class="s" cx="30" cy="44" r="6"/><circle class="f" cx="44" cy="28" r="6"/><circle class="f" cx="64" cy="29" r="6"/><circle class="s" cx="76" cy="45" r="6"/>`,
  music: `<circle class="f" cx="30" cy="76" r="11"/><circle class="f" cx="72" cy="68" r="11"/>
    <path d="M40 76V26L82 18v50"/><path class="f" d="M40 24l42-8v12l-42 8Z"/>`,
  family: `<circle cx="36" cy="26" r="11"/><circle class="s" cx="70" cy="46" r="8"/>
    <path d="M18 90V64c0-11 8-20 18-20s18 9 18 20v26"/><path d="M58 90V76c0-8 5-14 12-14s12 6 12 14v14"/>`,
  outdoors: `<circle class="s" cx="76" cy="22" r="9"/>
    <path class="f" d="M40 12 66 56H54L72 84H8L26 56H14Z"/><path d="M40 84v8"/>`,
  markets: `<path class="f" d="M12 40 20 14h60l8 26Z"/><path d="M20 40v48M80 40v48M10 88h80"/>
    <circle class="s" cx="38" cy="78" r="7"/><circle class="f" cx="50" cy="76" r="7"/><circle class="s" cx="62" cy="78" r="7"/>`,
  sports: `<circle cx="50" cy="50" r="38"/><path d="M50 12v76M12 50h76"/>
    <path d="M24 22c12 16 12 40 0 56M76 22c-12 16-12 40 0 56"/>`,
  community: `<path d="M10 88V54l24-20 24 20v34Z"/><path d="M58 88V62l18-15 16 13"/><path class="f" d="M28 88V70h12v18Z"/>
    <circle class="s" cx="76" cy="20" r="8"/>`,
  education: `<path d="M50 28C40 20 24 18 10 22v58c14-4 30-2 40 6 10-8 26-10 40-6V22c-14-4-30-2-40 6Zm0 0v58"/>
    <path class="s" d="M62 10h14v26l-7-6-7 6Z"/>`,
  other: `<path class="f" d="M50 8c4 24 18 38 42 42-24 4-38 18-42 42-4-24-18-38-42-42 24-4 38-18 42-42Z"/>
    <circle class="s" cx="82" cy="18" r="6"/><circle class="s" cx="18" cy="82" r="5"/>`,
}

interface Colourway {
  bg: string
  ink: string
  sub: string
  glyph: string
  word: string
}

/** 0: the category's own colour as the field. 1: the site's paper. 2: night. */
const colourways = (colour: string): Colourway[] => [
  { bg: shade(colour, 0.28), ink: PAPER, sub: shade(colour, -0.72), glyph: PAPER, word: PAPER },
  { bg: BG, ink: INK, sub: INK_2, glyph: colour, word: shade(colour, 0.22) },
  { bg: NIGHT, ink: PAPER, sub: '#cfc4b4', glyph: shade(colour, -0.3), word: shade(colour, -0.45) },
]

/** The mark, as in brand.ts: a sun over a field. */
const mark = (size: number, bg: string, ink: string, accent: string): string => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="${size}" height="${size}">
  <defs><clipPath id="r"><rect width="48" height="48" rx="10"/></clipPath></defs>
  <g clip-path="url(#r)">
    <rect width="48" height="48" fill="${bg}"/>
  <circle cx="24" cy="19" r="7.5" fill="${accent}"/>
  <path d="M24 4.5v4M11 11l2.9 2.9M37 11l-2.9 2.9M4.5 21h4M39.5 21h4" stroke="${accent}" stroke-width="3" stroke-linecap="round"/>
  <path d="M0 48V37c6.5-4.5 11-1 16.5-3.5S27 26 33 29.5 42 37 48 33.5V48Z" fill="${ink}"/>
  </g>
</svg>`

const FONT_CSS = `@font-face {
  font-family: 'Fraunces';
  font-weight: 600 900;
  src: url('file://${PUBLIC}fonts/fraunces-latin.woff2') format('woff2');
}`

const card = (category: Category, c: Colourway): string => `<!doctype html><html><head><meta charset="utf-8"><style>
  ${FONT_CSS}
  body { margin: 0; width: 1080px; height: 1080px; background: ${c.bg}; color: ${c.ink}; overflow: hidden;
         font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; position: relative; }
  .brand { position: absolute; top: 72px; left: 80px; display: flex; align-items: center; gap: 24px; }
  .brand b { font-family: 'Fraunces', Georgia, serif; font-variation-settings: 'SOFT' 100, 'WONK' 1, 'opsz' 144;
             font-weight: 800; font-size: 50px; letter-spacing: -0.01em; }
  .glyph { position: absolute; top: 250px; left: 80px; width: 330px; height: 330px; }
  .glyph * { fill: none; stroke: ${c.glyph}; stroke-width: 6; stroke-linecap: round; stroke-linejoin: round; }
  .glyph .f { fill: ${c.glyph}; stroke: none; }
  .glyph .s { fill: ${SUN}; stroke: none; }
  .word { position: absolute; left: 80px; right: 80px; top: 640px;
          font-family: 'Fraunces', Georgia, serif; font-variation-settings: 'SOFT' 100, 'WONK' 1, 'opsz' 144;
          font-weight: 800; font-size: 118px; line-height: 1; letter-spacing: -0.025em; color: ${c.word}; }
  .sub { position: absolute; left: 80px; bottom: 112px; font-size: 38px; color: ${c.sub}; }
  .sub b { color: ${c.ink}; font-weight: 700; }
  .bunting { position: absolute; left: 0; right: 0; bottom: 0; height: 22px;
    background: linear-gradient(90deg, #7c3aed 0 10%, #d6336c 10% 22%, #e8590c 22% 36%,
      #2f9e44 36% 50%, #dc8a00 50% 63%, #1971c2 63% 76%, #0f7b8a 76% 88%, #5f3dc4 88% 100%); }
</style></head><body>
  <div class="brand">${mark(92, ACCENT, PAPER, SUN)}<b>Out in Simcoe</b></div>
  <svg class="glyph" viewBox="0 0 100 100">${GLYPHS[category]}</svg>
  <div class="word">${CATEGORIES[category].label}</div>
  <div class="sub">Things to do across Simcoe County · <b>outinsimcoe.ca</b></div>
  <div class="bunting"></div>
</body></html>`

mkdirSync(OUT, { recursive: true })
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 1 })

for (const category of Object.keys(CATEGORIES) as Category[]) {
  const ways = colourways(CATEGORIES[category].colour)
  for (const [i, way] of ways.entries()) {
    await page.setContent(card(category, way))
    // Without this the word renders in Georgia: setContent resolves before the face loads.
    await page.evaluate(() => document.fonts.ready)
    // JPEG, never PNG: Instagram's content publishing takes JPEG only.
    await page.screenshot({ path: `${OUT}${category}-${i}.jpg`, type: 'jpeg', quality: 88, clip: { x: 0, y: 0, width: 1080, height: 1080 } })
  }
}

await browser.close()
console.log('social cards written to', OUT)
