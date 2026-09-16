import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpError, getJson, request } from '../src/http.ts'

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
