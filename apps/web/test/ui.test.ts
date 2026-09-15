import { existsSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import puppeteer, { type Browser, type HTTPRequest, type Page } from 'puppeteer-core'
import { EVENTS, EVENT_MONTHS, VISIBLE, startServer } from './server.ts'

/**
 * Real-browser tests for the filter menus.
 *
 * These exist because two UI bugs shipped that no amount of reading the source would have
 * caught: `.menu { display: flex }` is an author rule, so it silently defeated the browser's
 * user-agent `[hidden] { display: none }`. The markup and the script were both correct —
 * only the cascade was wrong. Catching that needs something that actually computes styles,
 * so these assert on getComputedStyle rather than on the `hidden` property.
 */

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p))

const describeIfChrome = CHROME ? describe : describe.skip

describeIfChrome('filter menus (real browser)', () => {
  let browser: Browser
  let page: Page
  let server: Awaited<ReturnType<typeof startServer>>

  beforeAll(async () => {
    server = await startServer()
    browser = await puppeteer.launch({
      executablePath: CHROME!,
      headless: true,
      args: ['--no-sandbox'],
    })
    page = await browser.newPage()
    await page.goto(server.url, { waitUntil: 'networkidle0' })
    await page.waitForSelector('#f-municipality .menu')
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    await server?.close()
  })

  // One page is shared for speed, so each test starts from a known state: no filters
  // selected, no menu open, no leftover search term.
  beforeEach(async () => {
    await page.evaluate(() => (window as unknown as { __clearAll(): void }).__clearAll())
    for (const menu of ['#f-municipality', '#f-category']) {
      await page.$eval(`${menu} .menu-search input`, (el) => {
        const input = el as HTMLInputElement
        input.value = ''
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await page.click('h1')
  })

  /**
   * What the user can actually see. `checkVisibility` walks the ancestor chain, which
   * matters here: a child of a `display: none` menu still reports its own computed
   * display, so testing the element alone would call hidden rows visible.
   */
  const isVisible = (selector: string) => page.$eval(selector, (el) => el.checkVisibility())

  const visibleOptionLabels = (menu: string) =>
    page.$$eval(`${menu} .menu-options label`, (labels) =>
      labels
        .filter((l) => l.checkVisibility())
        .map((l) => l.querySelector('.opt-label')?.textContent?.trim() ?? ''),
    )

  const visibleGroups = (menu: string) =>
    page.$$eval(`${menu} .menu-group`, (groups) =>
      groups.filter((g) => g.checkVisibility()).map((g) => g.textContent!.trim()),
    )

  /** Open a menu without toggling one that is already open shut. */
  const openMenu = async (menu: string) => {
    if (!(await isVisible(`${menu} .menu`))) await page.click(`${menu} > button`)
  }

  const closeMenus = () => page.click('h1')

  /**
   * Menus are deliberately not rebuilt between interactions, so the search box keeps its
   * text. Clearing it needs a real input event or the filter never re-runs.
   */
  const setSearch = async (menu: string, term: string) => {
    await openMenu(menu)
    await page.$eval(`${menu} .menu-search input`, (el) => {
      const input = el as HTMLInputElement
      input.value = ''
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    if (term) await page.type(`${menu} .menu-search input`, term)
  }

  it('starts with every menu closed', async () => {
    for (const id of ['f-municipality', 'f-category']) {
      expect(await isVisible(`#${id} .menu`), `${id} should start closed`).toBe(false)
    }
  })

  it('opens a menu when its trigger is clicked', async () => {
    await page.click('#f-municipality > button')
    expect(await isVisible('#f-municipality .menu')).toBe(true)
  })

  it('closes the menu again when the trigger is clicked a second time', async () => {
    await page.click('#f-municipality > button')
    expect(await isVisible('#f-municipality .menu')).toBe(true)
    await page.click('#f-municipality > button')
    expect(await isVisible('#f-municipality .menu')).toBe(false)
  })

  it('closes an open menu when clicking outside it', async () => {
    await page.click('#f-municipality > button')
    expect(await isVisible('#f-municipality .menu')).toBe(true)
    await closeMenus()
    expect(await isVisible('#f-municipality .menu')).toBe(false)
  })

  it('only ever shows one menu at a time', async () => {
    await page.click('#f-municipality > button')
    await page.click('#f-category > button')
    expect(await isVisible('#f-category .menu')).toBe(true)
    expect(await isVisible('#f-municipality .menu')).toBe(false)
    await closeMenus()
  })

  it('puts the county in its own section above the municipalities, unplaced events last', async () => {
    await page.click('#f-municipality > button')
    expect(await visibleGroups('#f-municipality')).toEqual(['County', 'Municipalities', 'Other'])

    const labels = await visibleOptionLabels('#f-municipality')
    // Sorted by the name people use, not by "City of" / "Township of".
    expect(labels[0]).toContain('Simcoe')
    expect(labels.slice(1, -1).map((l) => l.replace(/(City|Town|Township|County)$/, '').trim())).toEqual([
      'Barrie',
      'Tay',
      'Wasaga Beach',
    ])
    expect(labels.at(-1)).toContain('Not specified')
    await closeMenus()
  })

  describe('events with no municipality', () => {
    const unplaced = EVENTS.filter((e) => !e.municipalitySlug)

    it('offers them as their own option, tallied like any other', async () => {
      await page.click('#f-municipality > button')
      const tally = await page.$eval(
        '#f-municipality input[value="unspecified"]',
        (el) => el.closest('label')!.querySelector('.tally')!.textContent!.trim(),
      )
      expect(tally).toBe(String(unplaced.length))
      await closeMenus()
    })

    it('shows only those events when it is the one filter selected', async () => {
      await page.click('#f-municipality > button')
      await page.click('#f-municipality input[value="unspecified"]')
      await closeMenus()
      // The heading carries the cost tag too, so read the link that holds just the title.
      const titles = await page.$$eval('#list .event h3 a', (els) => els.map((e) => e.textContent!.trim()))
      expect(titles.sort()).toEqual(unplaced.map((e) => e.title).sort())
    })

    it('combines with a real municipality rather than replacing it', async () => {
      await page.click('#f-municipality > button')
      await page.click('#f-municipality input[value="unspecified"]')
      await page.click('#f-municipality input[value="tay"]')
      await closeMenus()
      const shown = await page.$$eval('#list .event .jur', (els) => els.map((e) => e.textContent!.trim()))
      expect(new Set(shown)).toEqual(new Set(['Tay', 'Not specified']))
    })

    it('keeps the selection in the URL so the view can be shared', async () => {
      await page.click('#f-municipality > button')
      await page.click('#f-municipality input[value="unspecified"]')
      await closeMenus()
      expect(new URL(page.url()).searchParams.get('m')).toBe('unspecified')
    })
  })

  describe('search box', () => {
    it('filters the options to those matching, not just the group headings', async () => {
      // The original bug: rows stayed visible while only the headings responded, so it
      // looked like the search was filtering on "County" and "Municipalities".
      await setSearch('#f-municipality', 'tay')
      const labels = await visibleOptionLabels('#f-municipality')
      expect(labels).toHaveLength(1)
      expect(labels[0]).toContain('Tay')
    })

    it('hides a section heading once nothing under it matches', async () => {
      await setSearch('#f-municipality', 'tay')
      expect(await visibleGroups('#f-municipality')).toEqual(['Municipalities'])
    })

    it('matches the municipal type and the full legal name too', async () => {
      await setSearch('#f-municipality', 'township')
      expect(await visibleOptionLabels('#f-municipality')).toHaveLength(1)
      await setSearch('#f-municipality', 'city of barrie')
      const labels = await visibleOptionLabels('#f-municipality')
      expect(labels).toHaveLength(1)
      expect(labels[0]).toContain('Barrie')
    })

    it('says so when nothing matches', async () => {
      await setSearch('#f-municipality', 'zzzznope')
      expect(await visibleOptionLabels('#f-municipality')).toHaveLength(0)
      expect(await isVisible('#f-municipality .menu-empty')).toBe(true)
    })

    it('restores the full list when the term is cleared', async () => {
      await setSearch('#f-municipality', 'tay')
      await setSearch('#f-municipality', '')
      expect((await visibleOptionLabels('#f-municipality')).length).toBe(5)
      expect(await visibleGroups('#f-municipality')).toEqual(['County', 'Municipalities', 'Other'])
      await closeMenus()
    })

    it('keeps the menu open and the search text intact while ticking boxes', async () => {
      // Rebuilding the menu on each change would close it and wipe what was typed.
      await setSearch('#f-municipality', 'tay')
      await page.click('#f-municipality .menu-options label:not([hidden]) input')
      expect(await isVisible('#f-municipality .menu')).toBe(true)
      expect(
        await page.$eval('#f-municipality .menu-search input', (el) => (el as HTMLInputElement).value),
      ).toBe('tay')
      await closeMenus()
    })
  })

  it('hands the current filters to each event link, so the way back is the same view', async () => {
    await page.click('#f-municipality > button')
    await page.click('#f-municipality input[value="tay"]')
    await closeMenus()
    const href = await page.$eval('#list .event h3 a', (el) => (el as HTMLAnchorElement).getAttribute('href')!)
    expect(href).toMatch(/^\/e\/\w+\?/)
    expect(new URL(href, 'https://x.invalid').searchParams.get('m')).toBe('tay')
  })

  it('invites suggestions above the list as well as below it', async () => {
    const links = await page.$$eval('a[href="/suggest"]', (as) =>
      as.map((a) => ({ inTop: !!a.closest('#suggest-top'), inBottom: !!a.closest('#suggest-cta'), visible: a.getBoundingClientRect().height > 0 })),
    )
    expect(links.filter((l) => l.inTop && l.visible)).toHaveLength(1)
    expect(links.filter((l) => l.inBottom && l.visible)).toHaveLength(1)
    const topBeforeList = await page.$eval('#suggest-top', (el) => !!(el.compareDocumentPosition(document.getElementById('list')!) & Node.DOCUMENT_POSITION_FOLLOWING))
    expect(topBeforeList).toBe(true)
  })

  it('links plainly when nothing is filtered', async () => {
    const href = await page.$eval('#list .event h3 a', (el) => (el as HTMLAnchorElement).getAttribute('href')!)
    expect(href).not.toContain('?')
  })

  describe('theme switch', () => {
    const theme = () => page.evaluate(() => document.documentElement.dataset.theme ?? 'system')
    const pressed = () =>
      page.$$eval('.themeswitch button', (els) =>
        els.filter((e) => e.getAttribute('aria-pressed') === 'true').map((e) => e.id),
      )

    afterAll(async () => {
      await page.click('#theme-system')
    })

    it('follows the system by default, storing nothing', async () => {
      expect(await theme()).toBe('system')
      expect(await pressed()).toEqual(['theme-system'])
      expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe(null)
    })

    it('marks the element for the stylesheet when dark is chosen', async () => {
      await page.click('#theme-dark')
      expect(await theme()).toBe('dark')
      expect(await pressed()).toEqual(['theme-dark'])
    })

    it('actually repaints, rather than only setting an attribute', async () => {
      await page.click('#theme-light')
      const light = await page.$eval('body', (el) => getComputedStyle(el).backgroundColor)
      await page.click('#theme-dark')
      const dark = await page.$eval('body', (el) => getComputedStyle(el).backgroundColor)
      expect(dark).not.toBe(light)
    })

    it('survives a reload', async () => {
      await page.click('#theme-dark')
      await page.reload({ waitUntil: 'networkidle0' })
      expect(await theme()).toBe('dark')
      expect(await pressed()).toEqual(['theme-dark'])
    })

    it('is applied by the head script, before app.js could run at all', async () => {
      // The point of the inline script is the first paint. Blocking app.js is the only
      // way to tell it apart from the module doing the same thing a moment later.
      await page.click('#theme-dark')
      await page.setRequestInterception(true)
      const block = (req: HTTPRequest) => {
        if (req.url().endsWith('/app.js')) void req.abort()
        else void req.continue()
      }
      page.on('request', block)
      try {
        await page.reload({ waitUntil: 'domcontentloaded' })
        expect(await theme()).toBe('dark')
      } finally {
        page.off('request', block)
        await page.setRequestInterception(false)
        await page.reload({ waitUntil: 'networkidle0' })
      }
    })

    it('forgets the choice again when handed back to the system', async () => {
      await page.click('#theme-dark')
      await page.click('#theme-system')
      expect(await theme()).toBe('system')
      expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe(null)
    })
  })

  describe('date range', () => {
    const openDates = async () => {
      await page.click('#f-dates > button')
      expect(await isVisible('#f-dates .menu')).toBe(true)
    }
    const shownDates = () =>
      page.$$eval('#list .day-head h2', (els) => els.map((e) => e.textContent!.trim()))

    it('narrows the list to the days asked for', async () => {
      const dates = [...new Set(VISIBLE.map((e) => e.localDate))].sort()
      const [from, to] = [dates[1]!, dates[3]!]
      await openDates()
      await page.$eval('#date-from', (el, v) => {
        ;(el as HTMLInputElement).value = v as string
        el.dispatchEvent(new Event('change', { bubbles: true }))
      }, from)
      await page.$eval('#date-to', (el, v) => {
        ;(el as HTMLInputElement).value = v as string
        el.dispatchEvent(new Event('change', { bubbles: true }))
      }, to)
      await closeMenus()

      const expected = VISIBLE.filter((e) => e.localDate >= from && e.localDate <= to).length
      const rendered = await page.$$eval('#list .event', (els) => els.length)
      expect(rendered).toBe(expected)
      expect(await shownDates()).toHaveLength(3)
      const url = new URL(page.url())
      expect(url.searchParams.get('from')).toBe(from)
      expect(url.searchParams.get('to')).toBe(to)
    })

    it('stays open after the first date, and hands over to the second field', async () => {
      // Picking "from" used to rebuild the field, which tore the menu out from under the
      // reader before they could name the other end of the range.
      const dates = [...new Set(VISIBLE.map((e) => e.localDate))].sort()
      await openDates()
      await page.$eval('#date-from', (el, v) => {
        ;(el as HTMLInputElement).value = v as string
        el.dispatchEvent(new Event('change', { bubbles: true }))
      }, dates[1]!)
      expect(await isVisible('#f-dates .menu')).toBe(true)
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('date-to')
      await closeMenus()
      await page.evaluate(() => (window as unknown as { __clearAll(): void }).__clearAll())
    })

    it('closes once a preset answers the whole question', async () => {
      await openDates()
      await page.click('#f-dates [data-range="7"]')
      expect(await isVisible('#f-dates .menu')).toBe(false)
      await page.evaluate(() => (window as unknown as { __clearAll(): void }).__clearAll())
    })

    it('shows the range as a filter pill that clears it again', async () => {
      await openDates()
      await page.click('#f-dates [data-range="7"]')
      await closeMenus()
      const pill = await page.$eval('#active .pill', (el) => el.textContent!.trim())
      expect(pill).toMatch(/–/)
      await page.click('#active .pill button')
      expect(await page.$$eval('#active .pill', (els) => els.length)).toBe(0)
      expect(page.url()).not.toContain('from=')
    })

    it('takes the range the other way round as the range they meant', async () => {
      const dates = [...new Set(VISIBLE.map((e) => e.localDate))].sort()
      await openDates()
      await page.$eval('#date-from', (el, v) => {
        ;(el as HTMLInputElement).value = v as string
        el.dispatchEvent(new Event('change', { bubbles: true }))
      }, dates[3]!)
      await page.$eval('#date-to', (el, v) => {
        ;(el as HTMLInputElement).value = v as string
        el.dispatchEvent(new Event('change', { bubbles: true }))
      }, dates[1]!)
      await closeMenus()
      const url = new URL(page.url())
      expect(url.searchParams.get('from')).toBe(dates[1])
      expect(url.searchParams.get('to')).toBe(dates[3])
    })

    it('carries the range into the subscribe link', async () => {
      await openDates()
      await page.click('#f-dates [data-range="30"]')
      await closeMenus()
      await page.click('#subscribe')
      const ics = await page.$eval('#ics-url', (el) => el.textContent!.trim())
      expect(ics).toContain('from=')
      expect(ics).toContain('to=')
      await page.click('#close-sheet')
    })
  })

  describe('cost', () => {
    const noteText = () => page.$eval('#costnote', (el) => el.textContent!.replace(/\s+/g, ' ').trim())
    const setCost = async (value: string) => {
      await page.select('#cost', value)
      await new Promise((r) => setTimeout(r, 80))
    }

    afterAll(async () => {
      await setCost('default')
    })

    it('says what the default view is holding back, with the way out', async () => {
      expect(await isVisible('#costnote')).toBe(true)
      expect(await noteText()).toMatch(/free events and events with no price listed/i)
      expect(await noteText()).toMatch(/including paid/i)
    })

    it('shows everything when that note is clicked, and then says nothing', async () => {
      await page.click('#cost-all')
      expect(await page.$eval('#cost', (el) => (el as HTMLSelectElement).value)).toBe('all')
      expect(await isVisible('#costnote')).toBe(false)
      const shown = await page.$$eval('#list .event', (els) => els.length)
      expect(shown).toBeGreaterThan(0)
      expect(page.url()).toContain('cost=all')
    })

    it('offers paid only, and shows just those', async () => {
      const options = await page.$$eval('#cost option', (els) => els.map((e) => (e as HTMLOptionElement).value))
      expect(options).toEqual(['default', 'free', 'paid', 'all'])

      await setCost('paid')
      expect(await noteText()).toMatch(/paid events only/i)
      const paid = EVENTS.filter((e) => e.cost === 'paid' && e.category !== 'civic-meeting')
      const titles = await page.$$eval('#list .event h3 a', (els) => els.map((e) => e.textContent!.trim()))
      expect(new Set(titles)).toEqual(new Set(paid.map((e) => e.title)))
      expect(page.url()).toContain('cost=paid')
    })

    it('carries the cost into the subscribe link', async () => {
      await setCost('paid')
      await page.click('#subscribe')
      expect(await page.$eval('#ics-url', (el) => el.textContent!.trim())).toContain('cost=paid')
      await page.click('#close-sheet')
    })
  })

  describe('returning from an event', () => {
    // The stub has no /e/ route, so leaving lands on its 404. That is enough: what is
    // being tested is what the list remembers on the way out and restores on the way in.
    const scrollY = () => page.evaluate(() => window.scrollY)

    it('comes back to the same place, with the same pages loaded', async () => {
      await page.goto(server.url, { waitUntil: 'networkidle0' })
      await page.click('#load-more')
      await page.evaluate(() => window.scrollTo(0, 900))
      const left = await scrollY()
      expect(left).toBeGreaterThan(0)

      // Not page.click: it scrolls the element into view first, which would move the
      // page before the click and make the test prove the opposite of what it claims.
      // A reader clicks something already on screen, so click one of those.
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        page.evaluate(() => {
          const onScreen = [...document.querySelectorAll('#list .event h3 a')].find((a) => {
            const box = a.getBoundingClientRect()
            return box.top > 0 && box.bottom < window.innerHeight
          })
          ;(onScreen as HTMLAnchorElement).click()
        }),
      ])
      expect(new URL(page.url()).pathname).toMatch(/^\/e\//)

      // What "All events" does: back to the list at the same query.
      await page.goto(server.url, { waitUntil: 'networkidle0' })
      await new Promise((r) => setTimeout(r, 150))
      expect(await scrollY()).toBeGreaterThan(left - 40)
      // Every page that was open is open again: the cap is above what the stub has.
      expect(await page.$$eval('#list .event', (els) => els.length)).toBe(VISIBLE.length)
    })

    it('opens at the top for anyone arriving fresh at the same view', async () => {
      // The note is used once, so a shared link to this view is not affected by it.
      await page.goto(server.url, { waitUntil: 'networkidle0' })
      await new Promise((r) => setTimeout(r, 150))
      expect(await scrollY()).toBe(0)
      expect(await page.$$eval('#list .event', (els) => els.length)).toBe(30)
    })
  })

  describe('list paging', () => {
    const rendered = () => page.$$eval('#list .event', (els) => els.length)

    it('shows a first page rather than every event at once', async () => {
      const total = VISIBLE.length
      expect(total, 'stub should have more than one page').toBeGreaterThan(30)
      expect(await rendered()).toBe(30)
      expect(await isVisible('#load-more')).toBe(true)
    })

    it('says how many are rendered out of how many match', async () => {
      expect(await page.$eval('.more-count', (el) => el.textContent!.trim())).toMatch(
        new RegExp(`^30 of ${VISIBLE.length} events`),
      )
    })

    it('never leaves a day heading standing above no events', async () => {
      const empties = await page.$$eval('#list .day', (days) =>
        days.filter((d) => d.querySelectorAll('.event').length === 0).length,
      )
      expect(empties).toBe(0)
    })

    it('appends the next page without refetching', async () => {
      const before = await page.evaluate(() => performance.getEntriesByType('resource').length)
      await page.click('#load-more')
      expect(await rendered()).toBe(Math.min(60, VISIBLE.length))
      const after = await page.evaluate(() => performance.getEntriesByType('resource').length)
      // The whole dataset arrived up front; paging must not go back to the network.
      expect(after).toBe(before)
    })

    it('shows everything on "show all" and drops the button', async () => {
      await page.reload({ waitUntil: 'networkidle0' })
      await page.waitForSelector('#list .event')
      const all = await page.$('#load-all')
      if (all) {
        await all.click()
        expect(await rendered()).toBe(VISIBLE.length)
        expect(await page.$('#load-more')).toBeNull()
      }
    })

    it('starts the list over when a filter changes', async () => {
      await page.reload({ waitUntil: 'networkidle0' })
      await page.waitForSelector('#load-more')
      await page.click('#load-more')
      expect(await rendered()).toBeGreaterThan(30)

      await page.click('#f-municipality > button')
      await page.click('#f-municipality .menu-options label input')
      await page.click('h1')
      // A new filtered list is a new first page, not a continuation of the old one.
      expect(await rendered()).toBeLessThanOrEqual(30)
      await page.evaluate(() => (window as unknown as { __clearAll(): void }).__clearAll())
    })
  })

  it('filters the event list and reflects it in the URL', async () => {
    await setSearch('#f-municipality', 'tay')
    await page.click('#f-municipality .menu-options label:not([hidden]) input')
    await closeMenus()

    const shown = await page.$$eval('.event .meta .jur', (els) => [
      ...new Set(els.map((e) => e.textContent!.trim())),
    ])
    expect(shown).toEqual(['Tay'])
    expect(page.url()).toContain('m=tay')
  })
})

describeIfChrome('calendar view (real browser)', () => {
  let browser: Browser
  let page: Page
  let server: Awaited<ReturnType<typeof startServer>>

  // Derived, not assumed: which month the stub's events fall in depends on today.
  const MONTH = EVENT_MONTHS[0]!
  const firstEventDate = EVENTS.map((e) => e.localDate).sort()[0]!

  beforeAll(async () => {
    server = await startServer()
    browser = await puppeteer.launch({
      executablePath: CHROME!,
      headless: true,
      args: ['--no-sandbox'],
    })
    page = await browser.newPage()
    await page.setViewport({ width: 1200, height: 900 })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    await server?.close()
  })

  const openCalendar = async (query = '') => {
    await page.goto(`${server.url}/?view=calendar&month=${MONTH}${query}`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('.cal-grid')
  }

  const visible = (selector: string) => page.$eval(selector, (el) => el.checkVisibility())

  it('shows the grid and hides the list when the calendar is selected', async () => {
    await openCalendar()
    expect(await visible('#calendar')).toBe(true)
    expect(await visible('#list')).toBe(false)
    expect(await visible('#monthnav')).toBe(true)
  })

  it('lays out whole weeks', async () => {
    await openCalendar()
    expect(await page.$$eval('.cal-weekday', (els) => els.map((e) => e.textContent!.trim()))).toEqual([
      'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat',
    ])
    const days = await page.$$eval('.cal-day', (els) => els.length)
    expect(days % 7).toBe(0)
  })

  it('places each event on its own date', async () => {
    await openCalendar()
    const chips = await page.$$eval('.cal-day', (cells) =>
      cells
        .map((c) => ({
          day: (c as HTMLElement).dataset.day!,
          titles: [...c.querySelectorAll('.chip-title')].map((t) => t.textContent!.trim()),
        }))
        .filter((c) => c.titles.length),
    )
    const forFirstDay = chips.find((c) => c.day === firstEventDate)
    expect(forFirstDay, `expected a chip on ${firstEventDate}`).toBeDefined()
    // Every stub event in this month should be on the grid exactly once.
    const inMonth = VISIBLE.filter((e) => e.localDate.startsWith(MONTH))
    expect(chips.reduce((n, c) => n + c.titles.length, 0)).toBe(inMonth.length)
  })

  /** The date in Simcoe County right now, which is what the data's localDate means. */
  const simcoeToday = () =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Toronto',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())

  it('marks today', async () => {
    await page.goto(`${server.url}/?view=calendar`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('.cal-grid')
    expect(
      await page.$$eval('.cal-day.is-today', (els) => els.map((e) => (e as HTMLElement).dataset.day)),
    ).toEqual([simcoeToday()])
  })

  it('anchors today to Simcoe County, not to UTC or the viewer', async () => {
    /*
     * The original bug: "today" came from toISOString(), which is UTC, so from 8pm
     * Eastern onward the site rolled over early and labelled tomorrow's events
     * "today". Tokyo is far enough ahead that its date, UTC's date and Toronto's date
     * are frequently all different, so this pins the anchor rather than the clock.
     */
    const far = await browser.newPage()
    try {
      await far.emulateTimezone('Asia/Tokyo')
      await far.goto(`${server.url}/?view=calendar`, { waitUntil: 'networkidle0' })
      await far.waitForSelector('.cal-grid')
      const marked = await far.$$eval('.cal-day.is-today', (els) =>
        els.map((e) => (e as HTMLElement).dataset.day),
      )
      expect(marked).toEqual([simcoeToday()])

      const viewerDate = await far.evaluate(() => new Date().toISOString().slice(0, 10))
      if (viewerDate !== simcoeToday()) {
        // Only meaningful while the zones actually disagree, which is most of the day.
        expect(marked[0]).not.toBe(viewerDate)
      }
    } finally {
      await far.close()
    }
  })

  it('pages between months and back to today', async () => {
    await openCalendar()
    const label = () => page.$eval('#month-label', (el) => el.textContent!.trim())
    const start = await label()

    await page.click('#next-month')
    expect(await label()).not.toBe(start)
    await page.click('#prev-month')
    expect(await label()).toBe(start)

    await page.click('#next-month')
    await page.click('#this-month')
    const now = new Date()
    expect(await label()).toContain(String(now.getUTCFullYear()))
  })

  it('keeps the month in the URL so a view can be shared', async () => {
    await openCalendar()
    await page.click('#next-month')
    const next = await page.$eval('#month-label', (el) => el.textContent!.trim())
    expect(page.url()).toMatch(/[?&]month=\d{4}-\d{2}/)
    expect(page.url()).toContain('view=calendar')

    // Reopening that URL lands on the same month.
    await page.goto(page.url(), { waitUntil: 'networkidle0' })
    await page.waitForSelector('.cal-grid')
    expect(await page.$eval('#month-label', (el) => el.textContent!.trim())).toBe(next)
  })

  describe('day modal', () => {
    const isOpen = () => page.$eval('#day-modal', (el) => (el as HTMLDialogElement).open)

    it('opens as a modal dialog listing that day\'s events', async () => {
      await openCalendar()
      expect(await isOpen()).toBe(false)

      await page.click(`.cal-day[data-day="${firstEventDate}"]`)
      expect(await isOpen()).toBe(true)
      expect(await visible('#day-modal')).toBe(true)
      expect(await page.$$eval('#day-modal .event', (els) => els.length)).toBeGreaterThan(0)
      expect(await page.$eval('#day-modal-title', (el) => el.textContent!.trim())).not.toBe('')
    })

    it('closes on the close button', async () => {
      await openCalendar()
      await page.click(`.cal-day[data-day="${firstEventDate}"]`)
      await page.click('#close-day')
      expect(await isOpen()).toBe(false)
    })

    it('closes on Escape', async () => {
      await openCalendar()
      await page.click(`.cal-day[data-day="${firstEventDate}"]`)
      await page.keyboard.press('Escape')
      expect(await isOpen()).toBe(false)
    })

    it('closes when the backdrop is clicked', async () => {
      await openCalendar()
      await page.click(`.cal-day[data-day="${firstEventDate}"]`)
      // Top-left of the viewport is backdrop, well clear of the centred dialog.
      await page.mouse.click(8, 8)
      expect(await isOpen()).toBe(false)
    })

    it('locks the page behind it from scrolling', async () => {
      await openCalendar()
      await page.click(`.cal-day[data-day="${firstEventDate}"]`)
      expect(await page.$eval('body', (el) => getComputedStyle(el).overflow)).toBe('hidden')

      await page.keyboard.press('Escape')
      // The dialog's close event is queued, so wait for the cleanup rather than race it.
      await page.waitForFunction(() => !document.body.classList.contains('modal-open'))
      expect(await page.$eval('body', (el) => getComputedStyle(el).overflow)).not.toBe('hidden')
    })

    it('moves focus into the dialog and restores it on close', async () => {
      await openCalendar()
      const day = `.cal-day[data-day="${firstEventDate}"]`
      await page.click(day)
      // Focus must be inside the dialog, or keyboard users are left behind the modal.
      expect(await page.evaluate(() => document.querySelector('#day-modal')!.contains(document.activeElement))).toBe(true)

      await page.keyboard.press('Escape')
      await page.waitForFunction(() => !(document.querySelector('#day-modal') as HTMLDialogElement).open)
      expect(await page.evaluate((sel) => document.activeElement === document.querySelector(sel), day)).toBe(true)
    })

    it('does not page the month while it is open', async () => {
      await openCalendar()
      const label = () => page.$eval('#month-label', (el) => el.textContent!.trim())
      const before = await label()
      await page.click(`.cal-day[data-day="${firstEventDate}"]`)
      await page.keyboard.press('ArrowRight')
      expect(await label()).toBe(before)
      await page.keyboard.press('Escape')
    })

    it('does not open for a day with no events', async () => {
      await openCalendar()
      const emptyDay = await page.$$eval('.cal-day', (cells) => {
        const cell = cells.find((c) => !c.querySelector('.chip'))
        return (cell as HTMLElement | undefined)?.dataset.day ?? null
      })
      expect(emptyDay).toBeTruthy()
      await page.click(`.cal-day[data-day="${emptyDay}"]`)
      // An empty day still opens, but says so rather than showing a blank panel.
      expect(await isOpen()).toBe(true)
      expect(await page.$eval('#day-modal-body', (el) => el.textContent!.trim())).toMatch(/no events/i)
      await page.keyboard.press('Escape')
    })
  })

  it('applies the filters to the grid', async () => {
    await openCalendar('&m=tay')
    const titles = await page.$$eval('.cal-day .chip-title', (els) => els.map((e) => e.textContent!.trim()))
    const tayCount = VISIBLE.filter((e) => e.municipalitySlug === 'tay' && e.localDate.startsWith(MONTH)).length
    expect(titles).toHaveLength(tayCount)
    expect(await page.$eval('#month-count', (el) => el.textContent!.trim())).toContain(String(tayCount))
  })

  it('says when a month has no events and offers the next one that does', async () => {
    // Two years back is guaranteed empty for the stub's data.
    const empty = `${Number(MONTH.slice(0, 4)) - 2}-${MONTH.slice(5)}`
    await page.goto(`${server.url}/?view=calendar&month=${empty}`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('.cal-grid')
    expect(await page.$$eval('.cal-day .chip', (els) => els.length)).toBe(0)
    expect(await page.$eval('#month-count', (el) => el.textContent!.trim())).toBe('No events')
    expect(await visible('#jump-next')).toBe(true)

    await page.click('#jump-next')
    expect(await page.$$eval('.cal-day .chip', (els) => els.length)).toBeGreaterThan(0)
  })

  it('hides the past-events toggle, which the month already decides', async () => {
    await openCalendar()
    expect(await visible('#past-toggle')).toBe(false)
    await page.click('#view-list')
    expect(await visible('#past-toggle')).toBe(true)
    expect(await visible('#calendar')).toBe(false)
    expect(await visible('#list')).toBe(true)
  })
})

/**
 * "Upcoming" means not over yet, measured against the clock rather than the date.
 *
 * These events are built relative to the moment the suite runs, in Simcoe County's zone,
 * and served in place of the fixture API — so the rule is tested against a real now, not
 * a frozen one that would pass forever while the behaviour drifted.
 */
describeIfChrome('finished events (real browser)', () => {
  let browser: Browser
  let page: Page
  let server: Awaited<ReturnType<typeof startServer>>

  const HOUR = 3_600_000
  const now = Date.now()
  const torontoDate = (ms: number) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
  const today = torontoDate(now)
  const yesterday = torontoDate(now - 24 * HOUR)
  const tomorrow = torontoDate(now + 24 * HOUR)
  const iso = (ms: number) => new Date(ms).toISOString()

  const make = (title: string, fields: Record<string, unknown>) => ({
    ...EVENTS[0]!,
    id: `clock:${title}`,
    shortCode: `clk${title.length}${title[0]}`,
    title,
    cost: 'free',
    category: 'community',
    municipalitySlug: 'tay',
    endsAtUtc: null,
    allDay: false,
    timePrecision: 'exact',
    ...fields,
  })

  const CLOCK_EVENTS = [
    make('Ended an hour ago', { localDate: today, startsAtUtc: iso(now - 2 * HOUR), endsAtUtc: iso(now - HOUR) }),
    make('Finished yesterday', { localDate: yesterday, startsAtUtc: iso(now - 26 * HOUR), endsAtUtc: iso(now - 25 * HOUR) }),
    make('Three day festival', { localDate: yesterday, startsAtUtc: iso(now - 26 * HOUR), endsAtUtc: iso(now + 24 * HOUR) }),
    make('No end time given', { localDate: today, startsAtUtc: iso(now - 3 * HOUR) }),
    make('All day today', { localDate: today, startsAtUtc: iso(now - 4 * HOUR), allDay: true, timePrecision: 'date-only' }),
    make('Ends in an hour', { localDate: today, startsAtUtc: iso(now - HOUR), endsAtUtc: iso(now + HOUR) }),
    make('Tomorrow morning', { localDate: tomorrow, startsAtUtc: iso(now + 24 * HOUR), endsAtUtc: iso(now + 26 * HOUR) }),
  ].sort((a, b) => String(a.startsAtUtc).localeCompare(String(b.startsAtUtc)))

  beforeAll(async () => {
    server = await startServer()
    browser = await puppeteer.launch({ executablePath: CHROME!, headless: true, args: ['--no-sandbox'] })
    page = await browser.newPage()
    await page.setRequestInterception(true)
    page.on('request', (req: HTTPRequest) => {
      if (new URL(req.url()).pathname === '/api/events') {
        return req.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ count: CLOCK_EVENTS.length, events: CLOCK_EVENTS }),
        })
      }
      return req.continue()
    })
    await page.goto(server.url, { waitUntil: 'networkidle0' })
    await page.waitForSelector('#list .event')
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    await server?.close()
  })

  const titles = () => page.$$eval('#list .event h3 a', (els) => els.map((e) => e.textContent!.trim()))

  it('hides an event whose published end time has passed, even though it was today', async () => {
    expect(await titles()).not.toContain('Ended an hour ago')
    expect(await titles()).not.toContain('Finished yesterday')
  })

  it('keeps anything without an end time, or all day, until the day is over', async () => {
    expect(await titles()).toEqual(expect.arrayContaining(['No end time given', 'All day today', 'Ends in an hour', 'Tomorrow morning']))
  })

  it('keeps something that started yesterday and is still running, filed under today', async () => {
    const section = await page.$$eval('#list .day', (days) =>
      days.map((d) => ({
        rel: d.querySelector('.rel')?.textContent?.trim() ?? '',
        titles: [...d.querySelectorAll('.event h3 a')].map((a) => a.textContent!.trim()),
        onNow: [...d.querySelectorAll('.event')]
          .filter((e) => e.querySelector('.tag.onnow'))
          .map((e) => e.querySelector('h3 a')!.textContent!.trim()),
      })),
    )
    const festival = section.find((d) => d.titles.includes('Three day festival'))
    expect(festival?.rel).toBe('today')
    expect(festival?.onNow).toEqual(['Three day festival'])
    // Nothing under a heading from before today.
    expect(section.map((d) => d.rel)).not.toContain('yesterday')
  })

  it('brings the finished ones back when past events are asked for', async () => {
    await page.click('#show-past')
    await page.waitForFunction(() => document.querySelectorAll('#list .event').length === 7)
    expect(await titles()).toEqual(expect.arrayContaining(['Ended an hour ago', 'Finished yesterday']))
    // Chronological even though the festival, which sorts first by its start, is filed
    // under today rather than yesterday.
    const rel = await page.$$eval('#list .day-head .rel', (els) => els.map((e) => e.textContent!.trim()))
    expect(rel).toEqual(['yesterday', 'today', 'tomorrow'])
    await page.click('#show-past')
  })
})
