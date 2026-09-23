/**
 * An image's pixel size, read from the first bytes of the file.
 *
 * Facebook lays a share card out from `og:image:width`/`height` and will not hold a story
 * open while it fetches the picture to measure it, so a poster with no stated size shows
 * as a bare link the first time anyone shares the event — see `SHARE_IMAGE` in the web
 * worker for the other half of this. Our own card has a fixed size; a source's poster
 * arrives at whatever size that site chose, and the only way to know it is to look.
 *
 * Every format here states its size within the first few hundred bytes, except JPEG, whose
 * size sits in a frame header an arbitrary distance in — so callers fetch a range rather
 * than the whole file, and a JPEG that needs more than the range simply comes back null.
 * Null always means "cannot say", never "no image": a caller must not write a guess.
 */
export interface ImageSize {
  width: number
  height: number
}

const ascii = (b: Uint8Array, at: number, text: string): boolean =>
  text.split('').every((c, i) => b[at + i] === c.charCodeAt(0))

const be16 = (b: Uint8Array, at: number): number => (b[at]! << 8) | b[at + 1]!
const be32 = (b: Uint8Array, at: number): number =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0
const le16 = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8)

/** PNG: the IHDR chunk is always first, so the size is at a fixed offset. */
function png(b: Uint8Array): ImageSize | null {
  if (b.length < 24) return null
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (!signature.every((v, i) => b[i] === v)) return null
  if (!ascii(b, 12, 'IHDR')) return null
  return { width: be32(b, 16), height: be32(b, 20) }
}

/** GIF: little-endian, in the screen descriptor straight after the header. */
function gif(b: Uint8Array): ImageSize | null {
  if (b.length < 10 || !ascii(b, 0, 'GIF8')) return null
  return { width: le16(b, 6), height: le16(b, 8) }
}

/** WebP: three codings, each stating its size in a different place. */
function webp(b: Uint8Array): ImageSize | null {
  if (b.length < 30 || !ascii(b, 0, 'RIFF') || !ascii(b, 8, 'WEBP')) return null
  if (ascii(b, 12, 'VP8X')) return { width: (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1, height: (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1 }
  // Lossy: a 3-byte start code, then 14 bits of each dimension.
  if (ascii(b, 12, 'VP8 ')) return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff }
  // Lossless: 14 bits each, packed across the bytes after the 0x2f signature byte.
  if (ascii(b, 12, 'VP8L') && b[20] === 0x2f) {
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  return null
}

/**
 * JPEG: walk the marker segments to the frame header, which is the only place the size is
 * written. Markers are `FF xx`; most carry a two-byte length, and the frame ones (SOF0-3,
 * 5-7, 9-11, 13-15, but never the four that are something else) carry the dimensions.
 */
function jpeg(b: Uint8Array): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let at = 2
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) return null
    const marker = b[at + 1]!
    // Padding, and the standalone markers that carry no length.
    if (marker === 0xff) { at++; continue }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { at += 2; continue }
    const length = be16(b, at + 2)
    if (length < 2) return null
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc, 0xd8].includes(marker)
    if (isFrame) return { height: be16(b, at + 5), width: be16(b, at + 7) }
    // Entropy-coded data follows the scan header and is not a segment; stop rather than
    // read its bytes as markers.
    if (marker === 0xda) return null
    at += 2 + length
  }
  return null
}

/** The size, or null when these bytes do not state one. Never guesses. */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  const size = png(bytes) ?? gif(bytes) ?? webp(bytes) ?? jpeg(bytes)
  if (!size) return null
  // A zero or absurd dimension means the parse went wrong, not that the image is that big.
  const sane = (n: number) => Number.isInteger(n) && n > 0 && n <= 65535
  return sane(size.width) && sane(size.height) ? size : null
}

/**
 * Facebook's floor for a wide card. Below it the story gets a small square thumbnail, and
 * below 200px in either direction it gets no picture at all.
 */
export const LARGE_CARD = { width: 600, height: 315 }

/**
 * Whether a poster can be a share image at all, judged by its host.
 *
 * govStack calendars sit behind a WAF that answers 403 to anything that does not look like
 * a browser, share crawlers included: the poster renders perfectly for a visitor and not at
 * all for Facebook or Slack, which would turn every share of those events into a broken
 * image. Shared by the web worker, which keeps them out of `og:image`, and by the ingest
 * pass, which would otherwise spend a fetch measuring a poster nothing can ever share —
 * 208 of the first 1,009 rows measured were exactly that.
 */
export function shareablePoster(imageUrl: string | null | undefined): boolean {
  if (!imageUrl) return false
  const host = URL.parse?.(imageUrl)?.hostname ?? ''
  return !/^(calendar|events)\./i.test(host)
}
