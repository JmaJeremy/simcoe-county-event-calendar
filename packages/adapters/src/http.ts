import { signLambdaInvoke } from './sigv4.ts'

/**
 * Shared fetch helpers for all adapters.
 *
 * These endpoints belong to small municipal governments, several of which run on shared
 * hosting. We identify ourselves, keep concurrency low, retry only on transient failures,
 * and never hammer a site that is already struggling.
 */

/**
 * A browser-shaped user agent with our identity appended.
 *
 * The govStack calendars sit behind Azure Front Door with a WAF rule that returns 403 to
 * anything whose UA does not start like a browser — `curl/…`, a bare product token, even
 * `Mozilla/5.0 (compatible; …)`. Appending our name and repo URL keeps us identifiable to
 * anyone reading their logs while getting past the generic bot rule. Volume is tiny
 * (a handful of pages per site every couple of hours).
 */
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 ' +
  'simcoe-county-events/0.1 (+https://github.com/thejeremydotnet/simcoe-county-event-calendar)'

export class HttpError extends Error {
  status: number
  url: string
  body: string
  /** The few response headers worth seeing when a host refuses us; see BLOCK_HEADERS. */
  headers: Record<string, string>

  constructor(status: number, url: string, body: string, headers: Record<string, string> = {}) {
    super(`HTTP ${status} from ${url}`)
    this.name = 'HttpError'
    this.status = status
    this.url = url
    this.body = body
    this.headers = headers
  }
}

/**
 * What a refusal is worth reading. Azure Front Door, which fronts the govStack calendars,
 * names the WAF rule that blocked a request in `x-azure-ref`; the rest say who answered
 * and whether a CDN or a bot manager was in the way.
 */
const BLOCK_HEADERS = ['x-azure-ref', 'x-msedge-ref', 'server', 'cf-ray', 'cf-mitigated', 'x-cache', 'via', 'retry-after', 'content-type']

const blockHeaders = (res: Response): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const name of BLOCK_HEADERS) {
    const value = res.headers.get(name)
    if (value) out[name] = value
  }
  return out
}

interface FetchOptions {
  method?: 'GET' | 'POST'
  body?: string
  headers?: Record<string, string>
  timeoutMs?: number
  retries?: number
  /** Set when this call is already going through the proxy, so a 403 cannot loop. */
  viaProxy?: boolean
}

/*
 * A fetch proxy that runs in Canada.
 *
 * Eight of the twelve govStack municipal calendars refuse requests from outside the
 * country: measured 2026-09-16, a Canadian laptop, a home server, ca-central-1 EC2 and
 * ca-central-1 Lambda all got 200 from calendar.midland.ca, us-east-2 EC2 got 403. That is
 * why the scheduled ingest fails on exactly those eight while every manual run from Toronto
 * succeeds — Cloudflare runs cron triggers wherever it has capacity.
 *
 * So a 403 is retried once through a small Lambda in ca-central-1 (infra/ca-fetch-proxy).
 * Retrying rather than always proxying keeps every other request direct, and means a town
 * that lifts its block goes back to being fetched directly with no change here.
 */
export interface FetchProxyConfig {
  functionName?: string
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  /** Send every allowed host through the proxy, to prove the path from a machine that is not blocked. */
  force?: boolean
}

let proxy: Required<Omit<FetchProxyConfig, 'force'>> & { force: boolean } | null = null

export function setFetchProxy(config: FetchProxyConfig | null): void {
  const { functionName, region, accessKeyId, secretAccessKey } = config ?? {}
  proxy =
    functionName && region && accessKeyId && secretAccessKey
      ? { functionName, region, accessKeyId, secretAccessKey, force: config?.force ?? false }
      : null
}

export const fetchProxyConfigured = (): boolean => proxy !== null

/** What the Lambda answers: the calendar's own status, body and the headers worth keeping. */
interface ProxyResult {
  status?: number
  body?: string
  headers?: Record<string, string>
  proxyError?: string
}

async function fetchThroughProxy(url: string, accept: string): Promise<string> {
  const config = proxy!
  const signed = await signLambdaInvoke(config, config.functionName, { url, userAgent: USER_AGENT, accept })
  httpStats.requests++
  const res = await fetch(signed.url, { method: 'POST', headers: signed.headers, body: signed.body })
  const text = await res.text()
  if (!res.ok) throw new Error(`fetch proxy: Lambda answered ${res.status} ${text.slice(0, 200)}`)
  if (res.headers.get('x-amz-function-error')) throw new Error(`fetch proxy: the Lambda failed: ${text.slice(0, 200)}`)

  let result: ProxyResult
  try {
    result = JSON.parse(text) as ProxyResult
  } catch {
    throw new Error('fetch proxy: the Lambda answered something that is not JSON')
  }
  if (result.proxyError) throw new Error(`fetch proxy: ${result.proxyError}`)
  if (typeof result.status !== 'number') throw new Error('fetch proxy: the Lambda answered without a status')
  // The calendar's own refusal, carried back whole, so it reads like a direct one.
  if (result.status < 200 || result.status >= 300) throw new HttpError(result.status, url, (result.body ?? '').slice(0, 500), result.headers ?? {})
  return result.body ?? ''
}

/** A 5xx or a network blip is worth retrying; a 404 means the shape changed and never will be. */
const isRetryable = (err: unknown): boolean =>
  !(err instanceof HttpError) || err.status >= 500 || err.status === 429

/**
 * Requests made since the last reset, attempts included. The dry-run CLI reports it per
 * source so the Worker's subrequest budget is a measured number, not a guess.
 */
export const httpStats = { requests: 0 }
export const resetHttpStats = (): void => {
  httpStats.requests = 0
}

export async function request(url: string, options: FetchOptions = {}): Promise<string> {
  const { method = 'GET', body, headers = {}, timeoutMs = 20_000, retries = 2 } = options

  // FETCH_PROXY_FORCE: prove the proxy path from a machine the calendars do not block.
  if (proxy?.force && method === 'GET' && !options.viaProxy) return fetchThroughProxy(url, headers.Accept ?? '*/*')

  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // Back off before retrying: 500ms, then 1500ms.
      await new Promise((r) => setTimeout(r, 500 * 3 ** (attempt - 1)))
    }
    try {
      httpStats.requests++
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetch(url, {
          method,
          body,
          headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...headers },
          signal: controller.signal,
          redirect: 'follow',
        })
        const text = await res.text()
        if (!res.ok) throw new HttpError(res.status, url, text.slice(0, 500), blockHeaders(res))
        return text
      } finally {
        clearTimeout(timer)
      }
    } catch (err) {
      lastError = err
      if (err instanceof HttpError && err.status === 403 && proxy && !options.viaProxy) {
        const host = URL.parse(url)?.hostname ?? url
        console.log(`http: ${host} answered 403; retrying through the Canadian proxy`)
        return fetchThroughProxy(url, headers.Accept ?? '*/*')
      }
      if (!isRetryable(err)) throw err
    }
  }
  throw lastError
}

export async function getJson<T>(url: string): Promise<T> {
  const text = await request(url, { headers: { Accept: 'application/json' } })
  return parseJson<T>(text, url)
}

export async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const text = await request(url, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' },
  })
  return parseJson<T>(text, url)
}

function parseJson<T>(text: string, url: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    // A tenant that has migrated away tends to answer with an HTML redirect page rather
    // than an error, so say so plainly instead of surfacing a bare JSON syntax error.
    const looksLikeHtml = /^\s*<(?:!doctype|html)/i.test(text)
    throw new Error(
      looksLikeHtml
        ? `Expected JSON from ${url} but got an HTML page — the tenant may have moved platforms`
        : `Malformed JSON from ${url}: ${text.slice(0, 200)}`,
    )
  }
}

/** Run tasks with a small concurrency cap, preserving input order in the results. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index]!, index)
    }
  })
  await Promise.all(workers)
  return results
}
