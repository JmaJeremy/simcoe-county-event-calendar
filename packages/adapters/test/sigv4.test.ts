import { describe, expect, it } from 'vitest'
import { signLambdaInvoke } from '../src/sigv4.ts'

/**
 * Signing is the whole of the proxy's authentication, and a wrong signature is a 403 that
 * looks exactly like the one the proxy exists to route around. These pin the parts AWS
 * checks: the credential scope, the signed headers, and a signature that is the same every
 * time for the same request.
 */

const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'ca-central-1' }
const at = new Date('2026-09-16T05:30:00.000Z')

describe('signLambdaInvoke', () => {
  it('signs a POST to the function’s invocations path', async () => {
    const signed = await signLambdaInvoke(credentials, 'scec-ca-fetch-proxy', { url: 'https://calendar.midland.ca/' }, at)
    expect(signed.url).toBe('https://lambda.ca-central-1.amazonaws.com/2015-03-31/functions/scec-ca-fetch-proxy/invocations')
    expect(signed.body).toBe('{"url":"https://calendar.midland.ca/"}')
    expect(signed.headers['X-Amz-Date']).toBe('20260916T053000Z')
    expect(signed.headers.Authorization).toContain('Credential=AKIDEXAMPLE/20260916/ca-central-1/lambda/aws4_request')
    expect(signed.headers.Authorization).toContain('SignedHeaders=host;x-amz-date')
  })

  it('is deterministic, and changes with the payload, the key, the region and the minute', async () => {
    const base = await signLambdaInvoke(credentials, 'fn', { url: 'https://a.ca/' }, at)
    const again = await signLambdaInvoke(credentials, 'fn', { url: 'https://a.ca/' }, at)
    expect(again.headers.Authorization).toBe(base.headers.Authorization)

    const other = await signLambdaInvoke(credentials, 'fn', { url: 'https://b.ca/' }, at)
    const otherKey = await signLambdaInvoke({ ...credentials, secretAccessKey: 'another' }, 'fn', { url: 'https://a.ca/' }, at)
    const otherRegion = await signLambdaInvoke({ ...credentials, region: 'us-east-1' }, 'fn', { url: 'https://a.ca/' }, at)
    const later = await signLambdaInvoke(credentials, 'fn', { url: 'https://a.ca/' }, new Date('2026-09-16T05:31:00.000Z'))
    for (const variant of [other, otherKey, otherRegion, later]) {
      expect(variant.headers.Authorization).not.toBe(base.headers.Authorization)
    }
    expect(otherRegion.url).toContain('lambda.us-east-1.amazonaws.com')
  })
})
