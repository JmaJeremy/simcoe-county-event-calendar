/**
 * Password hashing for Worker runtime: PBKDF2-HMAC-SHA256 behind a pepper.
 *
 * PBKDF2 is not a preference — bcrypt, scrypt and Argon2 do not exist in workerd without
 * shipping WebAssembly, and `crypto.subtle.deriveBits` is what the platform gives. At the
 * iteration counts a request budget allows, PBKDF2 alone is weak against offline attack,
 * so the real strength is the PEPPER: a Worker secret HMAC'd over the password before
 * PBKDF2 ever sees it. It is stored in no database, so an attacker holding a full dump of
 * scec-accounts has nothing to grind against. The iteration count then only needs to fit
 * the request budget, not an offline threat model. See docs/user-accounts.md.
 *
 * The encoded string names its own parameters — pbkdf2$sha256$<iterations>$<salt>$<hash>,
 * both parts base64url — so the count can rise later without invalidating stored hashes:
 * verify with what the record says, and `rehash` tells the caller to write a fresh one on
 * a successful sign-in below the current floor.
 */

/**
 * OWASP's 2023 floor for PBKDF2-HMAC-SHA256. Locally (Node webcrypto, M-series) one
 * derivation measures 67ms; deployed on scec-web-dev (2026-09-24) a sign-in attempt that
 * burns exactly one derivation answers in ~310-360ms against a ~185ms no-hash baseline,
 * so the derivation itself costs roughly 130-170ms on Cloudflare's metal. Comfortable.
 * If it ever stops fitting, lower it deliberately — the pepper is what makes a lower
 * count survivable — never silently.
 */
export const PBKDF2_ITERATIONS = 600_000

const encoder = new TextEncoder()

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const fromB64url = (text: string): Uint8Array => {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
}

/** HMAC-SHA256(pepper, password): what PBKDF2 actually stretches. */
async function peppered(password: string, pepper: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  return crypto.subtle.sign('HMAC', key, encoder.encode(password))
}

async function derive(password: string, pepper: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey('raw', await peppered(password, pepper), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations, hash: 'SHA-256' },
    material,
    256,
  )
  return new Uint8Array(bits)
}

/**
 * True when the byte strings match, in time independent of where they differ. Lengths are
 * public (both sides are 32-byte digests), so comparing them first leaks nothing.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

export async function hashPassword(password: string, pepper: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await derive(password, pepper, salt, iterations)
  return `pbkdf2$sha256$${iterations}$${b64url(salt)}$${b64url(hash)}`
}

export interface VerifyResult {
  ok: boolean
  /** True on success when the stored iteration count is below the current floor. */
  rehash: boolean
}

export async function verifyPassword(password: string, pepper: string, encoded: string): Promise<VerifyResult> {
  const parts = encoded.split('$')
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return { ok: false, rehash: false }
  const iterations = Number(parts[2])
  if (!Number.isInteger(iterations) || iterations < 1) return { ok: false, rehash: false }
  const candidate = await derive(password, pepper, fromB64url(parts[3]!), iterations)
  const ok = timingSafeEqual(candidate, fromB64url(parts[4]!))
  return { ok, rehash: ok && iterations < PBKDF2_ITERATIONS }
}
