/**
 * Minimal ZIP reader for the built-in fallback engine.
 *
 * Only what OOXML/EPUB containers need: the end-of-central-directory record, the
 * central directory, and per-entry local headers. Store (0) and deflate (8) are
 * supported; ZIP64 is rejected with an explicit message rather than silently
 * returning corrupt text. Deflated entries are capped in decompressed size, so
 * a small archive cannot balloon into unbounded memory.
 */
import { inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

/** Raised when the input is not a readable ZIP container. */
export class ZipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipError'
  }
}

/** Default cap on one decompressed entry: generous for real documents, small enough to bound a bomb. */
const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024 * 1024

/**
 * Read every non-directory entry of a ZIP container into memory.
 * @param buffer - the raw archive bytes.
 * @param maxEntryBytes - cap on one entry's decompressed size; a larger entry raises instead of buffering it.
 * @returns entry name (POSIX separators) to decompressed content.
 */
export function unzip(buffer: Buffer, maxEntryBytes: number = DEFAULT_MAX_ENTRY_BYTES): Map<string, Buffer> {
  const end = findEndOfCentralDirectory(buffer)
  const count = buffer.readUInt16LE(end + 10)
  const centralSize = buffer.readUInt32LE(end + 12)
  const centralOffset = buffer.readUInt32LE(end + 16)
  if (centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw new ZipError('ZIP64 archives are not supported by the built-in engine')
  }

  const entries = new Map<string, Buffer>()
  let cursor = centralOffset
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIG) break
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength

    if (name.endsWith('/')) continue
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError(`ZIP64 entry is not supported by the built-in engine: ${name}`)
    }
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIG) continue

    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(start, Math.min(start + compressedSize, buffer.length))
    if (method === 0) {
      entries.set(name, Buffer.from(raw))
      continue
    }
    try {
      entries.set(name, inflateRawSync(raw, { maxOutputLength: maxEntryBytes }))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
        throw new ZipError(`entry ${name} decompresses beyond the ${maxEntryBytes}-byte limit`)
      }
      throw error
    }
  }
  return entries
}

/**
 * Read one entry as UTF-8 text.
 * @param entries - the archive read by {@link unzip}.
 * @param name - exact entry name.
 * @returns the decoded text, or `undefined` when the entry is absent.
 */
export function readEntry(entries: Map<string, Buffer>, name: string): string | undefined {
  const raw = entries.get(name)
  return raw === undefined ? undefined : raw.toString('utf8')
}

/**
 * List entry names matching a regular expression, in ascending numeric order of
 * the first digit run inside the name (part1, part2, … part10 rather than
 * part1, part10, part2). OOXML parts are conventionally numbered this way.
 * @param entries - the archive read by {@link unzip}.
 * @param pattern - filter applied to each entry name.
 * @returns matching entry names.
 */
export function orderedParts(entries: Map<string, Buffer>, pattern: RegExp): string[] {
  return [...entries.keys()]
    .filter((name) => pattern.test(name))
    .sort((a, b) => partNumber(a) - partNumber(b))
}

function partNumber(name: string): number {
  const match = /(\d+)(?!.*\d)/.exec(name)
  return match === null ? 0 : Number.parseInt(match[1] as string, 10)
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const floor = Math.max(0, buffer.length - 65_557)
  for (let offset = buffer.length - 22; offset >= floor; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIG) return offset
  }
  throw new ZipError('not a ZIP container (no end-of-central-directory record)')
}
