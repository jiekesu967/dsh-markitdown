/**
 * Text-shaping helpers for the built-in fallback engine: entity decoding, a
 * tolerant HTML→Markdown reducer, delimiter-separated-value parsing, and the
 * final whitespace normalization every converter funnels through.
 *
 * These are regex-driven on purpose. The built-in engine is the zero-dependency
 * safety net behind the real MarkItDown engines, so it favours breadth of
 * formats and predictable output over exhaustive grammar coverage.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  laquo: '«',
  raquo: '»',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  deg: '°',
  times: '×',
  divide: '÷',
  eacute: 'é',
  egrave: 'è',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  szlig: 'ß',
}

/**
 * Decode the XML/HTML entity forms that actually appear in OOXML text runs and
 * web pages: the five predefined XML entities, named HTML entities, and
 * decimal/hexadecimal character references.
 * @param input - raw markup or text.
 * @returns text with entities resolved.
 */
export function decodeEntities(input: string): string {
  return input.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** Escape a table cell so a pipe or newline cannot break the row. */
export function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

/**
 * Render a delimiter-separated table as a Markdown pipe table.
 * @param rows - already-split rows of cell text.
 * @returns the Markdown table, or an empty string when there are no rows.
 */
export function toMarkdownTable(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return ''
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
  if (width === 0) return ''
  const cell = (row: readonly string[], index: number): string => escapeCell(row[index] ?? '')
  const header = rows[0] as readonly string[]
  const lines = [
    `| ${Array.from({ length: width }, (_, i) => cell(header, i)).join(' | ')} |`,
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
  ]
  for (const row of rows.slice(1)) {
    lines.push(`| ${Array.from({ length: width }, (_, i) => cell(row, i)).join(' | ')} |`)
  }
  return lines.join('\n')
}

/**
 * Parse delimiter-separated text (RFC 4180 style quoting, embedded newlines,
 * doubled quotes) into rows.
 * @param input - the full file text.
 * @param delimiter - field separator, `,` or `\t`.
 * @returns one array of cell strings per record.
 */
export function parseDelimited(input: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let index = 0
  const text = input.replace(/^\uFEFF/, '')

  while (index < text.length) {
    const char = text[index] as string
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        quoted = false
        index += 1
        continue
      }
      field += char
      index += 1
      continue
    }
    if (char === '"' && field === '') {
      quoted = true
      index += 1
      continue
    }
    if (char === delimiter) {
      row.push(field)
      field = ''
      index += 1
      continue
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      index += 1
      continue
    }
    field += char
    index += 1
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((entry) => entry.length > 1 || (entry[0] ?? '').trim() !== '')
}

/**
 * Convert an HTML document or fragment into Markdown-ish text: headings, lists,
 * fenced code, images, links, block quotes, and simple tables survive; every
 * other element is reduced to its text.
 * @param html - the raw markup.
 * @returns converted Markdown.
 */
export function htmlToMarkdown(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n\n---\n\n')

  text = replaceTables(text)

  for (let level = 1; level <= 6; level++) {
    const pattern = new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)</h${level}>`, 'gi')
    text = text.replace(pattern, (_whole, inner: string) => `\n\n${'#'.repeat(level)} ${inline(inner)}\n\n`)
  }

  text = text
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_whole, inner: string) => `\n\n\`\`\`\n${stripTags(inner).replace(/^\n+|\n+$/g, '')}\n\`\`\`\n\n`)
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_whole, inner: string) =>
      `\n\n${stripTags(inner)
        .split('\n')
        .map((line) => `> ${line.trim()}`)
        .join('\n')}\n\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_whole, inner: string) => `\n- ${inline(inner)}`)
    .replace(/<\/(ul|ol|dl)>/gi, '\n\n')
    .replace(/<(p|div|section|article|header|footer|tr|figure|figcaption)\b[^>]*>/gi, '\n\n')
    .replace(/<\/(p|div|section|article|header|footer|tr|figure|figcaption)>/gi, '\n\n')

  text = stripTags(inlineMarkup(text))
  return normalizeMarkdown(decodeEntities(text))
}

/**
 * Rewrite the inline constructs that carry meaning — links, images, emphasis,
 * inline code — into Markdown. This is a tag-level pass with no whitespace
 * collapsing, so it is safe to run over a whole document after the block-level
 * passes have established paragraph structure.
 * @param input - markup containing inline elements.
 * @returns the same text with inline elements expressed as Markdown.
 */
function inlineMarkup(input: string): string {
  return input
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_whole, href: string, label: string) => {
      const text = stripTags(label).trim()
      return text === '' ? '' : `[${text}](${href.trim()})`
    })
    .replace(/<img\b[^>]*alt\s*=\s*["']([^"']*)["'][^>]*>/gi, '![$1]()')
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
}

/** Reduce an element's inner markup to inline Markdown (links, images, emphasis). */
function inline(inner: string): string {
  return decodeEntities(stripTags(inlineMarkup(inner)))
    .replace(/\s+/g, ' ')
    .trim()
}

function stripTags(input: string): string {
  return input.replace(/<[^>]+>/g, '')
}

/** Convert simple HTML tables; nested markup inside cells is flattened. */
function replaceTables(html: string): string {
  return html.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_whole, body: string) => {
    const rows: string[][] = []
    const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
    let rowMatch: RegExpExecArray | null
    while ((rowMatch = rowPattern.exec(body)) !== null) {
      const cells: string[] = []
      const cellPattern = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi
      let cellMatch: RegExpExecArray | null
      while ((cellMatch = cellPattern.exec(rowMatch[1] as string)) !== null) {
        cells.push(inline(cellMatch[2] as string))
      }
      if (cells.length > 0) rows.push(cells)
    }
    return rows.length === 0 ? '' : `\n\n${toMarkdownTable(rows)}\n\n`
  })
}

/** Fence a payload, widening the fence when the payload itself contains backticks. */
export function fence(content: string, language = ''): string {
  const longest = longestBacktickRun(content)
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  return `${ticks}${language}\n${content.replace(/\s+$/u, '')}\n${ticks}`
}

function longestBacktickRun(content: string): number {
  let longest = 0
  for (const run of content.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return longest
}

/**
 * Collapse the whitespace noise every converter produces: three or more blank
 * lines become one, trailing spaces go, and the result is trimmed.
 * @param input - Markdown text.
 * @returns normalized Markdown.
 */
export function normalizeMarkdown(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
