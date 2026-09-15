/**
 * Poster images uploaded with a suggestion: what a file really is, and what it must not
 * carry when it is kept.
 *
 * Kept free of Worker bindings so all of it runs under vitest.
 */

/** Big enough for a phone photo of a poster, small enough that the form stays quick. */
export const MAX_POSTER_BYTES = 5 * 1024 * 1024

export interface ImageKind {
  ext: 'jpg' | 'png' | 'gif' | 'webp'
  contentType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
}

/**
 * What a file is, decided from its first bytes — never from its name or the type the
 * browser declared, since both are whatever the sender says. SVG is refused outright, as
 * it can carry script; HEIC is refused because browsers cannot show it.
 */
export function inspectImage(bytes: Uint8Array): ImageKind | null {
  const has = (signature: number[], offset = 0): boolean =>
    bytes.length >= offset + signature.length && signature.every((byte, i) => bytes[offset + i] === byte)
  if (has([0xff, 0xd8, 0xff])) return { ext: 'jpg', contentType: 'image/jpeg' }
  if (has([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: 'png', contentType: 'image/png' }
  if (has([0x47, 0x49, 0x46, 0x38])) return { ext: 'gif', contentType: 'image/gif' }
  // "RIFF", four bytes of length, then "WEBP".
  if (has([0x52, 0x49, 0x46, 0x46]) && has([0x57, 0x45, 0x42, 0x50], 8)) return { ext: 'webp', contentType: 'image/webp' }
  return null
}

/**
 * The image without the metadata cameras and phones write into it.
 *
 * A phone photo of a poster on a noticeboard carries the phone's GPS position — often
 * the suggester's street — along with the device and the time, and an approved poster is
 * published on the event page. So the stored copy keeps only what draws the picture.
 * Two exceptions, because without them the picture draws wrong: a JPEG keeps its
 * orientation (rewritten as a one-entry EXIF block; a phone photo without it shows
 * sideways) and its colour profile.
 *
 * Returns null when the file is too malformed to walk, which the caller refuses as not an
 * image: a file this cannot read is a file this cannot vouch for.
 */
export function stripMetadata(bytes: Uint8Array, kind: ImageKind): Uint8Array | null {
  switch (kind.ext) {
    case 'jpg':
      return stripJpeg(bytes)
    case 'png':
      return stripPng(bytes)
    case 'webp':
      return stripWebp(bytes)
    case 'gif':
      // GIF has no EXIF or GPS block; nothing a camera writes ends up in one.
      return bytes
  }
}

const viewOf = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

const startsWith = (bytes: Uint8Array, offset: number, text: string): boolean =>
  offset + text.length <= bytes.length && [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0))

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/*
 * JPEG: a run of marker segments, then the compressed picture. Kept: the segments that
 * decode it (tables, frame, scan), JFIF (APP0), the ICC colour profile (APP2) and Adobe's
 * colour-transform flag (APP14, without which a CMYK file decodes in the wrong colours).
 * Dropped: EXIF and XMP (APP1), MPF secondary images (APP2), IPTC (APP13), every other
 * APPn, comments, and anything after the end-of-image marker — where phones append
 * motion-photo video.
 */
function stripJpeg(bytes: Uint8Array): Uint8Array | null {
  const view = viewOf(bytes)
  const kept: Uint8Array[] = [bytes.subarray(0, 2)]
  let orientation: number | null = null
  let pos = 2
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) return null
    const marker = bytes[pos + 1]!
    // Fill bytes may pad between segments.
    if (marker === 0xff) {
      pos += 1
      continue
    }
    if (marker === 0xda) {
      // Start of scan. Inside compressed data a 0xFF is always followed by 0x00 or a
      // restart marker, so the first FF D9 from here is the true end of the image.
      let end = bytes.length
      for (let i = pos + 2; i + 1 < bytes.length; i++) {
        if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) {
          end = i + 2
          break
        }
      }
      kept.push(bytes.subarray(pos, end))
      // Straight after SOI, or after JFIF's APP0 when the file has one.
      const at = kept[1] && kept[1][1] === 0xe0 ? 2 : 1
      if (orientation && orientation !== 1) kept.splice(at, 0, exifOrientation(orientation))
      return concat(kept)
    }
    // Standalone markers carry no length. None belongs before the scan except these.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      kept.push(bytes.subarray(pos, pos + 2))
      pos += 2
      continue
    }
    const length = view.getUint16(pos + 2)
    const end = pos + 2 + length
    if (length < 2 || end > bytes.length) return null
    const data = pos + 4

    let keep: boolean
    if (marker === 0xe1) {
      if (startsWith(bytes, data, 'Exif\0\0')) orientation = readOrientation(bytes, data + 6, end) ?? orientation
      keep = false
    } else if (marker === 0xe0) keep = true
    else if (marker === 0xe2) keep = startsWith(bytes, data, 'ICC_PROFILE\0')
    else if (marker === 0xee) keep = startsWith(bytes, data, 'Adobe')
    else if ((marker >= 0xe3 && marker <= 0xef) || marker === 0xfe) keep = false
    else keep = true

    if (keep) kept.push(bytes.subarray(pos, end))
    pos = end
  }
  // Ran out before any picture data.
  return null
}

/** The EXIF Orientation tag (0x0112) from a TIFF structure, bounds-checked throughout. */
function readOrientation(bytes: Uint8Array, tiff: number, end: number): number | null {
  if (tiff + 8 > end) return null
  const little = startsWith(bytes, tiff, 'II')
  if (!little && !startsWith(bytes, tiff, 'MM')) return null
  const view = viewOf(bytes)
  const ifd = tiff + view.getUint32(tiff + 4, little)
  if (ifd + 2 > end) return null
  const count = view.getUint16(ifd, little)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > end) return null
    if (view.getUint16(entry, little) === 0x0112) {
      const value = view.getUint16(entry + 8, little)
      return value >= 1 && value <= 8 ? value : null
    }
  }
  return null
}

/** An APP1 segment holding one EXIF entry: Orientation. Nothing else survives. */
function exifOrientation(orientation: number): Uint8Array {
  const out = new Uint8Array(36)
  const view = viewOf(out)
  view.setUint16(0, 0xffe1)
  view.setUint16(2, 34)
  out.set([...'Exif\0\0MM'].map((c) => c.charCodeAt(0)), 4)
  view.setUint16(12, 0x2a) // TIFF magic
  view.setUint32(14, 8) // IFD0 right after the TIFF header
  view.setUint16(18, 1) // one entry
  view.setUint16(20, 0x0112) // Orientation
  view.setUint16(22, 3) // SHORT
  view.setUint32(24, 1) // one value
  view.setUint16(28, orientation) // left-justified in the four-byte field
  view.setUint32(32, 0) // no next IFD
  return out
}

/* PNG: chunks, each checksummed on its own, so dropping one needs no recalculation. */
const PNG_METADATA = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME'])

function stripPng(bytes: Uint8Array): Uint8Array | null {
  const view = viewOf(bytes)
  const kept: Uint8Array[] = [bytes.subarray(0, 8)]
  let pos = 8
  while (pos + 12 <= bytes.length) {
    const end = pos + 12 + view.getUint32(pos)
    if (end > bytes.length) return null
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8))
    if (!PNG_METADATA.has(type)) kept.push(bytes.subarray(pos, end))
    // Nothing after IEND is part of the image.
    if (type === 'IEND') return concat(kept)
    pos = end
  }
  return null
}

/*
 * WebP: a RIFF container. Metadata lives in EXIF and XMP chunks, announced by two flags in
 * the VP8X header; both the chunks and the flags go, and the RIFF size is rewritten.
 */
function stripWebp(bytes: Uint8Array): Uint8Array | null {
  const view = viewOf(bytes)
  const kept: Uint8Array[] = []
  let pos = 12
  while (pos + 8 <= bytes.length) {
    const fourcc = String.fromCharCode(...bytes.subarray(pos, pos + 4))
    const size = view.getUint32(pos + 4, true)
    if (pos + 8 + size > bytes.length) return null
    // Chunks are padded to an even length; tolerate a missing pad byte on the last one.
    const end = pos + 8 + size + (size & 1)
    let chunk = bytes.subarray(pos, Math.min(end, bytes.length))
    if (chunk.length < end - pos) chunk = concat([chunk, new Uint8Array(1)])

    if (fourcc === 'EXIF' || fourcc === 'XMP ') {
      // dropped
    } else if (fourcc === 'VP8X' && size >= 10) {
      const copy = chunk.slice()
      copy[8] = copy[8]! & ~0x0c // clear the EXIF (0x08) and XMP (0x04) flags
      kept.push(copy)
    } else kept.push(chunk)
    pos = end
  }
  const body = concat(kept)
  const header = bytes.slice(0, 12)
  viewOf(header).setUint32(4, body.length + 4, true)
  return concat([header, body])
}
