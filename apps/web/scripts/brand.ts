/**
 * Renders the brand assets — icon.svg, favicon-32.png, apple-touch-icon.png, icon-512.png
 * and the 1200x630 og.png — from one HTML template using the system Chrome, so the mark
 * on the page, in the tab and in a share card is drawn from the same source.
 *
 *   node --experimental-strip-types apps/web/scripts/brand.ts
 */
import { existsSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p))
if (!CHROME) throw new Error('No Chrome found to render the brand assets')

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url))

/**
 * The palette, repeated from style.css because a screenshot cannot read CSS variables.
 * When the accent changes there, change it here and re-run this script.
 */
const BG = '#fdf7ed'
const INK = '#231c13'
const ACCENT = '#e05a17'
const ACCENT_DEEP = '#a63f09'
const SUN = '#f4b23c'
const PAPER = '#fffdf8'

/** Fraunces, from the copy the site serves, so the card matches the masthead. */
const FONT_CSS = `@font-face {
  font-family: 'Fraunces';
  font-weight: 600 900;
  src: url('file://${PUBLIC}fonts/fraunces-latin.woff2') format('woff2');
}`

/** The mark: a sun over a field. Same paths as index.html and the event page. */
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

const OG = `<!doctype html><html><head><meta charset="utf-8"><style>
  ${FONT_CSS}
  body { margin: 0; width: 1200px; height: 630px; background: ${BG}; color: ${INK};
         font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; display: flex; align-items: center; }
  .card { display: flex; align-items: center; gap: 56px; padding: 0 96px; }
  .text h1 {
    font-family: 'Fraunces', Georgia, serif; font-variation-settings: 'SOFT' 100, 'WONK' 1, 'opsz' 144;
    font-weight: 800; font-size: 82px; margin: 0 0 18px; letter-spacing: -0.02em; line-height: 1.02;
  }
  .text p { font-size: 33px; margin: 0; color: #5d5245; line-height: 1.3; max-width: 760px; }
  .accent { color: ${ACCENT_DEEP};
            background: linear-gradient(transparent 62%, ${SUN}99 62% 92%, transparent 92%); }
  /* The bunting from the masthead, along the foot of the card. */
  .bunting { position: absolute; left: 0; right: 0; bottom: 0; height: 14px;
    background: linear-gradient(90deg, #7c3aed 0 10%, #d6336c 10% 22%, #e8590c 22% 36%,
      #2f9e44 36% 50%, #dc8a00 50% 63%, #1971c2 63% 76%, #0f7b8a 76% 88%, #5f3dc4 88% 100%); }
</style></head><body><div class="card">
  ${mark(260, ACCENT, PAPER, SUN)}
  <div class="text"><h1>Simcoe County <span class="accent">Events</span></h1>
  <p>Free things to do across the county, gathered from every town's calendar and local news — in one place.</p></div>
</div><div class="bunting"></div></body></html>`

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage()

writeFileSync(`${PUBLIC}icon.svg`, mark(48, ACCENT, PAPER, SUN).trim())

for (const [file, size] of [['favicon-32.png', 32], ['apple-touch-icon.png', 180], ['icon-512.png', 512]] as const) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 })
  await page.setContent(`<body style="margin:0;background:transparent">${mark(size, ACCENT, PAPER, SUN)}</body>`)
  await page.screenshot({ path: `${PUBLIC}${file}`, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } })
}

await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 })
await page.setContent(OG)
// Without this the card renders in Georgia: setContent resolves before the face loads.
await page.evaluate(() => document.fonts.ready)
await page.screenshot({ path: `${PUBLIC}og.png`, clip: { x: 0, y: 0, width: 1200, height: 630 } })

await browser.close()
console.log('brand assets written to', PUBLIC)
