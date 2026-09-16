import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpError, fetchProxyConfigured, getJson, request, setFetchProxy } from '../src/http.ts'

/**
 * What a refusal carries. Eight govStack calendars answer 403 to the scheduled ingest and
 * 200 to every manual one; the block page and its headers are the evidence for why, so an
 * HttpError has to keep them.
 */

afterEach(() => vi.unstubAllGlobals())

const refusal = (headers: Record<string, string>, body = '<html>Access denied</html>') =>
  vi.fn(async () => new Response(body, { status: 403, headers }))

describe('request', () => {
  it('keeps the block page and the headers that say who refused', async () => {
    const fetchMock = refusal({ 'x-azure-ref': '20260916T042300Z-abc', server: 'Microsoft-Azure-Application-Gateway/v2', 'content-type': 'text/html' })
    vi.stubGlobal('fetch', fetchMock)

    const error = (await request('https://calendar.example.ca/default/List').catch((e: unknown) => e)) as HttpError
    expect(error).toBeInstanceOf(HttpError)
    expect(error.status).toBe(403)
    expect(error.body).toContain('Access denied')
    expect(error.headers).toEqual({
      'x-azure-ref': '20260916T042300Z-abc',
      server: 'Microsoft-Azure-Application-Gateway/v2',
      'content-type': 'text/html',
    })
    // A 403 is a decision, not a blip: no retries.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps only the headers on the list, and reads a host that says nothing extra', async () => {
    vi.stubGlobal('fetch', refusal({ 'x-frame-options': 'DENY' }))
    const error = (await getJson('https://calendar.example.ca/api').catch((e: unknown) => e)) as HttpError
    // Response supplies a content-type of its own; nothing else off the list survives.
    expect(Object.keys(error.headers)).toEqual(['content-type'])
    expect(error.message).toBe('HTTP 403 from https://calendar.example.ca/api')
  })
})

describe('the Canadian fetch proxy', () => {
  const CONFIG = {
    functionName: 'scec-ca-fetch-proxy',
    region: 'ca-central-1',
    accessKeyId: 'AKIAEXAMPLEEXAMPLE',
    secretAccessKey: 'secret-example-key',
  }
  const INVOKE_URL = 'https://lambda.ca-central-1.amazonaws.com/2015-03-31/functions/scec-ca-fetch-proxy/invocations'
  const TARGET = 'https://calendar.midland.ca/default/List?StartDate=09/02/2026'

  afterEach(() => setFetchProxy(null))

  /** A direct 403, then whatever the Lambda is told to answer. */
  const stub = (lambda: () => Response) => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init })
      if (url.startsWith('https://lambda.')) return lambda()
      return new Response('<html>Access to the requested resource has been blocked</html>', { status: 403 })
    })
    return calls
  }

  it('retries a 403 through a signed Lambda invoke, carrying the address and the user agent', async () => {
    setFetchProxy(CONFIG)
    const calls = stub(() => new Response(JSON.stringify({ status: 200, body: '<html>(102 Results Found)</html>', headers: {} })))

    expect(await request(TARGET)).toContain('102 Results Found')
    expect(calls).toHaveLength(2)
    const invoke = calls[1]!
    expect(invoke.url).toBe(INVOKE_URL)
    expect(invoke.init.method).toBe('POST')
    const headers = invoke.init.headers as Record<string, string>
    expect(headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLEEXAMPLE\/\d{8}\/ca-central-1\/lambda\/aws4_request, SignedHeaders=host;x-amz-date, Signature=[0-9a-f]{64}$/)
    expect(headers['X-Amz-Date']).toMatch(/^\d{8}T\d{6}Z$/)
    const payload = JSON.parse(invoke.init.body as string)
    expect(payload.url).toBe(TARGET)
    expect(payload.userAgent).toContain('simcoe-county-events')
  })

  it('carries the calendar’s own refusal back, and never loops', async () => {
    setFetchProxy(CONFIG)
    const calls = stub(() => new Response(JSON.stringify({ status: 403, body: 'still blocked', headers: { 'x-azure-ref': 'ref123' } })))

    const error = (await request(TARGET).catch((e: unknown) => e)) as HttpError
    expect(error).toBeInstanceOf(HttpError)
    expect(error.status).toBe(403)
    expect(error.body).toBe('still blocked')
    expect(error.headers['x-azure-ref']).toBe('ref123')
    expect(calls).toHaveLength(2)
  })

  it('says when the failure is the proxy’s own, not the calendar’s', async () => {
    setFetchProxy(CONFIG)
    stub(() => new Response(JSON.stringify({ status: 502, proxyError: 'proxy could not reach calendar.midland.ca: timeout' })))
    await expect(request(TARGET)).rejects.toThrow(/fetch proxy: proxy could not reach/)

    setFetchProxy(CONFIG)
    stub(() => new Response('{"errorMessage":"boom"}', { status: 200, headers: { 'x-amz-function-error': 'Unhandled' } }))
    await expect(request(TARGET)).rejects.toThrow(/the Lambda failed/)

    setFetchProxy(CONFIG)
    stub(() => new Response('denied', { status: 403 }))
    await expect(request(TARGET)).rejects.toThrow(/Lambda answered 403/)
  })

  it('leaves the 403 alone when no proxy is configured, or when it is half configured', async () => {
    const calls = stub(() => new Response('{}'))
    await expect(request(TARGET)).rejects.toThrow(/HTTP 403/)
    expect(calls).toHaveLength(1)

    setFetchProxy({ functionName: 'scec-ca-fetch-proxy', region: 'ca-central-1' })
    expect(fetchProxyConfigured()).toBe(false)
    setFetchProxy(CONFIG)
    expect(fetchProxyConfigured()).toBe(true)
  })

  it('goes straight through the proxy when forced, for testing from a machine nobody blocks', async () => {
    setFetchProxy({ ...CONFIG, force: true })
    const calls = stub(() => new Response(JSON.stringify({ status: 200, body: 'forced' })))
    expect(await request(TARGET)).toBe('forced')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(INVOKE_URL)
  })
})
