/** Raised when the input is not a readable ZIP container. */
export declare class ZipError extends Error {
    constructor(message: string);
}
/**
 * Read every non-directory entry of a ZIP container into memory.
 * @param buffer - the raw archive bytes.
 * @param maxEntryBytes - cap on one entry's decompressed size; a larger entry raises instead of buffering it.
 * @returns entry name (POSIX separators) to decompressed content.
 */
export declare function unzip(buffer: Buffer, maxEntryBytes?: number): Map<string, Buffer>;
/**
 * Read one entry as UTF-8 text.
 * @param entries - the archive read by {@link unzip}.
 * @param name - exact entry name.
 * @returns the decoded text, or `undefined` when the entry is absent.
 */
export declare function readEntry(entries: Map<string, Buffer>, name: string): string | undefined;
/**
 * List entry names matching a regular expression, in ascending numeric order of
 * the first digit run inside the name (part1, part2, … part10 rather than
 * part1, part10, part2). OOXML parts are conventionally numbered this way.
 * @param entries - the archive read by {@link unzip}.
 * @param pattern - filter applied to each entry name.
 * @returns matching entry names.
 */
export declare function orderedParts(entries: Map<string, Buffer>, pattern: RegExp): string[];
