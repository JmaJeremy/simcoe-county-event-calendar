import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'

/**
 * Cloudflare Access, checked by the worker itself.
 *
 * Access guards console.outinsimcoe.ca at the edge, but only that hostname: the same
 * worker also answers on workers.dev, where nothing stands in front of it. So every
 * console request must carry a token Access signed for this application, verified here
 * — signature against the team's published keys, issuer, audience and expiry. A request
 * that merely claims to have come through Access proves nothing.
 */

export interface AccessSettings {
  /** 'https://<team>.cloudflareaccess.com', exactly as it appears in the token's `iss`. */
  teamDomain: string
  /** The Access application's AUD tag. */
  audience: string
}

export type AccessResult = { ok: true; email: string } | { ok: false; reason: string }

/*
 * One key set per team, kept for the life of the isolate. jose caches the keys and
 * refetches when a token names a key id it has not seen, which is how Access's six-weekly
 * key rotation is survived without a deploy. Never hardcode a key: see Cloudflare's note
 * on validating against `kid` rather than a stored certificate.
 */
const keySets = new Map<string, JWTVerifyGetKey>()
const remoteKeys = (teamDomain: string): JWTVerifyGetKey => {
  let keys = keySets.get(teamDomain)
  if (!keys) {
    keys = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', teamDomain))
    keySets.set(teamDomain, keys)
  }
  return keys
}

/**
 * @param keys Only for tests, which sign tokens with a local key pair.
 */
export async function verifyAccess(
  request: Request,
  settings: Partial<AccessSettings>,
  keys?: JWTVerifyGetKey,
): Promise<AccessResult> {
  // Unconfigured means closed, never open.
  if (!settings.teamDomain || !settings.audience) return { ok: false, reason: 'access-not-configured' }

  // The header, not the CF_Authorization cookie: Cloudflare only guarantees the header,
  // and it is set by Access itself rather than replayed by the browser.
  const token = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!token) return { ok: false, reason: 'no-token' }

  try {
    const { payload } = await jwtVerify(token, keys ?? remoteKeys(settings.teamDomain), {
      issuer: settings.teamDomain,
      audience: settings.audience,
      algorithms: ['RS256'],
    })
    // The console acts for a person. A service token carries no email, and nothing here
    // is meant to be scripted.
    const email = typeof payload.email === 'string' ? payload.email : ''
    if (!email) return { ok: false, reason: 'no-email' }
    return { ok: true, email }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? (err as { code?: string }).code ?? err.name : 'invalid-token' }
  }
}

/**
 * Whether a write came from the console's own pages.
 *
 * Access authenticates with a cookie, and a browser sends that cookie with a form another
 * site posts to the console — Access then adds a perfectly valid token. So a valid token
 * is not enough for a write: the request must also say it came from this origin. Browsers
 * set both headers themselves and a page cannot forge them.
 */
export function isSameOriginWrite(request: Request, host: string): boolean {
  const site = request.headers.get('Sec-Fetch-Site')
  if (site && site !== 'same-origin') return false
  return request.headers.get('Origin') === `https://${host}`
}
