import { escapeHtml } from './html.ts'

/**
 * Event descriptions, which may carry a little markdown.
 *
 * Hand-entered descriptions are written with it, and some sources already type it —
 * "**Global Pet Foods**", "*Free* admission" — which used to show as literal stars. The
 * subset is small on purpose: bold, italic, links, bullet lists, and the paragraphs and
 * line breaks the text already has. No headings, images, raw HTML or `_underscores_`:
 * nobody writes those here, and underscores turn up inside scraped names and addresses.
 *
 * Everything is escaped first, so the only markup in the output is what this adds, and a
 * link must be http(s).
 */

const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"]+)/g
const BULLET = /^[-*]\s+(.*)$/

/** A bare URL keeps sentence punctuation outside the link: "see https://x.ca." */
function splitTrailing(url: string): [string, string] {
  // A source that cut an address short with "…" leaves the ellipsis outside the link too.
  const match = url.match(/[.,;:!?'"…]+$|\)+$/)
  if (!match) return [url, '']
  // A closing bracket belongs to the URL when the URL opened one.
  if (match[0].startsWith(')') && url.includes('(')) return [url, '']
  return [url.slice(0, -match[0].length), match[0]]
}

/*
 * A backslash makes the next character literal, as in markdown: sources write "\*" to mean
 * a star. Escaped characters are swapped for private-use stand-ins before any rule runs,
 * so no rule can read them as syntax, and swapped back at the end.
 */
const ESCAPED = /\\([\\*_[\]()#+\-.!`])/g
const hide = (text: string): string => text.replace(ESCAPED, (_, c: string) => String.fromCharCode(0xe000 + c.charCodeAt(0)))
const unhide = (text: string): string => text.replace(/[\ue000-\ue07f]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xe000))

const BOLD_ITALIC = /\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*/g
const BOLD = /\*\*(?=\S)(.+?)(?<=\S)\*\*/g
// A lone star stays a star: "Tickets $10*", "2*3", "*Registration required".
const ITALIC = /(^|[^\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])/g
// The same, for escaped text: italics may not straddle a bold, or the tags cross.
const ITALIC_HTML = /(^|[^\w*])\*(?=[^\s*])((?:(?!<\/?strong>).)+?)(?<=[^\s*])\*(?![\w*])/g

/** Bold and italic, on text that is already escaped. */
const emphasis = (html: string): string =>
  html
    .replace(BOLD_ITALIC, '<strong><em>$1</em></strong>')
    .replace(BOLD, '<strong>$1</strong>')
    .replace(ITALIC_HTML, '$1<em>$2</em>')

function inline(text: string): string {
  let out = ''
  let last = 0
  for (const match of text.matchAll(LINK)) {
    out += emphasis(escapeHtml(text.slice(last, match.index)))
    const [whole, label, target, bare] = match
    if (bare) {
      const [url, trailing] = splitTrailing(bare)
      out += `<a href="${escapeHtml(url)}" rel="nofollow noopener noreferrer">${escapeHtml(url)}</a>${escapeHtml(trailing)}`
    } else {
      out += `<a href="${escapeHtml(target!)}" rel="nofollow noopener noreferrer">${emphasis(escapeHtml(label!))}</a>`
    }
    last = match.index! + whole.length
  }
  return out + emphasis(escapeHtml(text.slice(last)))
}

/** A blank line starts a paragraph, a line break stays one, and "- " lines make a list. */
export function descriptionHtml(text: string): string {
  return unhide(hideAndRender(hide(text)))
}

function hideAndRender(text: string): string {
  return text
    .trim()
    .split(/\n[^\S\n]*\n\s*/)
    .map((block) => {
      let html = ''
      let lines: string[] = []
      let items: string[] = []
      const flush = () => {
        if (lines.length) html += `<p>${lines.map((l) => inline(l.trim())).join('<br>')}</p>`
        if (items.length) html += `<ul>${items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`
        lines = []
        items = []
      }
      for (const line of block.split('\n')) {
        const bullet = line.trim().match(BULLET)
        if (bullet) {
          if (lines.length) flush()
          items.push(bullet[1]!)
        } else {
          if (items.length) flush()
          lines.push(line)
        }
      }
      flush()
      return html
    })
    .join('')
}

/** The same text without the markdown, for places that take plain text: JSON-LD, iCal. */
export const descriptionText = (text: string): string =>
  unhide(
    hide(text)
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)')
      .replace(BOLD_ITALIC, '$1')
      .replace(BOLD, '$1')
      .replace(ITALIC, '$1$2')
      .replace(/^\*\s+/gm, '- '),
  )
