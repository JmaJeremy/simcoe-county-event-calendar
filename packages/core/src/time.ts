/**
 * Timezone handling.
 *
 * Both upstream platforms publish naive local wall-clock strings ("2026-09-22 09:00",
 * "2026/10/05 14:00:00") with no offset. Storing those as-is was a latent bug in the
 * previous version of this project: an event at 9am in July and one at 9am in January
 * are four and five hours off UTC respectively, so any naive comparison drifts by an
 * hour across a DST boundary.
 *
 * We resolve the wall time against an IANA zone using Intl, which ships full ICU data
 * in both Node and Workers — so no date library is needed.
 */

/** Offset of `timeZone` from UTC, in ms, at the given instant. Positive east of UTC. */
function offsetMsAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant)

  const at = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type)
    if (!part) throw new Error(`Intl did not return a "${type}" part for ${timeZone}`)
    return Number(part.value)
  }

  // Intl gives us hour 24 for midnight under hour12:false in some ICU versions.
  const hour = at('hour') % 24
  const asIfUtc = Date.UTC(at('year'), at('month') - 1, at('day'), hour, at('minute'), at('second'))
  return asIfUtc - instant.getTime()
}

const WALL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/

/**
 * Convert a naive local wall-clock string to a true UTC instant.
 *
 * The offset depends on the instant, and the instant depends on the offset, so we solve
 * it by iteration: guess that the wall time is UTC, measure the zone's offset near that
 * guess, correct, and re-measure. Two passes settle every case including DST changeover
 * days, where the first correction can land on the far side of the transition.
 *
 * Ambiguous times in the autumn fall-back hour resolve to the first (DST) occurrence;
 * nonexistent times in the spring-forward gap shift forward. Council meetings do not
 * start at 2am, so neither case is expected to arise in practice.
 */
export function wallTimeToUtc(wall: string, timeZone: string): Date {
  const m = WALL.exec(wall.trim())
  if (!m) throw new Error(`Unparseable wall time: ${JSON.stringify(wall)}`)

  const [y, mo, d, h, mi, s] = m.slice(1, 7).map((v) => (v === undefined ? 0 : Number(v))) as number[]
  const naive = Date.UTC(y!, mo! - 1, d!, h!, mi!, s!)

  let instant = naive
  for (let pass = 0; pass < 2; pass++) {
    instant = naive - offsetMsAt(new Date(instant), timeZone)
  }
  const result = new Date(instant)
  if (Number.isNaN(result.getTime())) throw new Error(`Invalid wall time: ${wall} (${timeZone})`)
  return result
}

/** Normalize the several shapes upstream uses into 'YYYY-MM-DDTHH:mm'. */
export function toWallString(input: string): string {
  const cleaned = input.trim().replace(/\//g, '-').replace(' ', 'T')
  const m = WALL.exec(cleaned)
  if (!m) throw new Error(`Unrecognized date/time format: ${JSON.stringify(input)}`)
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`
}

/** 'YYYY-MM-DD' for a wall-clock string. */
export function wallDate(wall: string): string {
  return toWallString(wall).slice(0, 10)
}

/** 'HH:mm' for a wall-clock string. */
export function wallTime(wall: string): string {
  return toWallString(wall).slice(11, 16)
}

/** 'YYYY-MM-DD' offset by whole days, computed in UTC. */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * The inverse of wallTimeToUtc: a true instant rendered as 'YYYY-MM-DDTHH:mm' in a zone.
 * For sources that publish unix or UTC timestamps (EventON, CitySpark), so adapters can
 * hand normalize the same naive local string every other platform produces.
 */
export function toWallClock(instant: Date | number, timeZone: string): string {
  const date = typeof instant === 'number' ? new Date(instant) : instant
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date)
  const at = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '00'
  const hour = String(Number(at('hour')) % 24).padStart(2, '0')
  return `${at('year')}-${at('month')}-${at('day')}T${hour}:${at('minute')}`
}
