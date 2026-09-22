import { describe, expect, it } from 'vitest'
import { imageSize } from '../src/image-size.ts'

/* Minimal real headers, written by hand: every format states its size in its first bytes,
   which is the whole reason a ranged request is enough. */

const bytes = (...parts: Array<number[] | string>) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)))

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

describe('imageSize', () => {
  it('reads a PNG from its IHDR', () => {
    const png = bytes(PNG_SIG, [0, 0, 0, 13], 'IHDR', [0, 0, 4, 176], [0, 0, 2, 118])
    expect(imageSize(png)).toEqual({ width: 1200, height: 630 })
  })

  it('reads a GIF, whose screen descriptor is little-endian', () => {
    expect(imageSize(bytes('GIF89a', [0x20, 0x03], [0x76, 0x02]))).toEqual({ width: 800, height: 630 })
  })

  it('reads all three WebP codings', () => {
    const riff = (chunk: string, rest: number[]) => bytes('RIFF', [0, 0, 0, 0], 'WEBP', chunk, rest)
    // Extended: 24-bit little-endian, stored one less than the real size.
    // 4 bytes of chunk size, then flags and reserved, then each dimension as 3 bytes.
    expect(imageSize(riff('VP8X', [0, 0, 0, 0, 0, 0, 0, 0, 0xaf, 0x04, 0x00, 0x75, 0x02, 0x00]))).toEqual({ width: 1200, height: 630 })
    // Lossy: 14 bits each, after a frame tag and start code.
    expect(imageSize(riff('VP8 ', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xb0, 0x04, 0x76, 0x02, 0, 0]))).toEqual({ width: 1200, height: 630 })
    // Lossless: packed across four bytes after the 0x2f signature.
    const packed = (1200 - 1) | ((630 - 1) << 14)
    expect(imageSize(riff('VP8L', [0, 0, 0, 0, 0x2f, packed & 0xff, (packed >>> 8) & 0xff, (packed >>> 16) & 0xff, (packed >>> 24) & 0xff, 0, 0, 0, 0, 0, 0, 0]))).toEqual({ width: 1200, height: 630 })
  })

  it('walks a JPEG past its other segments to the frame header', () => {
    // APP0/JFIF first, as nearly every JPEG has, then SOF0.
    const jpeg = bytes(
      [0xff, 0xd8],
      [0xff, 0xe0, 0x00, 0x10], 'JFIF', [0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
      [0xff, 0xc0, 0x00, 0x11, 0x08], [0x02, 0x76], [0x04, 0xb0], [3, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    )
    expect(imageSize(jpeg)).toEqual({ width: 1200, height: 630 })
  })

  it('says nothing rather than guess, for a truncated or unknown file', () => {
    // A JPEG whose frame header is past the range fetched: null, never a guess.
    expect(imageSize(bytes([0xff, 0xd8], [0xff, 0xe0, 0x00, 0x10], 'JFIF', [0, 1, 1, 0, 0]))).toBeNull()
    expect(imageSize(bytes('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull()
    expect(imageSize(bytes([]))).toBeNull()
    // A header that parses to zero is a bad parse, not a zero-pixel image.
    expect(imageSize(bytes(PNG_SIG, [0, 0, 0, 13], 'IHDR', [0, 0, 0, 0], [0, 0, 0, 0]))).toBeNull()
  })
})
