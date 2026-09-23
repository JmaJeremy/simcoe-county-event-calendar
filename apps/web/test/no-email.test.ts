import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * No email address may be served whole.
 *
 * Harvesters read page source and scripts looking for `name@domain`. The site's address
 * is shown to people through decoys (suggest.html) or assembled at runtime (suggest.js),
 * and the worker's responses carry a {contact} placeholder instead. This pins all three,
 * so a later edit that pastes the address back in fails here rather than in a spam folder.
 */

const PUBLIC = new URL('../public/', import.meta.url)
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}/gi
/** The same pattern after decoding the entity a hand-obfuscation might reach for. */
const decode = (text: string) => text.replace(/&#64;|&#x40;/gi, '@')

describe('served files', () => {
  const files = readdirSync(PUBLIC).filter((name) => /\.(html|js|css|json|svg)$/.test(name))

  it('checks every text asset', () => {
    expect(files).toEqual(expect.arrayContaining(['index.html', 'suggest.html', 'privacy.html', 'suggest.js', 'app.js']))
  })

  for (const name of files) {
    it(`${name} contains no harvestable email address`, () => {
      const source = readFileSync(new URL(name, PUBLIC), 'utf8')
      expect(decode(source).match(EMAIL) ?? []).toEqual([])
    })
  }

  it('a tag-stripping harvester reads a decoy, not the real address, from the form page', () => {
    const stripped = decode(readFileSync(new URL('suggest.html', PUBLIC), 'utf8').replace(/<[^>]+>/g, ''))
    const found = stripped.match(EMAIL) ?? []
    expect(found.length).toBeGreaterThan(0)
    expect(found).not.toContain('contact@outinsimcoe.ca')
  })
})

describe('worker responses', () => {
  it('never put the address in a reply', () => {
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
    const replies = worker.split('\n').filter((line) => /\breply\(/.test(line) || /^\s*[?:]\s*`/.test(line))
    // A fresh, non-global pattern: `.test` on the shared /g one would carry lastIndex
    // from line to line and skip matches.
    const email = new RegExp(EMAIL.source, 'i')
    expect(replies.filter((line) => line.includes('ADMIN_ADDRESS') || email.test(line))).toEqual([])
  })
})

describe('worker source', () => {
  /**
   * Every server-rendered surface, not only worker.ts: the account pages made src/ a
   * place served text is written, so the whole tree is scanned. The one address allowed
   * anywhere is ADMIN_ADDRESS's own definition in mail.ts — it belongs in mail headers,
   * and anything else email-shaped in src is on its way into a page or a reply.
   */
  const SRC = new URL('../src/', import.meta.url)
  const walk = (dir: URL): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(new URL(`${entry.name}/`, dir)) : entry.name.endsWith('.ts') ? [new URL(entry.name, dir).pathname] : [],
    )

  it('covers the whole tree, including the auth pages', () => {
    const files = walk(SRC).map((p) => p.split('/src/')[1])
    expect(files).toEqual(expect.arrayContaining(['worker.ts', 'mail.ts', 'auth/routes.ts', 'auth/pages.ts']))
  })

  for (const path of walk(SRC)) {
    const short = path.split('/src/')[1]!
    it(`${short} carries no email address beyond ADMIN_ADDRESS's definition`, () => {
      const lines = decode(readFileSync(path, 'utf8')).split('\n')
      const email = new RegExp(EMAIL.source, 'i')
      const offending = lines.filter(
        (line) => email.test(line) && !(short === 'mail.ts' && line.includes("export const ADMIN_ADDRESS")),
      )
      expect(offending).toEqual([])
    })
  }
})
