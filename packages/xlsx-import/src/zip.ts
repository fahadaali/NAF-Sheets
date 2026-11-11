// Reading the zip container of an .xlsx (ECMA-376 Part 2, Open Packaging
// Conventions, over PKWARE's APPNOTE). Only what OOXML writers produce is
// accepted: stored (0) or deflated (8) entries, no encryption, no zip64,
// no multi-disk archives.
//
// Zip bombs: the central directory's declared sizes are checked first, but
// they can lie, so inflation itself counts the bytes it produces and stops
// the moment a part or the whole package goes over its limit
// (`XlsxImportError('too_large')`). Inflation uses the platform's
// `DecompressionStream('deflate-raw')` (Workers, Node ≥ 21.2, browsers), so
// no third-party decompressor is shipped.

import { XlsxImportError, type XlsxLimits } from './errors'

export interface ZipEntry {
  name: string
  method: number
  flags: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50
/** An OLE2 compound file (legacy .xls, or an encrypted OOXML package). */
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

function u16(b: Uint8Array, o: number): number {
  return (b[o] as number) | ((b[o + 1] as number) << 8)
}
function u32(b: Uint8Array, o: number): number {
  return ((b[o] as number) | ((b[o + 1] as number) << 8) | ((b[o + 2] as number) << 16) | ((b[o + 3] as number) << 24)) >>> 0
}

export function isOleCompoundFile(bytes: Uint8Array): boolean {
  return OLE_SIGNATURE.every((v, i) => bytes[i] === v)
}

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && u32(bytes, 0) === SIG_LOCAL
}

const utf8 = new TextDecoder('utf-8')
// CP437 is the zip default for names; OOXML part names are ASCII, so any
// non-UTF-8 name is decoded as Latin-1 and simply never matches a part.
const latin1 = new TextDecoder('latin1')

export class ZipArchive {
  readonly entries: Map<string, ZipEntry>
  private readonly bytes: Uint8Array
  private readonly limits: XlsxLimits
  private unpacked = 0

  private constructor(bytes: Uint8Array, entries: Map<string, ZipEntry>, limits: XlsxLimits) {
    this.bytes = bytes
    this.entries = entries
    this.limits = limits
  }

  static open(bytes: Uint8Array, limits: XlsxLimits): ZipArchive {
    if (bytes.length > limits.maxFileBytes) throw new XlsxImportError('too_large', `file of ${bytes.length} bytes`)
    if (isOleCompoundFile(bytes)) throw new XlsxImportError('legacy_or_encrypted')
    if (!isZip(bytes)) throw new XlsxImportError('not_xlsx', 'no zip signature')

    // End of central directory: 22 bytes plus a comment of up to 65535.
    const min = Math.max(0, bytes.length - 22 - 0xffff)
    let eocd = -1
    for (let o = bytes.length - 22; o >= min; o--) {
      if (u32(bytes, o) === SIG_EOCD) {
        eocd = o
        break
      }
    }
    if (eocd === -1) throw new XlsxImportError('corrupt', 'no end of central directory')
    const disk = u16(bytes, eocd + 4)
    const cdDisk = u16(bytes, eocd + 6)
    const count = u16(bytes, eocd + 10)
    const cdSize = u32(bytes, eocd + 12)
    const cdOffset = u32(bytes, eocd + 16)
    if (disk !== 0 || cdDisk !== 0) throw new XlsxImportError('corrupt', 'multi-disk archive')
    if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new XlsxImportError('corrupt', 'zip64 is not supported')
    if (count > limits.maxEntries) throw new XlsxImportError('too_large', `${count} entries`)
    if (cdOffset + cdSize > eocd) throw new XlsxImportError('corrupt', 'central directory out of range')

    const entries = new Map<string, ZipEntry>()
    let declaredTotal = 0
    let o = cdOffset
    for (let k = 0; k < count; k++) {
      if (o + 46 > bytes.length || u32(bytes, o) !== SIG_CENTRAL) throw new XlsxImportError('corrupt', 'bad central directory entry')
      const flags = u16(bytes, o + 8)
      const method = u16(bytes, o + 10)
      const compressedSize = u32(bytes, o + 20)
      const uncompressedSize = u32(bytes, o + 24)
      const nameLength = u16(bytes, o + 28)
      const extraLength = u16(bytes, o + 30)
      const commentLength = u16(bytes, o + 32)
      const localHeaderOffset = u32(bytes, o + 42)
      if (o + 46 + nameLength > bytes.length) throw new XlsxImportError('corrupt', 'entry name out of range')
      const rawName = bytes.subarray(o + 46, o + 46 + nameLength)
      const name = (flags & 0x0800 ? utf8 : latin1).decode(rawName)
      if (flags & 0x0001) throw new XlsxImportError('legacy_or_encrypted', 'encrypted zip entry')
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        throw new XlsxImportError('corrupt', 'zip64 is not supported')
      }
      if (uncompressedSize > limits.maxPartBytes) throw new XlsxImportError('too_large', `part ${name} declares ${uncompressedSize} bytes`)
      declaredTotal += uncompressedSize
      if (!name.endsWith('/')) {
        // Part names are case-insensitive (OPC §9.1.1.1); the first wins on a clash.
        const key = name.replace(/^\/+/, '').toLowerCase()
        if (!entries.has(key)) entries.set(key, { name, method, flags, compressedSize, uncompressedSize, localHeaderOffset })
      }
      o += 46 + nameLength + extraLength + commentLength
    }
    if (declaredTotal > limits.maxTotalBytes * 4) throw new XlsxImportError('too_large', `declares ${declaredTotal} bytes`)
    return new ZipArchive(bytes, entries, limits)
  }

  has(path: string): boolean {
    return this.entries.has(path.replace(/^\/+/, '').toLowerCase())
  }

  /** Every part name, as written in the archive. */
  names(): string[] {
    return [...this.entries.values()].map((e) => e.name)
  }

  /** The unpacked bytes of a part, or null when the archive has no such part. */
  async read(path: string): Promise<Uint8Array | null> {
    const entry = this.entries.get(path.replace(/^\/+/, '').toLowerCase())
    if (!entry) return null
    const b = this.bytes
    const lo = entry.localHeaderOffset
    if (lo + 30 > b.length || u32(b, lo) !== SIG_LOCAL) throw new XlsxImportError('corrupt', `bad local header for ${entry.name}`)
    const start = lo + 30 + u16(b, lo + 26) + u16(b, lo + 28)
    const end = start + entry.compressedSize
    if (end > b.length) throw new XlsxImportError('corrupt', `data of ${entry.name} out of range`)
    const data = b.subarray(start, end)

    const partLimit = Math.min(this.limits.maxPartBytes, this.limits.maxTotalBytes - this.unpacked)
    let out: Uint8Array
    if (entry.method === 0) {
      if (data.length > partLimit) throw new XlsxImportError('too_large', `part ${entry.name}`)
      out = data.slice()
    } else if (entry.method === 8) {
      out = await inflateRaw(data, partLimit, entry.name)
    } else {
      throw new XlsxImportError('corrupt', `compression method ${entry.method}`)
    }
    this.unpacked += out.length
    return out
  }

  /** Unpacked bytes read so far. */
  get unpackedBytes(): number {
    return this.unpacked
  }
}

/** Inflates raw deflate data, refusing to produce more than `limit` bytes. */
export async function inflateRaw(data: Uint8Array, limit: number, label = 'part'): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > limit) {
        await reader.cancel().catch(() => undefined)
        throw new XlsxImportError('too_large', `${label} unpacks beyond ${limit} bytes`)
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof XlsxImportError) throw error
    throw new XlsxImportError('corrupt', `${label} does not inflate`)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}
