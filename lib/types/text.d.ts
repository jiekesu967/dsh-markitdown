/**
 * Text-shaping helpers for the built-in fallback engine: entity decoding, a
 * tolerant HTML→Markdown reducer, delimiter-separated-value parsing, and the
 * final whitespace normalization every converter funnels through.
 *
 * These are regex-driven on purpose. The built-in engine is the zero-dependency
 * safety net behind the real MarkItDown engines, so it favours breadth of
 * formats and predictable output over exhaustive grammar coverage.
 */
/**
 * Decode the XML/HTML entity forms that actually appear in OOXML text runs and
 * web pages: the five predefined XML entities, named HTML entities, and
 * decimal/hexadecimal character references.
 * @param input - raw markup or text.
 * @returns text with entities resolved.
 */
export declare function decodeEntities(input: string): string;
/** Escape a table cell so a pipe or newline cannot break the row. */
export declare function escapeCell(value: string): string;
/**
 * Render a delimiter-separated table as a Markdown pipe table.
 * @param rows - already-split rows of cell text.
 * @returns the Markdown table, or an empty string when there are no rows.
 */
export declare function toMarkdownTable(rows: readonly (readonly string[])[]): string;
/**
 * Parse delimiter-separated text (RFC 4180 style quoting, embedded newlines,
 * doubled quotes) into rows.
 * @param input - the full file text.
 * @param delimiter - field separator, `,` or `\t`.
 * @returns one array of cell strings per record.
 */
export declare function parseDelimited(input: string, delimiter: string): string[][];
/**
 * Convert an HTML document or fragment into Markdown-ish text: headings, lists,
 * fenced code, images, links, block quotes, and simple tables survive; every
 * other element is reduced to its text.
 * @param html - the raw markup.
 * @returns converted Markdown.
 */
export declare function htmlToMarkdown(html: string): string;
/** Fence a payload, widening the fence when the payload itself contains backticks. */
export declare function fence(content: string, language?: string): string;
/**
 * Collapse the whitespace noise every converter produces: three or more blank
 * lines become one, trailing spaces go, and the result is trimmed.
 * @param input - Markdown text.
 * @returns normalized Markdown.
 */
export declare function normalizeMarkdown(input: string): string;
