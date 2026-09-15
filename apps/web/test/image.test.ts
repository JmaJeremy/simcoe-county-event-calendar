import { describe, expect, it } from 'vitest'
import { inspectImage, stripMetadata, type ImageKind } from '../src/image.ts'

/** Bytes from numbers and ASCII strings, in order. */
const bytes = (...values: Array<number | string>) =>
  new Uint8Array(values.flatMap((v) => (typeof v === 'string' ? [...v].map((c) => c.charCodeAt(0)) : [v])))

const u16 = (n: number) => [n >> 8, n & 0xff]
const u32 = (n: number) => [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
const u32le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24]
const text = (b: Uint8Array) => String.fromCharCode(...b)

const JPEG: ImageKind = { ext: 'jpg', contentType: 'image/jpeg' }
const PNG: ImageKind = { ext: 'png', contentType: 'image/png' }
const WEBP: ImageKind = { ext: 'webp', contentType: 'image/webp' }

describe('inspectImage', () => {
  it('recognises the four formats a browser can show, by their first bytes', () => {
    expect(inspectImage(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 'JFIF'))).toEqual(JPEG)
    expect(inspectImage(bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d))).toEqual(PNG)
    expect(inspectImage(bytes('GIF89a', 1, 0))).toEqual({ ext: 'gif', contentType: 'image/gif' })
    expect(inspectImage(bytes('RIFF', 0x24, 0, 0, 0, 'WEBPVP8 '))).toEqual(WEBP)
  })

  it('refuses a file whose name or declared type claims to be an image', () => {
    // What arrives as "poster.jpg" with Content-Type image/jpeg is only ever these bytes.
    expect(inspectImage(bytes('<html><script>alert(1)</script>'))).toBeNull()
  })

  it('refuses SVG, which can carry script, and HEIC, which browsers cannot show', () => {
    expect(inspectImage(bytes('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull()
    expect(inspectImage(bytes(0, 0, 0, 0x18, 'ftypheic', 0, 0, 0, 0))).toBeNull()
  })

  it('refuses a RIFF file that is not WebP, and anything too short to tell', () => {
    expect(inspectImage(bytes('RIFF', 0x24, 0, 0, 0, 'WAVEfmt '))).toBeNull()
    expect(inspectImage(bytes(0xff, 0xd8))).toBeNull()
    expect(inspectImage(new Uint8Array())).toBeNull()
  })
})

/** A JPEG segment: marker, then a length that counts itself. */
const segment = (marker: number, ...payload: Array<number | string>) => {
  const body = bytes(...payload)
  return [0xff, marker, ...u16(body.length + 2), ...body]
}

/** An EXIF block as a phone writes it: orientation plus a GPS pointer and a device name. */
const phoneExif = (orientation: number) => {
  const tiff = [
    ...bytes('MM'), ...u16(0x2a), ...u32(8),
    ...u16(3),
    ...u16(0x010f), ...u16(2), ...u32(4), ...bytes('ACME'), // Make
    ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0,
    ...u16(0x8825), ...u16(4), ...u32(1), ...u32(50), // GPS IFD pointer
    ...u32(0),
    ...bytes('GPS 44.6082N 79.4197W'),
  ]
  return segment(0xe1, 'Exif\0\0', ...tiff)
}

const jpeg = (...segments: number[][]) =>
  new Uint8Array([
    0xff, 0xd8,
    ...segments.flat(),
    ...segment(0xdb, 0, ...new Array(64).fill(1)), // quantisation table
    ...segment(0xda, 1, 1, 0, 0, 63, 0), // start of scan
    0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, // compressed data: a stuffed FF and a restart marker
    0xff, 0xd9,
    ...bytes('ftypmp42 motion photo video, recorded at home'),
  ])

describe('stripMetadata', () => {
  it('takes GPS, device, comments and trailing video out of a phone JPEG', () => {
    const stripped = stripMetadata(
      jpeg(
        segment(0xe0, 'JFIF\0', 1, 1, 0, 0, 1, 0, 1, 0, 0),
        phoneExif(6),
        segment(0xe1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>Barrie, Ontario</x:xmpmeta>'),
        segment(0xe2, 'ICC_PROFILE\0', 1, 1, 'sRGB'),
        segment(0xe2, 'MPF\0', 'second picture'),
        segment(0xed, 'Photoshop 3.0\0', 'by-line: Sam'),
        segment(0xfe, 'taken on Sam’s phone'),
      ),
      JPEG,
    )!
    const out = text(stripped)
    for (const leak of ['GPS', 'ACME', 'Barrie', 'second picture', 'Sam', 'motion photo']) expect(out).not.toContain(leak)
    expect(out).toContain('JFIF')
    expect(out).toContain('ICC_PROFILE')
    expect([...stripped.slice(-2)]).toEqual([0xff, 0xd9])
    expect(inspectImage(stripped)).toEqual(JPEG)
  })

  it('keeps a phone photo the right way up, with its orientation as the only EXIF entry', () => {
    const stripped = stripMetadata(jpeg(segment(0xe0, 'JFIF\0', 1, 1, 0, 0, 1, 0, 1, 0, 0), phoneExif(6)), JPEG)!
    // SOI, then the 18-byte JFIF segment, then the new EXIF block.
    const exif = stripped.subarray(20, 56)
    expect([exif[0], exif[1]]).toEqual([0xff, 0xe1])
    expect(text(exif.subarray(4, 10))).toBe('Exif\0\0')
    expect([...exif.subarray(18, 30)]).toEqual([0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6])
    // Reading it back through the same parser finds the orientation again.
    expect(text(stripMetadata(stripped, JPEG)!)).toBe(text(stripped))
  })

  it('writes no EXIF at all when the photo was upright', () => {
    expect(text(stripMetadata(jpeg(phoneExif(1)), JPEG)!)).not.toContain('Exif')
    expect(text(stripMetadata(jpeg(), JPEG)!)).not.toContain('Exif')
  })

  it('leaves a clean JPEG byte for byte, apart from what follows its end', () => {
    const clean = jpeg(segment(0xe0, 'JFIF\0', 1, 1, 0, 0, 1, 0, 1, 0, 0))
    const stripped = stripMetadata(clean, JPEG)!
    const end = text(clean).indexOf('ftypmp42')
    expect([...stripped]).toEqual([...clean.subarray(0, end)])
  })

  it('refuses a JPEG it cannot walk', () => {
    expect(stripMetadata(bytes(0xff, 0xd8, 0x00, 0x01, 0x02, 0x03), JPEG)).toBeNull()
    expect(stripMetadata(bytes(0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x00), JPEG)).toBeNull()
    // Headers and no picture.
    expect(stripMetadata(new Uint8Array([0xff, 0xd8, ...segment(0xe0, 'JFIF\0')]), JPEG)).toBeNull()
  })

  const chunk = (type: string, ...data: Array<number | string>) => {
    const body = bytes(...data)
    return [...u32(body.length), ...bytes(type), ...body, 0xde, 0xad, 0xbe, 0xef]
  }

  it('drops text, EXIF and timestamp chunks from a PNG and keeps the picture', () => {
    const png = new Uint8Array([
      0x89, ...bytes('PNG'), 0x0d, 0x0a, 0x1a, 0x0a,
      ...chunk('IHDR', ...u32(1), ...u32(1), 8, 6, 0, 0, 0),
      ...chunk('tEXt', 'Location\0', '44.6082N 79.4197W'),
      ...chunk('iTXt', 'Author\0', 0, 0, '\0\0', 'Sam'),
      ...chunk('eXIf', 'MM', 0, 0x2a, 'GPS'),
      ...chunk('tIME', 7, 0xea, 9, 14, 12, 0, 0),
      ...chunk('iCCP', 'sRGB\0', 0, 1, 2),
      ...chunk('IDAT', 1, 2, 3),
      ...chunk('IEND'),
      ...bytes('trailing'),
    ])
    const out = text(stripMetadata(png, PNG)!)
    for (const leak of ['Location', 'Sam', 'GPS', 'tIME', 'trailing']) expect(out).not.toContain(leak)
    for (const kept of ['IHDR', 'iCCP', 'IDAT']) expect(out).toContain(kept)
    expect(out.endsWith('IEND\xde\xad\xbe\xef')).toBe(true)
  })

  it('refuses a PNG that ends before IEND', () => {
    expect(stripMetadata(new Uint8Array([0x89, ...bytes('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', 1, 2)]), PNG)).toBeNull()
  })

  it('drops EXIF and XMP from a WebP, clears their flags and fixes the RIFF size', () => {
    const riffChunk = (fourcc: string, ...data: Array<number | string>) => {
      const body = bytes(...data)
      return [...bytes(fourcc), ...u32le(body.length), ...body, ...(body.length % 2 ? [0] : [])]
    }
    const body = [
      ...bytes('WEBP'),
      ...riffChunk('VP8X', 0x2c, 0, 0, 0, 0, 0, 0, 0, 0, 0), // ICC + EXIF + XMP flags
      ...riffChunk('ICCP', 'sRGB'),
      ...riffChunk('VP8L', 0x2f, 1, 2, 3, 4),
      ...riffChunk('EXIF', 'MM', 0, 0x2a, 'GPS 44.6N'),
      ...riffChunk('XMP ', '<x:xmpmeta>Sam</x:xmpmeta>'),
    ]
    const webp = new Uint8Array([...bytes('RIFF'), ...u32le(body.length), ...body])
    const stripped = stripMetadata(webp, WEBP)!
    const out = text(stripped)
    for (const leak of ['GPS', 'Sam', 'EXIF', 'XMP ']) expect(out).not.toContain(leak)
    expect(out).toContain('VP8L')
    expect(stripped[20]).toBe(0x20) // only the ICC flag is left
    expect(new DataView(stripped.buffer).getUint32(4, true)).toBe(stripped.length - 8)
    expect(inspectImage(stripped)).toEqual(WEBP)
  })
})
