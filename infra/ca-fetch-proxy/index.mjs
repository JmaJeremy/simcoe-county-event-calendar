/**
 * Out in Simcoe: a fetch proxy that runs in Canada.
 *
 * Eight of the twelve Granicus govStack municipal calendars refuse requests from outside
 * Canada. Measured 2026-09-16 against calendar.midland.ca: a Canadian laptop, a home
 * server, ca-central-1 EC2 and this Lambda all get 200; us-east-2 EC2 gets 403. Cloudflare
 * runs cron triggers wherever it has capacity, so the scheduled ingest is refused while
 * every manual run from Toronto succeeds.
 *
 * The ingest worker calls this with a signed Lambda Invoke (public function URLs are
 * blocked in this account), so AWS authenticates the caller and this only has to stay
 * narrow: https, GET, and the twelve calendars we actually read.
 *
 * Deploy:
 *   zip -j function.zip infra/ca-fetch-proxy/index.mjs
 *   aws --profile jeremy lambda update-function-code --function-name scec-ca-fetch-proxy \
 *     --region ca-central-1 --zip-file fileb://function.zip
 */

const ALLOWED_HOSTS = new Set([
  'calendar.midland.ca',
  'calendar.orillia.ca',
  'calendar.ramara.ca',
  'calendar.severn.ca',
  'calendar.springwater.ca',
  'calendar.townofbwg.com',
  'calendar.wasagabeach.com',
  'calendar.essatownship.on.ca',
  'calendar.penetanguishene.ca',
  'events.oro-medonte.ca',
  'events.orilliapubliclibrary.ca',
  'events.tay.ca',
])

/** These hosts refuse anything that does not look like a browser, so the caller's own is used. */
const FALLBACK_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 ' +
  'simcoe-county-events/0.1 (+https://github.com/thejeremydotnet/simcoe-county-event-calendar)'

const problem = (status, message) => ({ status, body: message, headers: {}, proxyError: message })

export const handler = async (event) => {
  const target = event?.url
  let parsed
  try {
    parsed = new URL(target ?? '')
  } catch {
    return problem(400, 'pass the address as { "url": "https://…" }')
  }
  if (parsed.protocol !== 'https:') return problem(400, 'https only')
  if (!ALLOWED_HOSTS.has(parsed.hostname)) return problem(403, `${parsed.hostname} is not on this proxy's list`)

  try {
    const upstream = await fetch(parsed.toString(), {
      headers: { 'User-Agent': event.userAgent || FALLBACK_USER_AGENT, Accept: event.accept || '*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(25_000),
    })
    const body = await upstream.text()
    return {
      status: upstream.status,
      body,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? '',
        'x-azure-ref': upstream.headers.get('x-azure-ref') ?? '',
      },
    }
  } catch (err) {
    // The proxy's own failure, not the calendar's: say so, so a log cannot mislead.
    return problem(502, `proxy could not reach ${parsed.hostname}: ${err?.message ?? err}`)
  }
}
