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

/** The mark: a sun over a field. Same paths as index.html and the event page. */
const mark = (size: number, bg: string, ink: string, accent: string): string => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="${size}" height="${size}">
  <rect width="48" height="48" rx="10" fill="${bg}"/>
  <circle cx="24" cy="19" r="8" fill="${accent}"/>
  <path d="M6 38 Q24 26 42 38" stroke="${ink}" stroke-width="4" stroke-linecap="round" fill="none"/>
  <path d="M24 4v4M9 10l3 3M39 10l-3 3M4 22h4M40 22h4" stroke="${accent}" stroke-width="3" stroke-linecap="round"/>
</svg>`

const OG = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; width: 1200px; height: 630px; background: #f7f6f3; color: #1b1a17;
         font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; display: flex; align-items: center; }
  .card { display: flex; align-items: center; gap: 56px; padding: 0 96px; }
  .text h1 { font-size: 78px; margin: 0 0 18px; letter-spacing: -0.02em; line-height: 1.02; }
  .text p { font-size: 34px; margin: 0; color: #55524c; line-height: 1.3; max-width: 760px; }
  .accent { color: #8a3b12; }
</style></head><body><div class="card">
  ${mark(260, '#8a3b12', '#f7f6f3', '#f0a06a')}
  <div class="text"><h1>Simcoe County <span class="accent">Events</span></h1>
  <p>Free things to do across the county, gathered from every town's calendar and local news — in one place.</p></div>
</div></body></html>`

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage()

writeFileSync(`${PUBLIC}icon.svg`, mark(48, '#8a3b12', '#f7f6f3', '#f0a06a').trim())

for (const [file, size] of [['favicon-32.png', 32], ['apple-touch-icon.png', 180], ['icon-512.png', 512]] as const) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 })
  await page.setContent(`<body style="margin:0;background:transparent">${mark(size, '#8a3b12', '#f7f6f3', '#f0a06a')}</body>`)
  await page.screenshot({ path: `${PUBLIC}${file}`, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } })
}

await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 })
await page.setContent(OG)
await page.screenshot({ path: `${PUBLIC}og.png`, clip: { x: 0, y: 0, width: 1200, height: 630 } })

await browser.close()
console.log('brand assets written to', PUBLIC)
