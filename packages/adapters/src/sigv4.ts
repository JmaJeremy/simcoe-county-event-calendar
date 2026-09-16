/**
 * AWS Signature Version 4, enough of it to invoke one Lambda.
 *
 * The ingest worker calls a Lambda in ca-central-1 to fetch the municipal calendars that
 * refuse requests from outside Canada (see http.ts). Public function URLs are blocked in
 * that AWS account, so the call goes to the Lambda Invoke API and has to be signed. This is
 * the whole of what that needs: a POST, no session token, no query string, two signed
 * headers. Web Crypto only, so it runs in a Worker and under vitest alike.
 */

const encoder = new TextEncoder()

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')

const sha256 = async (value: string): Promise<string> => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)))

async function hmac(key: ArrayBuffer | Uint8Array, value: string): Promise<ArrayBuffer> {
  // The ES lib this compiles against has no BufferSource; both shapes are one at runtime.
  const cryptoKey = await crypto.subtle.importKey('raw', key as ArrayBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(value))
}

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  region: string
}

export interface SignedRequest {
  url: string
  headers: Record<string, string>
  body: string
}

/**
 * A signed `POST /2015-03-31/functions/{name}/invocations`.
 *
 * @param now Only the tests pass this; the signature is valid for five minutes either side.
 */
export async function signLambdaInvoke(
  credentials: AwsCredentials,
  functionName: string,
  payload: unknown,
  now: Date = new Date(),
): Promise<SignedRequest> {
  const { accessKeyId, secretAccessKey, region } = credentials
  const host = `lambda.${region}.amazonaws.com`
  const path = `/2015-03-31/functions/${encodeURIComponent(functionName)}/invocations`
  const body = JSON.stringify(payload)

  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '')
  const date = amzDate.slice(0, 8)
  const scope = `${date}/${region}/lambda/aws4_request`

  const payloadHash = await sha256(body)
  const canonicalRequest = [
    'POST',
    path,
    '',
    `host:${host}`,
    `x-amz-date:${amzDate}`,
    '',
    'host;x-amz-date',
    payloadHash,
  ].join('\n')

  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256(canonicalRequest)].join('\n')

  let key = await hmac(encoder.encode(`AWS4${secretAccessKey}`), date)
  for (const part of [region, 'lambda', 'aws4_request']) key = await hmac(key, part)
  const signature = hex(await hmac(key, stringToSign))

  return {
    url: `https://${host}${path}`,
    headers: {
      'X-Amz-Date': amzDate,
      'Content-Type': 'application/json',
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=host;x-amz-date, Signature=${signature}`,
    },
    body,
  }
}
