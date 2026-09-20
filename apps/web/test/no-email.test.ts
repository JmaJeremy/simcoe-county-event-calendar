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
