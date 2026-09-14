/**
 * Out in Simcoe front end.
 *
 * The whole upcoming dataset is a few hundred KB, so it is fetched once and every filter
 * runs in the browser — instant, with no round trip per keystroke. Filter state lives in
 * the URL so any view can be copied to someone else or bookmarked.
 */

const state = {
  events: [],
  municipalities: new Map(),
  filters: { m: new Set(), cat: new Set() },
  /** 'default' = free + cost not listed; 'free' = free only; 'all' = paid too. */
  cost: 'default',
  showCivic: false,
  showPast: false,
  view: 'list',
  /** How many events the list renders. Raised by "Load more"; reset by any filter change. */
  limit: 0,
  /** Visible events grouped by date, rebuilt whenever the calendar renders. */
  byDay: new Map(),
  /** Month shown by the calendar, 'YYYY-MM'. */
  month: '',
  /** Day whose events are listed in the dialog, 'YYYY-MM-DD' or null. */
  selectedDay: null,
  /** Date range, either end optional, 'YYYY-MM-DD'. An explicit range beats "upcoming". */
  from: '',
  to: '',
}

const $ = (id) => document.getElementById(id)

/**
 * Every localDate in the data is a wall date in Simcoe County's zone, so "today" has to
 * be measured there too — not in UTC (which rolls over at 8pm Eastern) and not in the
 * viewer's own zone. This constant is the only place the zone is assumed.
 */
const SITE_TZ = 'America/Toronto'
const siteDateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: SITE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
const todayISO = () => siteDateFormat.format(new Date())
const thisMonth = () => todayISO().slice(0, 7)

/** Shift 'YYYY-MM' by whole months. Done in UTC so no local DST edge can shift the date. */
function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7)
}

/**
 * The municipality value meaning "no town resolved" — mostly news-site listings that give
 * no address. Kept in the same `m` list as real slugs so the two combine. Must match
 * UNPLACED in ../src/query.ts, which turns it into `municipality_slug IS NULL`.
 */
const UNPLACED = 'unspecified'
const UNPLACED_LABEL = 'Not specified'

const CATEGORY_LABELS = {
  arts: 'Arts & culture',
  music: 'Music',
  family: 'Family & kids',
  outdoors: 'Outdoors',
  markets: 'Markets & sales',
  sports: 'Sports & fitness',
  community: 'Community',
  education: 'Talks & workshops',
  'civic-meeting': 'Council meetings',
  other: 'Other',
}
const categoryLabel = (c) => CATEGORY_LABELS[c] ?? c

/* ---------- URL state ---------- */

function readUrl() {
  const p = new URLSearchParams(location.search)
  const set = (key) => new Set((p.get(key) || '').split(',').filter(Boolean))
  state.filters.m = set('m')
  state.filters.cat = set('cat')
  state.cost = ['free', 'paid', 'all'].includes(p.get('cost')) ? p.get('cost') : 'default'
  state.showCivic = p.get('civic') === '1'
  state.showPast = p.get('past') === '1'
  state.view = p.get('view') === 'calendar' ? 'calendar' : 'list'
  state.month = /^\d{4}-\d{2}$/.test(p.get('month') || '') ? p.get('month') : thisMonth()
  const date = (key) => (/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(p.get(key) || '') ? p.get(key) : '')
  state.from = date('from')
  state.to = date('to')
}

function writeUrl() {
  const p = new URLSearchParams()
  for (const key of ['m', 'cat']) {
    if (state.filters[key].size) p.set(key, [...state.filters[key]].join(','))
  }
  if (state.cost !== 'default') p.set('cost', state.cost)
  if (state.showCivic) p.set('civic', '1')
  if (state.showPast) p.set('past', '1')
  if (state.from) p.set('from', state.from)
  if (state.to) p.set('to', state.to)
  if (state.view === 'calendar') {
    p.set('view', 'calendar')
    // Only pin the month if it is not the one the page would open on anyway, so a
    // shared "current month" link stays current for whoever opens it.
    if (state.month !== thisMonth()) p.set('month', state.month)
  }
  const qs = p.toString()
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname)
}

/** The same filters, expressed for the server-side iCal endpoint. */
function icsUrl() {
  const p = new URLSearchParams()
  if (state.filters.m.size) p.set('m', [...state.filters.m].join(','))
  if (state.filters.cat.size) p.set('cat', [...state.filters.cat].join(','))
  if (state.cost !== 'default') p.set('cost', state.cost)
  if (state.showCivic) p.set('civic', '1')
  if (state.from) p.set('from', state.from)
  if (state.to) p.set('to', state.to)
  const qs = p.toString()
  return `${location.origin}/calendar.ics${qs ? `?${qs}` : ''}`
}

/* ---------- filtering ---------- */

function matchesCost(e) {
  if (state.cost === 'all') return true
  if (state.cost === 'free') return e.cost === 'free'
  if (state.cost === 'paid') return e.cost === 'paid'
  // The default: free, plus everything whose price the source never stated.
  return e.cost !== 'paid'
}

function matchesFilters(e) {
  if (!state.showCivic && e.category === 'civic-meeting') return false
  if (!matchesCost(e)) return false
  if (state.filters.m.size && !state.filters.m.has(e.municipalitySlug ?? UNPLACED)) return false
  if (state.filters.cat.size && !state.filters.cat.has(e.category)) return false
  return true
}

/**
 * The last day an event runs, as a wall date in Simcoe County's zone.
 *
 * An all-day span stores its end as 23:59 on the final day, so that day is already the
 * inclusive last one — see the DTEND arithmetic in core/ical.ts, which is the other half
 * of this convention.
 */
function lastLocalDate(e) {
  if (!e.endsAtUtc) return e.localDate
  const end = siteDateFormat.format(new Date(e.endsAtUtc))
  return end < e.localDate ? e.localDate : end
}

/**
 * Whether an event is still worth showing: happening now, or yet to happen.
 *
 * A published end time is the only thing precise enough to retire an event partway
 * through a day, so it is the only thing allowed to. Everything else — all-day spans,
 * and the 1,500 listings whose source never said when they finish — stays up until its
 * last day is over. Erring that way costs a reader a wasted click; erring the other way
 * hides an event that is still going on.
 */
function hasFinished(e, now = Date.now()) {
  if (e.endsAtUtc && !e.allDay && e.timePrecision !== 'date-only') return Date.parse(e.endsAtUtc) <= now
  return lastLocalDate(e) < todayISO()
}

/** Started and not yet over — a festival on its second day, a fair this afternoon. */
function isOnNow(e, now = Date.now()) {
  return Date.parse(e.startsAtUtc) <= now && !hasFinished(e, now)
}

/**
 * The day heading an event is filed under. Its start date, except for something that
 * began earlier and is still running: that belongs under today, because a heading
 * reading "3 days ago" above a festival happening right now is simply wrong.
 */
function listDate(e) {
  const today = todayISO()
  return e.localDate < today && isOnNow(e) ? today : e.localDate
}

/**
 * Which dates are in scope, which is the one thing the two views disagree about.
 *
 * The list looks forward from now unless asked otherwise. The calendar is scoped by
 * the month on screen instead: someone who has deliberately paged back wants that month.
 */
function inDateScope(e) {
  if (state.from && e.localDate < state.from) return false
  if (state.to && e.localDate > state.to) return false
  if (state.view === 'calendar') return e.localDate.slice(0, 7) === state.month
  // A range the reader typed is a deliberate statement about which days they want, so it
  // replaces the "from today onwards" default rather than being narrowed by it.
  if (state.from || state.to) return true
  return state.showPast || !hasFinished(e)
}

function visibleEvents() {
  return state.events.filter((e) => matchesFilters(e) && inDateScope(e))
}

/* ---------- rendering ---------- */

const fmtDay = new Intl.DateTimeFormat('en-CA', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })

function relativeDay(dateStr) {
  const days = Math.round((Date.parse(`${dateStr}T00:00:00Z`) - Date.parse(`${todayISO()}T00:00:00Z`)) / 86400000)
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days === -1) return 'yesterday'
  if (days < 0) return `${Math.abs(days)} days ago`
  if (days < 7) return `in ${days} days`
  if (days < 14) return 'next week'
  return ''
}

function formatTime(t) {
  const [h, m] = t.split(':').map(Number)
  const suffix = h >= 12 ? 'p.m.' : 'a.m.'
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${suffix}`
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/**
 * How many events the list shows before asking. This caps RENDERING only: the whole
 * dataset still arrives in one response, which keeps filtering instant.
 */
const PAGE_SIZE = 30

function renderList() {
  const matching = visibleEvents()
  const list = $('list')

  if (!matching.length) {
    list.innerHTML = `<div class="empty">
      <p>No events match these filters.</p>
      <button class="btn ghost" onclick="window.__clearAll()">Clear all filters</button>
    </div>`
    updateStats(0, 0)
    return
  }

  const shown = matching.slice(0, state.limit || PAGE_SIZE)
  const remaining = matching.length - shown.length

  // Group only what is on screen, so a day heading never appears above nothing.
  const byDay = new Map()
  for (const e of shown) {
    const date = listDate(e)
    if (!byDay.has(date)) byDay.set(date, [])
    byDay.get(date).push(e)
  }

  const parts = []
  // Sorted, not insertion order: a running festival sorts by its start three days ago but
  // is filed under today, and with past events showing that would put today first.
  for (const [date, dayEvents] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
    const rel = relativeDay(date)
    parts.push(`<section class="day">
      <div class="day-head">
        <h2>${esc(fmtDay.format(new Date(`${date}T00:00:00Z`)))}</h2>
        ${rel ? `<span class="rel">${esc(rel)}</span>` : ''}
      </div>
      ${dayEvents.map(renderEvent).join('')}
    </section>`)
  }

  if (remaining > 0) {
    const next = Math.min(PAGE_SIZE, remaining)
    parts.push(`<div class="more">
      <button class="btn ghost" id="load-more">Load ${next} more</button>
      <p class="more-count">${shown.length} of ${matching.length} events${
        remaining > next ? ` &middot; <button type="button" class="linkish" id="load-all">show all</button>` : ''
      }</p>
    </div>`)
  }

  list.innerHTML = parts.join('')

  if (remaining > 0) {
    $('load-more').onclick = () => growList(PAGE_SIZE)
    const all = $('load-all')
    if (all) all.onclick = () => growList(matching.length)
  }
  updateStats(shown.length, matching.length)
}

/** Render more of the same filtered set. Deliberately not a refresh: no refetch, no reset. */
function growList(by) {
  const previous = state.limit || PAGE_SIZE
  state.limit = previous + by
  renderList()
  const headings = document.querySelectorAll('#list .event h3 a')
  const next = headings[previous]
  if (next) next.focus({ preventScroll: true })
}

const placeName = (slug) =>
  !slug || slug === UNPLACED ? UNPLACED_LABEL : state.municipalities.get(slug)?.name || slug
const shortPlaceName = (slug) => state.municipalities.get(slug)?.short_name || splitPlaceName(placeName(slug)).name

function costTag(e) {
  if (e.cost === 'free') return '<span class="tag free">Free</span>'
  if (e.cost === 'paid') return `<span class="tag paid" title="${esc(e.costText ?? 'Paid')}">${esc(e.costText && e.costText.length <= 12 ? e.costText : 'Paid')}</span>`
  return ''
}

/**
 * An event's permalink, carrying whatever is filtered right now. The server reads those
 * back off the link so "All events" returns to this view, not to an unfiltered list.
 * The search string is already the filter state — writeUrl keeps it that way.
 */
function eventHref(e) {
  return `/e/${e.shortCode}${location.search}`
}

function renderEvent(e) {
  const tags = []
  if (e.status === 'cancelled') tags.push('<span class="tag cancelled">Cancelled</span>')
  if (e.status === 'rescheduled') tags.push('<span class="tag moved">Rescheduled</span>')
  // Only for events that began on an earlier day. One that started an hour ago already
  // sits under today with its start time showing.
  if (e.localDate < todayISO() && isOnNow(e)) tags.push('<span class="tag onnow">On now</span>')
  tags.push(costTag(e))
  if (e.category === 'civic-meeting') tags.push('<span class="tag package">Meeting</span>')

  const dateOnly = e.allDay || e.timePrecision === 'date-only'
  const time = dateOnly ? '<span class="tbd">All day</span>' : esc(formatTime(e.localTime))
  const place = [e.venueName, !e.venueName && e.address ? e.address : null].filter(Boolean)[0]
  const alsoOn = e.sourceSlugs.length > 1 ? `<span class="also">listed ${e.sourceSlugs.length} places</span>` : ''

  return `<article class="event${e.status === 'cancelled' ? ' is-cancelled' : ''}" data-cat="${esc(e.category)}">
    <div class="time">${time}</div>
    <div>
      <h3><a href="${esc(eventHref(e))}">${esc(e.title)}</a> ${tags.join(' ')}</h3>
      <div class="meta">
        <span class="jur">${esc(shortPlaceName(e.municipalitySlug))}</span>
        <span class="cat"><span class="cat-dot" aria-hidden="true"></span>${esc(categoryLabel(e.category))}</span>
        ${place ? `<span>${esc(place)}</span>` : ''}
        ${alsoOn}
      </div>
    </div>
  </article>`
}

/* ---------- calendar view ---------- */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const fmtMonth = new Intl.DateTimeFormat('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' })

/** Cells for a month grid: whole weeks, padded with the neighbouring months' days. */
function monthGrid(month) {
  const [year, m] = month.split('-').map(Number)
  const first = new Date(Date.UTC(year, m - 1, 1))
  const start = new Date(first)
  start.setUTCDate(1 - first.getUTCDay())

  const cells = []
  const cursor = new Date(start)
  while (cells.length < 42) {
    const iso = cursor.toISOString().slice(0, 10)
    cells.push({
      iso,
      day: cursor.getUTCDate(),
      inMonth: iso.slice(0, 7) === month,
      weekend: cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6,
    })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
    if (cells.length % 7 === 0 && cursor.toISOString().slice(0, 7) !== month) break
  }
  return cells
}

const MAX_CHIPS = 3

/** A compact time for calendar chips: "9am", "2:30pm". */
function compactTime(t) {
  const [h, m] = t.split(':').map(Number)
  const hour = h % 12 === 0 ? 12 : h % 12
  const suffix = h >= 12 ? 'pm' : 'am'
  return m === 0 ? `${hour}${suffix}` : `${hour}:${String(m).padStart(2, '0')}${suffix}`
}

function renderCalendar() {
  const events = visibleEvents()
  const byDay = new Map()
  for (const e of events) {
    if (!byDay.has(e.localDate)) byDay.set(e.localDate, [])
    byDay.get(e.localDate).push(e)
  }
  // Kept so opening a day needs no re-render — see selectDay.
  state.byDay = byDay

  const [year, m] = state.month.split('-').map(Number)
  $('month-label').textContent = fmtMonth.format(new Date(Date.UTC(year, m - 1, 1)))
  $('month-count').textContent = events.length ? `${events.length} event${events.length === 1 ? '' : 's'}` : 'No events'

  const today = todayISO()
  const cells = monthGrid(state.month)
  // Show the municipality on chips only while more than one is in view.
  const showPlace = new Set(events.map((e) => e.municipalitySlug)).size > 1

  const head = WEEKDAYS.map((d) => `<div class="cal-weekday"><abbr title="${d}day">${d}</abbr></div>`).join('')

  const body = cells
    .map((cell) => {
      const dayEvents = byDay.get(cell.iso) ?? []
      const classes = ['cal-day']
      if (cell.weekend) classes.push('is-weekend')
      if (!cell.inMonth) classes.push('is-outside')
      if (cell.iso === today) classes.push('is-today')
      if (cell.iso === state.selectedDay) classes.push('is-selected')
      if (dayEvents.length) classes.push('has-events')

      const chips = dayEvents
        .slice(0, MAX_CHIPS)
        .map((e) => {
          const dateOnly = e.allDay || e.timePrecision === 'date-only'
          const fullTime = dateOnly ? 'All day' : formatTime(e.localTime)
          return `<span class="chip ${e.status === 'cancelled' ? 'is-cancelled' : ''}" data-cat="${esc(e.category)}"
            title="${esc(`${fullTime} · ${placeName(e.municipalitySlug)} · ${e.title}`)}">
            <span class="chip-time">${dateOnly ? '' : esc(compactTime(e.localTime))}</span>
            ${showPlace ? `<span class="chip-place">${esc(shortPlaceName(e.municipalitySlug))}</span>` : ''}
            <span class="chip-title">${esc(e.title)}</span></span>`
        })
        .join('')
      const more = dayEvents.length > MAX_CHIPS ? `<span class="chip-more">+${dayEvents.length - MAX_CHIPS} more</span>` : ''
      const dots = dayEvents
        .slice(0, 4)
        .map((e) => `<span class="dot ${e.status === 'cancelled' ? 'is-cancelled' : ''}" data-cat="${esc(e.category)}"></span>`)
        .join('')

      return `<button type="button" class="${classes.join(' ')}" data-day="${cell.iso}"
        aria-label="${esc(cell.iso)}, ${dayEvents.length} event${dayEvents.length === 1 ? '' : 's'}"
        ${dayEvents.length ? '' : 'aria-disabled="true"'}>
        <span class="cal-daynum">${cell.day}</span>
        <span class="cal-chips">${chips}${more}</span>
        <span class="cal-dots">${dots}</span>
      </button>`
    })
    .join('')

  const empty = events.length
    ? ''
    : `<p class="cal-empty">No events in this month${
        nextMonthWithEvents()
          ? ` · <button type="button" class="linkish" id="jump-next">Jump to ${esc(fmtMonth.format(new Date(`${nextMonthWithEvents()}-01T00:00:00Z`)))}</button>`
          : ''
      }</p>`

  $('calendar').innerHTML = `<div class="cal-grid" role="grid">${head}${body}</div>${empty}`

  for (const button of $('calendar').querySelectorAll('.cal-day')) {
    button.onclick = () => selectDay(button.dataset.day)
  }
  const jump = $('jump-next')
  if (jump) {
    jump.onclick = () => {
      state.month = nextMonthWithEvents()
      state.selectedDay = null
      refreshAll()
    }
  }

  if (dayModal.open) renderDayModal(byDay)
  updateStats(events.length, events.length)
}

/** The soonest month after the current one that has any matching events. */
function nextMonthWithEvents() {
  const months = state.events
    .filter((e) => matchesFilters(e))
    .map((e) => e.localDate.slice(0, 7))
    .filter((m) => m > state.month)
    .sort()
  return months[0] ?? null
}

function selectDay(iso) {
  state.selectedDay = iso
  // Update the highlight in place rather than re-rendering the grid: the browser
  // restores focus to whatever opened the dialog, and rebuilding the grid would destroy
  // that button mid-click.
  for (const cell of document.querySelectorAll('.cal-day')) {
    cell.classList.toggle('is-selected', cell.dataset.day === iso)
  }
  renderDayModal(state.byDay)
  openDayModal()
}

/* ---------- day modal ---------- */

const dayModal = $('day-modal')

function openDayModal() {
  if (!dayModal.open) dayModal.showModal()
  document.body.classList.add('modal-open')
}

function closeDayModal() {
  if (dayModal.open) dayModal.close()
}

dayModal.addEventListener('close', () => {
  document.body.classList.remove('modal-open')
  state.selectedDay = null
  for (const cell of document.querySelectorAll('.cal-day.is-selected')) cell.classList.remove('is-selected')
})

$('close-day').onclick = () => closeDayModal()
dayModal.addEventListener('click', (ev) => {
  if (ev.target === dayModal) closeDayModal()
})

function renderDayModal(byDay) {
  if (!state.selectedDay) return
  const dayEvents = byDay.get(state.selectedDay) ?? []
  $('day-modal-title').textContent = fmtDay.format(new Date(`${state.selectedDay}T00:00:00Z`))
  $('day-modal-body').innerHTML = dayEvents.length ? dayEvents.map(renderEvent).join('') : '<p class="cal-empty">No events on this day.</p>'
}

/* ---------- view switching ---------- */

function setView(view) {
  state.view = view
  state.selectedDay = null
  refreshAll()
}

function applyView() {
  const calendar = state.view === 'calendar'
  $('list').hidden = calendar
  $('calendar').hidden = !calendar
  $('monthnav').hidden = !calendar
  // "Past events" has no meaning once the month on screen defines the range.
  $('past-toggle').hidden = calendar
  $('view-list').setAttribute('aria-pressed', String(!calendar))
  $('view-calendar').setAttribute('aria-pressed', String(calendar))
}

function updateStats(rendered, matching) {
  const total = state.events.length
  const places = new Set(state.events.map((e) => e.municipalitySlug).filter(Boolean)).size
  const lead = matching > rendered ? `${matching} event${matching === 1 ? '' : 's'} match` : `${matching} event${matching === 1 ? '' : 's'} shown`
  $('stats').textContent = `${lead} · ${total} tracked across ${places} municipalities`
}

/*
 * What the cost filter is holding back, said out loud with the way out in the same line.
 *
 * The default view hides paid events, which is the right default and an invisible one:
 * an event someone knows about is simply missing, with nothing on screen to explain it.
 * Shown above both views, because the calendar hides them just as quietly.
 */
const COST_NOTES = {
  default: ['Showing free events and events with no price listed.', 'Show everything, including paid'],
  free: ['Showing free events only.', 'Show everything'],
  paid: ['Showing paid events only.', 'Show everything'],
}

function renderCostNote() {
  const note = $('costnote')
  const copy = COST_NOTES[state.cost]
  note.hidden = !copy
  if (!copy) return
  const [text, action] = copy
  note.innerHTML = `<span>${esc(text)}</span><button type="button" class="linkish" id="cost-all">${esc(action)}</button>`
  $('cost-all').onclick = () => {
    state.cost = 'all'
    $('cost').value = 'all'
    refreshAll()
  }
}

/* ---------- filter menus ---------- */

/** containerId -> which filter set it drives. */
const MENUS = { 'f-municipality': 'm', 'f-category': 'cat' }

function buildMenu(containerId, label, key, options) {
  const container = $(containerId)
  const selected = state.filters[key]

  let lastGroup = null
  const rows = options
    .map((opt) => {
      const header = opt.group && opt.group !== lastGroup ? `<div class="menu-group" data-group="${esc(opt.group)}">${esc(opt.group)}</div>` : ''
      lastGroup = opt.group ?? lastGroup
      const search = (opt.search ?? opt.label).toLowerCase()
      return `${header}<label data-search="${esc(search)}" data-group="${esc(opt.group ?? '')}">
        <input type="checkbox" value="${esc(opt.value)}"${selected.has(opt.value) ? ' checked' : ''}>
        <span class="opt-label">${esc(opt.label)}${opt.note ? `<span class="opt-note">${esc(opt.note)}</span>` : ''}</span><span class="tally">${opt.count}</span></label>`
    })
    .join('')

  container.innerHTML = `
    <button aria-expanded="false" aria-haspopup="true">${esc(label)}<span class="count"${selected.size ? '' : ' hidden'}>${selected.size}</span> <span class="chev">▾</span></button>
    <div class="menu" hidden>
      <div class="menu-search">
        <input type="search" placeholder="Search ${esc(label.toLowerCase())}…" aria-label="Search ${esc(label)}" autocomplete="off">
      </div>
      <div class="menu-head"><button data-all>Select all</button><button data-none>Clear</button></div>
      <div class="menu-options">${rows}</div>
      <p class="menu-empty" hidden>No matches</p>
    </div>`

  const trigger = container.querySelector('button')
  const menu = container.querySelector('.menu')
  const search = menu.querySelector('.menu-search input')

  trigger.onclick = (ev) => {
    ev.stopPropagation()
    const wasOpen = !menu.hidden
    closeAllMenus()
    if (!wasOpen) {
      menu.hidden = false
      trigger.setAttribute('aria-expanded', 'true')
      if (!window.matchMedia('(hover: none)').matches) search.focus()
    }
  }
  menu.onclick = (ev) => ev.stopPropagation()

  const applySearch = () => {
    const term = search.value.trim().toLowerCase()
    let visible = 0
    for (const label of menu.querySelectorAll('label[data-search]')) {
      const match = !term || label.dataset.search.includes(term)
      label.hidden = !match
      if (match) visible++
    }
    for (const header of menu.querySelectorAll('.menu-group')) {
      const group = header.dataset.group
      const anyVisible = [...menu.querySelectorAll(`label[data-group="${CSS.escape(group)}"]`)].some((l) => !l.hidden)
      header.hidden = !anyVisible
    }
    menu.querySelector('.menu-empty').hidden = visible > 0
  }

  search.oninput = applySearch
  search.onkeydown = (ev) => {
    if (ev.key === 'Escape') {
      if (search.value) {
        search.value = ''
        applySearch()
      } else {
        closeAllMenus()
        trigger.focus()
      }
    }
  }

  const visibleValues = () =>
    [...menu.querySelectorAll('label[data-search]')].filter((l) => !l.hidden).map((l) => l.querySelector('input').value)

  menu.querySelector('[data-all]').onclick = () => {
    visibleValues().forEach((v) => selected.add(v))
    refresh()
  }
  menu.querySelector('[data-none]').onclick = () => {
    visibleValues().forEach((v) => selected.delete(v))
    refresh()
  }
  menu.querySelectorAll('input[type=checkbox]').forEach((input) => {
    input.onchange = () => {
      if (input.checked) selected.add(input.value)
      else selected.delete(input.value)
      refresh()
    }
  })
}

/** Reflect filter state back into the menus without rebuilding them. */
function syncMenus() {
  for (const [containerId, key] of Object.entries(MENUS)) {
    const container = $(containerId)
    if (!container.firstChild) continue
    const selected = state.filters[key]
    for (const input of container.querySelectorAll('input[type=checkbox]')) input.checked = selected.has(input.value)
    const badge = container.querySelector('.count')
    badge.textContent = String(selected.size)
    badge.hidden = selected.size === 0
  }
}

/** The dates field has one badge and no checkboxes, so it syncs on its own. */
function syncDateMenu() {
  const container = $('f-dates')
  if (!container.firstChild) return
  const badge = container.querySelector('.count')
  badge.hidden = !(state.from || state.to)
  const from = container.querySelector('#date-from')
  const to = container.querySelector('#date-to')
  if (from) from.value = state.from
  if (to) to.value = state.to
}

function closeAllMenus() {
  document.querySelectorAll('.menu').forEach((m) => (m.hidden = true))
  document.querySelectorAll('.field > button').forEach((b) => b.setAttribute('aria-expanded', 'false'))
}
document.addEventListener('click', closeAllMenus)
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') closeAllMenus()
})

function renderActiveFilters() {
  const pills = []
  const add = (key, value, label) =>
    pills.push(`<span class="pill">${esc(label)}<button data-key="${key}" data-value="${esc(value)}" aria-label="Remove ${esc(label)} filter">×</button></span>`)

  for (const slug of state.filters.m) add('m', slug, shortPlaceName(slug))
  for (const cat of state.filters.cat) add('cat', cat, categoryLabel(cat))
  if (state.from || state.to) add('dates', 'range', rangeLabel())

  const box = $('active')
  box.innerHTML = pills.length ? pills.join('') + `<button class="pill clear-all" type="button">Clear all</button>` : ''
  box.querySelectorAll('button[data-key]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.key === 'dates') return setRange('', '')
      state.filters[b.dataset.key].delete(b.dataset.value)
      refresh()
    }
  })
  const clearAll = box.querySelector('.clear-all')
  if (clearAll) clearAll.onclick = () => window.__clearAll()
}

window.__clearAll = () => {
  state.filters.m.clear()
  state.filters.cat.clear()
  state.from = ''
  state.to = ''
  refreshAll()
}

/* ---------- options derived from the data ---------- */

function optionsFor(getter) {
  const counts = new Map()
  for (const e of state.events) {
    // Ignores the m/cat filters so tallies do not collapse to zero once something is
    // selected, but respects cost, civic and date scope so the numbers match the view.
    if (!state.showCivic && e.category === 'civic-meeting') continue
    if (!matchesCost(e)) continue
    if (!inDateScope(e)) continue
    const value = getter(e)
    if (value) counts.set(value, (counts.get(value) || 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, count]) => ({ value, count }))
}

/** "Township of Tay" → the name people use and its municipal type. */
function splitPlaceName(full) {
  const m = /^(City|Town|Township|County|Municipality)\s+of\s+(.+)$/i.exec(full)
  return m ? { name: m[2], type: m[1] } : { name: full, type: '' }
}

/** County first, then the municipalities, then the events we could not place. */
const PLACE_GROUPS = ['County', 'Municipalities', 'Other']

function municipalityOptions() {
  return optionsFor((e) => e.municipalitySlug ?? UNPLACED)
    .map((o) => {
      if (o.value === UNPLACED) {
        return {
          ...o,
          label: UNPLACED_LABEL,
          note: 'no town given',
          search: 'not specified unspecified unknown other no town given location',
          group: 'Other',
        }
      }
      const { name, type } = splitPlaceName(placeName(o.value))
      const level = state.municipalities.get(o.value)?.level
      return {
        ...o,
        label: name,
        note: type,
        search: `${name} ${type} ${placeName(o.value)} ${o.value}`.toLowerCase(),
        group: level === 'county' ? 'County' : 'Municipalities',
      }
    })
    .sort((a, b) => {
      if (a.group !== b.group) return PLACE_GROUPS.indexOf(a.group) - PLACE_GROUPS.indexOf(b.group)
      return a.label.localeCompare(b.label)
    })
}

/** Shift a 'YYYY-MM-DD' by whole days, in UTC so no local DST edge can move the date. */
function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Ranges people actually ask for, worked out from the date in Simcoe County today. */
function presetRange(name) {
  const today = todayISO()
  if (name === '7') return [today, addDays(today, 6)]
  if (name === '30') return [today, addDays(today, 29)]
  if (name === 'month') {
    const [y, m] = today.split('-').map(Number)
    return [`${today.slice(0, 7)}-01`, new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)]
  }
  // The weekend: the coming Saturday and Sunday, or the rest of this one if it has started.
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay()
  const saturday = dow === 0 ? addDays(today, -1) : addDays(today, 6 - dow)
  return [dow === 0 ? today : saturday, addDays(saturday, 1)]
}

const fmtShortDate = new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const shortDate = (iso) => fmtShortDate.format(new Date(`${iso}T00:00:00Z`))

/** How the chosen range reads on the pill: both ends, or whichever one was given. */
function rangeLabel() {
  if (state.from && state.to) {
    return state.from === state.to ? shortDate(state.from) : `${shortDate(state.from)} – ${shortDate(state.to)}`
  }
  return state.from ? `From ${shortDate(state.from)}` : `Until ${shortDate(state.to)}`
}

function setRange(from, to) {
  // Typed the other way round: take what they meant rather than showing them nothing.
  if (from && to && from > to) [from, to] = [to, from]
  state.from = from
  state.to = to
  refreshAll()
}

function buildDateMenu() {
  const container = $('f-dates')
  const set = state.from || state.to
  container.innerHTML = `
    <button aria-expanded="false" aria-haspopup="true">Dates<span class="count"${set ? '' : ' hidden'}>1</span> <span class="chev">▾</span></button>
    <div class="menu menu-dates" hidden>
      <div class="date-row">
        <label>From <input type="date" id="date-from" value="${esc(state.from)}" aria-label="From date"></label>
        <label>To <input type="date" id="date-to" value="${esc(state.to)}" aria-label="To date"></label>
      </div>
      <div class="date-presets">
        <button type="button" data-range="weekend">This weekend</button>
        <button type="button" data-range="7">Next 7 days</button>
        <button type="button" data-range="30">Next 30 days</button>
        <button type="button" data-range="month">This month</button>
      </div>
      <div class="menu-head"><button type="button" data-clear>Clear dates</button></div>
    </div>`

  const trigger = container.querySelector('button')
  const menu = container.querySelector('.menu')
  trigger.onclick = (ev) => {
    ev.stopPropagation()
    const wasOpen = !menu.hidden
    closeAllMenus()
    if (!wasOpen) {
      menu.hidden = false
      trigger.setAttribute('aria-expanded', 'true')
    }
  }
  menu.onclick = (ev) => ev.stopPropagation()

  const from = menu.querySelector('#date-from')
  const to = menu.querySelector('#date-to')

  /** Hand the reader straight to the next field, with its calendar already open. */
  const openPicker = (input) => {
    input.focus()
    try {
      input.showPicker?.()
    } catch {
      // Needs a user gesture, and some browsers do not have it at all. Focus is enough.
    }
  }

  from.onchange = () => {
    setRange(from.value, to.value)
    // Picking one end of a range is half an answer: stay open and ask for the other.
    if (from.value && !to.value) openPicker(to)
  }
  to.onchange = () => setRange(from.value, to.value)

  // A preset or a clear is a whole answer, so it gets out of the way of the results.
  menu.querySelectorAll('[data-range]').forEach((b) => {
    b.onclick = () => {
      setRange(...presetRange(b.dataset.range))
      closeAllMenus()
    }
  })
  menu.querySelector('[data-clear]').onclick = () => {
    setRange('', '')
    closeAllMenus()
  }
}

function rebuildMenus() {
  buildMenu('f-municipality', 'Municipality', 'm', municipalityOptions())
  buildMenu(
    'f-category',
    'Category',
    'cat',
    optionsFor((e) => e.category).map((o) => ({ ...o, label: categoryLabel(o.value) })),
  )
  if (!$('f-dates').firstChild) buildDateMenu()
}

function refresh() {
  state.limit = PAGE_SIZE
  writeUrl()
  applyView()
  syncMenus()
  syncDateMenu()
  renderCostNote()
  renderActiveFilters()
  if (state.view === 'calendar') renderCalendar()
  else renderList()
}

/** The option lists themselves only change when the toggles do. */
function refreshAll() {
  rebuildMenus()
  refresh()
}

/* ---------- subscribe sheet ---------- */

$('subscribe').onclick = () => {
  $('ics-url').textContent = icsUrl()
  $('open-ics').href = icsUrl()
  $('sheet').hidden = false
}
$('close-sheet').onclick = () => ($('sheet').hidden = true)
$('sheet').onclick = (e) => {
  if (e.target === $('sheet')) $('sheet').hidden = true
}
$('copy-ics').onclick = async () => {
  try {
    await navigator.clipboard.writeText(icsUrl())
    $('copy-ics').textContent = 'Copied'
    setTimeout(() => ($('copy-ics').textContent = 'Copy link'), 1600)
  } catch {
    $('copy-ics').textContent = 'Select the link above'
  }
}

/* ---------- theme ---------- */

/*
 * Three states, not two: light, dark, and following the system — which is the default and
 * the only one that stores nothing. The attribute on <html> is what the stylesheet reads;
 * a copy of this choice runs inline in the page head so the first paint is already right.
 */
const THEME_KEY = 'theme'

function readTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    return stored === 'dark' || stored === 'light' ? stored : 'system'
  } catch {
    return 'system'
  }
}

function applyTheme(theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
  try {
    if (theme === 'system') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, theme)
  } catch {
    // A browser with storage blocked still gets the theme, just not the memory of it.
  }
  for (const [id, value] of Object.entries(THEME_BUTTONS)) {
    $(id).setAttribute('aria-pressed', String(value === theme))
  }
}

const THEME_BUTTONS = { 'theme-light': 'light', 'theme-dark': 'dark', 'theme-system': 'system' }
for (const [id, value] of Object.entries(THEME_BUTTONS)) $(id).onclick = () => applyTheme(value)
applyTheme(readTheme())

/* ---------- view + month controls ---------- */

$('view-list').onclick = () => setView('list')
$('view-calendar').onclick = () => setView('calendar')

const goToMonth = (month) => {
  state.month = month
  state.selectedDay = null
  refreshAll()
}
$('prev-month').onclick = () => goToMonth(shiftMonth(state.month, -1))
$('next-month').onclick = () => goToMonth(shiftMonth(state.month, 1))
$('this-month').onclick = () => goToMonth(thisMonth())

document.addEventListener('keydown', (ev) => {
  if (state.view !== 'calendar') return
  if (dayModal.open) return
  if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement) return
  if (ev.key === 'ArrowLeft') goToMonth(shiftMonth(state.month, -1))
  if (ev.key === 'ArrowRight') goToMonth(shiftMonth(state.month, 1))
})

$('cost').onchange = (e) => {
  state.cost = e.target.value
  refreshAll()
}
$('show-civic').onchange = (e) => {
  state.showCivic = e.target.checked
  refreshAll()
}
$('show-past').onchange = (e) => {
  state.showPast = e.target.checked
  refreshAll()
}

/* ---------- coming back from an event ---------- */

/*
 * Opening an event and pressing "All events" should land where the reader left off, not
 * at the top of a list they have already scrolled past. The filters come back through the
 * link itself; the position and how many pages were loaded are remembered here.
 *
 * Only a click on an event link records anything, so a shared or bookmarked link to the
 * same filtered view still opens at the top. The note is used once and thrown away, and
 * goes stale on its own in case the click opened a new tab and nobody ever came back.
 */
const RETURN_KEY = 'scec:return'
const RETURN_MAX_AGE_MS = 30 * 60 * 1000

document.addEventListener('click', (ev) => {
  const link = ev.target instanceof Element ? ev.target.closest('a[href^="/e/"]') : null
  if (!link) return
  try {
    sessionStorage.setItem(
      RETURN_KEY,
      JSON.stringify({ y: window.scrollY, limit: state.limit, query: location.search, at: Date.now() }),
    )
  } catch {
    // Storage can be blocked; the reader just loses the position, not the page.
  }
})

/** The note left by the click that took the reader to an event, if it is still good. */
function takeReturnNote() {
  let raw = null
  try {
    raw = sessionStorage.getItem(RETURN_KEY)
    sessionStorage.removeItem(RETURN_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const note = JSON.parse(raw)
    const fresh = Date.now() - (note.at ?? 0) < RETURN_MAX_AGE_MS
    // The same filters, or it is a note about some other view entirely.
    return fresh && note.query === location.search && typeof note.y === 'number' ? note : null
  } catch {
    return null
  }
}

/* ---------- boot ---------- */

async function getJson(path, { retries = 1 } = {}) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 400))
    try {
      const res = await fetch(path, { headers: { Accept: 'application/json' } })
      if (!res.ok) throw new Error(`${path} returned HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      lastError = err
      if (!(err instanceof TypeError)) throw err
    }
  }
  const blocked = new Error(`Could not reach ${path}`)
  blocked.likelyBlocked = true
  blocked.cause = lastError
  throw blocked
}

function showError(err) {
  const blocked = err.likelyBlocked
  $('list').innerHTML = `<div class="empty">
    <p><strong>${blocked ? 'The event data could not be loaded.' : 'Something went wrong.'}</strong></p>
    ${
      blocked
        ? `<p>The request was stopped before it reached the server. This is usually a browser
             extension — an ad or privacy blocker — or an offline connection.</p>
           <p>Try reloading, or opening the site in a private window with extensions disabled.</p>`
        : `<p>${esc(err.message)}</p>`
    }
    <p><button class="btn" onclick="location.reload()">Reload</button></p>
    <p style="margin-top:14px"><a href="/health">Check whether the server is up</a></p>
  </div>`
}

async function boot() {
  readUrl()
  $('cost').value = state.cost
  $('show-civic').checked = state.showCivic
  $('show-past').checked = state.showPast

  // Everything, including paid and civic, arrives once; the toggles filter in the browser.
  const data = await getJson('/api/events?cost=all&civic=1')
  const municipalities = await getJson('/api/municipalities').catch(() => [])
  const sources = await getJson('/api/sources').catch(() => [])

  state.events = data.events
  for (const m of municipalities) state.municipalities.set(m.slug, m)

  if (sources.length) {
    $('sources-line').innerHTML = `Sources: ${sources
      .map((s) => `<a href="${esc(s.homepage)}" target="_blank" rel="noopener noreferrer">${esc(s.name)}</a>`)
      .join(' · ')}`
  }
  refreshAll()

  const note = takeReturnNote()
  if (note) {
    // After refreshAll, not before: refresh() resets the page depth on every call, so an
    // earlier assignment would be thrown away. Put the loaded pages back, then the
    // position — the events that were on screen have to exist before they can be scrolled to.
    state.limit = Math.max(PAGE_SIZE, note.limit || PAGE_SIZE)
    if (state.view === 'list') renderList()
    requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, note.y)))
  }
}

boot().catch(showError)
