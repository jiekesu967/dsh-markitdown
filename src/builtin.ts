/**
 * The zero-dependency built-in converter.
 *
 * This is the last link in the engine chain: when Microsoft MarkItDown is not
 * installed anywhere the tool can reach, these converters still turn the common
 * office and web formats into Markdown using nothing but Node's standard
 * library. Fidelity is deliberately advertised as "good enough to read", not
 * "byte-faithful": layouts, styling, and (for PDF, images, audio) whole formats
 * are the real engine's job, and the tool says so instead of guessing.
 *
 * OOXML parts are parsed with targeted regular expressions over the extracted
 * XML rather than with a full DOM. That keeps this module dependency-free and
 * is adequate for text extraction, but it is why nested tables inside a table
 * cell come out flattened.
 */
import { orderedParts, readEntry, unzip, ZipError } from './zip.js'
import { decodeEntities, fence, htmlToMarkdown, normalizeMarkdown, parseDelimited, toMarkdownTable } from './text.js'

/** Extensions the built-in engine converts natively. */
const NATIVE = new Set([
  'csv', 'tsv', 'json', 'xml', 'html', 'htm', 'xhtml', 'docx', 'xlsx', 'xlsm', 'pptx', 'epub', 'ipynb',
])

/** Extensions passed through as plain text. */
const PLAIN = new Set([
  'txt', 'text', 'md', 'markdown', 'mdx', 'rst', 'org', 'tex', 'log', 'yaml', 'yml', 'toml', 'ini', 'cfg',
  'conf', 'env', 'properties', 'srt', 'vtt', 'py', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'java', 'c', 'h',
  'cpp', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'scala', 'sh', 'bash', 'zsh', 'ps1', 'sql',
  'css', 'scss', 'less', 'vue', 'svelte', 'r', 'lua', 'pl', 'dart', 'gradle', 'cmake', 'makefile',
])

/** Formats the built-in engine knowingly cannot read; the message names a fix. */
const KNOWN_UNSUPPORTED: Record<string, string> = {
  pdf: 'PDF needs the real MarkItDown engine (layout, fonts, and optional OCR)',
  doc: 'legacy binary .doc needs the real MarkItDown engine',
  xls: 'legacy binary .xls needs the real MarkItDown engine',
  ppt: 'legacy binary .ppt needs the real MarkItDown engine',
  msg: 'Outlook .msg needs the real MarkItDown engine',
  png: 'image OCR needs the real MarkItDown engine',
  jpg: 'image OCR needs the real MarkItDown engine',
  jpeg: 'image OCR needs the real MarkItDown engine',
  gif: 'image OCR needs the real MarkItDown engine',
  webp: 'image OCR needs the real MarkItDown engine',
  tiff: 'image OCR needs the real MarkItDown engine',
  bmp: 'image OCR needs the real MarkItDown engine',
  mp3: 'audio transcription needs the real MarkItDown engine',
  wav: 'audio transcription needs the real MarkItDown engine',
  m4a: 'audio transcription needs the real MarkItDown engine',
  mp4: 'video transcription needs the real MarkItDown engine',
  zip: 'archives need the real MarkItDown engine',
}

/** Thrown when the built-in engine is asked for a format it cannot read. */
export class BuiltinUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BuiltinUnsupportedError'
  }
}

/**
 * Whether the built-in engine claims a file name at all.
 * @param name - file name or path.
 * @returns true when a native or plain-text converter exists.
 */
export function builtinSupports(name: string): boolean {
  const extension = extensionOf(name)
  return NATIVE.has(extension) || PLAIN.has(extension)
}

/**
 * Convert raw bytes with the built-in engine.
 * @param bytes - whole file content.
 * @param name - file name used to pick the converter (a URL path is fine).
 * @returns Markdown text.
 */
export function convertBuiltin(bytes: Buffer, name: string): string {
  const extension = extensionOf(name)

  if (PLAIN.has(extension) && !NATIVE.has(extension)) {
    assertTextual(bytes, extension)
    return normalizeMarkdown(stripBom(bytes.toString('utf8')))
  }

  switch (extension) {
    case 'csv':
      return normalizeMarkdown(toMarkdownTable(parseDelimited(bytes.toString('utf8'), ',')))
    case 'tsv':
      return normalizeMarkdown(toMarkdownTable(parseDelimited(bytes.toString('utf8'), '\t')))
    case 'json':
      return normalizeMarkdown(fence(prettyJson(bytes.toString('utf8')), 'json'))
    case 'xml':
      return normalizeMarkdown(stripMarkup(bytes.toString('utf8')))
    case 'html':
    case 'htm':
    case 'xhtml':
      return htmlToMarkdown(bytes.toString('utf8'))
    case 'ipynb':
      return notebookToMarkdown(bytes.toString('utf8'))
    case 'docx':
      return withZip(bytes, (entries) => docxToMarkdown(requireEntry(entries, 'word/document.xml')))
    case 'xlsx':
    case 'xlsm':
      return withZip(bytes, (entries) => xlsxToMarkdown(entries))
    case 'pptx':
      return withZip(bytes, (entries) => pptxToMarkdown(entries))
    case 'epub':
      return withZip(bytes, (entries) => epubToMarkdown(entries))
    default: {
      const known = KNOWN_UNSUPPORTED[extension]
      if (known !== undefined) {
        throw new BuiltinUnsupportedError(`.${extension}: ${known}`)
      }
      if (extension === '') {
        throw new BuiltinUnsupportedError('no file extension, so the built-in engine cannot pick a converter')
      }
      assertTextual(bytes, extension)
      return normalizeMarkdown(stripBom(bytes.toString('utf8')))
    }
  }
}

/**
 * Convert a Markdown document served over HTTP by reading it as text.
 * @param body - response text.
 * @param contentType - response `content-type`, when known.
 * @param name - a name to derive the converter from.
 * @returns Markdown text.
 */
export function convertBuiltinResponse(body: Buffer, contentType: string, name: string): string {
  const type = contentType.toLowerCase()
  if (type.includes('html')) return htmlToMarkdown(body.toString('utf8'))
  if (type.includes('json')) return normalizeMarkdown(fence(prettyJson(body.toString('utf8')), 'json'))
  if (type.includes('csv')) return normalizeMarkdown(toMarkdownTable(parseDelimited(body.toString('utf8'), ',')))
  return convertBuiltin(body, name)
}

function withZip(bytes: Buffer, convert: (entries: Map<string, Buffer>) => string): string {
  try {
    return normalizeMarkdown(convert(unzip(bytes)))
  } catch (error) {
    if (error instanceof ZipError) {
      throw new BuiltinUnsupportedError(`the file is not a readable Office/EPUB container (${error.message})`)
    }
    throw error
  }
}

function requireEntry(entries: Map<string, Buffer>, name: string): string {
  const text = readEntry(entries, name)
  if (text === undefined) throw new BuiltinUnsupportedError(`container is missing ${name}`)
  return text
}

function extensionOf(name: string): string {
  const clean = name.split(/[?#]/)[0] ?? name
  const base = clean.replace(/\\/g, '/').split('/').pop() ?? clean
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

function assertTextual(bytes: Buffer, extension: string): void {
  const probe = bytes.subarray(0, 8192)
  if (probe.includes(0)) {
    throw new BuiltinUnsupportedError(`.${extension || 'bin'} looks like binary data`)
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

function stripMarkup(xml: string): string {
  return decodeEntities(
    xml
      .replace(/<\?[\s\S]*?\?>/g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, '\n'),
  )
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n')
}

// ─── WordprocessingML ────────────────────────────────────────────────────────

/** Extract text, headings, and tables from `word/document.xml`. */
function docxToMarkdown(documentXml: string): string {
  const tables: string[] = []
  const masked = documentXml.replace(/<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/g, (table) => {
    tables.push(docxTableToMarkdown(table))
    return `\u0000T${tables.length - 1}\u0000`
  })

  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(masked)?.[1] ?? masked
  const blocks: string[] = []
  for (const chunk of body.split(/<\/w:p>/)) {
    for (const piece of chunk.split(/\u0000T(\d+)\u0000/)) {
      if (/^\d+$/.test(piece)) {
        const table = tables[Number.parseInt(piece, 10)]
        if (table !== undefined && table !== '') blocks.push(table)
        continue
      }
      const paragraph = docxParagraphToMarkdown(piece)
      if (paragraph !== '') blocks.push(paragraph)
    }
  }
  return blocks.join('\n\n')
}

function docxParagraphToMarkdown(chunk: string): string {
  const text = docxRunsToText(chunk)
  if (text.trim() === '') return ''
  const style = /<w:pStyle\b[^>]*w:val="([^"]*)"/.exec(chunk)?.[1] ?? ''
  const heading = /^heading\s*([1-9])$/i.exec(style)?.[1]
  if (heading !== undefined) return `${'#'.repeat(Number.parseInt(heading, 10))} ${text.trim()}`
  if (/^(title)$/i.test(style)) return `# ${text.trim()}`
  if (/^(subtitle)$/i.test(style)) return `## ${text.trim()}`
  if (/<w:numPr\b/.test(chunk)) return `- ${text.trim()}`
  if (/<w:jc\b[^>]*w:val="center"/.test(chunk)) return text.trim()
  return text.trim()
}

function docxRunsToText(chunk: string): string {
  let text = ''
  const token = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g
  let match: RegExpExecArray | null
  while ((match = token.exec(chunk)) !== null) {
    if (match[1] !== undefined) text += decodeEntities(match[1])
    else if (match[0].startsWith('<w:tab')) text += '\t'
    else text += '\n'
  }
  return decodeEntities(text)
}

function docxTableToMarkdown(table: string): string {
  const rows: string[][] = []
  const rowPattern = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g
  let rowMatch: RegExpExecArray | null
  while ((rowMatch = rowPattern.exec(table)) !== null) {
    const cells: string[] = []
    const cellPattern = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g
    let cellMatch: RegExpExecArray | null
    while ((cellMatch = cellPattern.exec(rowMatch[1] as string)) !== null) {
      cells.push(docxRunsToText(cellMatch[1] as string).trim())
    }
    if (cells.length > 0) rows.push(cells)
  }
  return toMarkdownTable(rows)
}

// ─── SpreadsheetML ───────────────────────────────────────────────────────────

/** Extract every worksheet in workbook order as a Markdown section. */
function xlsxToMarkdown(entries: Map<string, Buffer>): string {
  const shared = sharedStrings(readEntry(entries, 'xl/sharedStrings.xml'))
  const sheets = orderedParts(entries, /^xl\/worksheets\/sheet\d+\.xml$/)
  if (sheets.length === 0) throw new BuiltinUnsupportedError('workbook contains no worksheets')
  const names = sheetNames(entries)

  const sections: string[] = []
  sheets.forEach((part, index) => {
    const xml = readEntry(entries, part)
    if (xml === undefined) return
    const markdown = sheetToMarkdown(xml, shared)
    const title = names[index] ?? `Sheet${index + 1}`
    sections.push(`## ${title}${markdown === '' ? '\n\n_(empty sheet)_' : `\n\n${markdown}`}`)
  })
  return sections.join('\n\n')
}

function sharedStrings(xml: string | undefined): string[] {
  if (xml === undefined) return []
  const values: string[] = []
  const itemPattern = /<si\b[^>]*>([\s\S]*?)<\/si>/g
  let itemMatch: RegExpExecArray | null
  while ((itemMatch = itemPattern.exec(xml)) !== null) {
    let text = ''
    const runPattern = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g
    let runMatch: RegExpExecArray | null
    while ((runMatch = runPattern.exec(itemMatch[1] as string)) !== null) {
      text += decodeEntities(runMatch[1] as string)
    }
    values.push(text)
  }
  return values
}

function sheetNames(entries: Map<string, Buffer>): string[] {
  const workbook = readEntry(entries, 'xl/workbook.xml')
  if (workbook === undefined) return []
  const names: string[] = []
  const pattern = /<sheet\b[^>]*name="([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(workbook)) !== null) names.push(decodeEntities(match[1] as string))
  return names
}

function sheetToMarkdown(xml: string, shared: readonly string[]): string {
  const grid: string[][] = []
  const rowPattern = /<row\b[^>]*>([\s\S]*?)<\/row>/g
  let rowMatch: RegExpExecArray | null
  while ((rowMatch = rowPattern.exec(xml)) !== null) {
    const cells: string[] = []
    const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    let cellMatch: RegExpExecArray | null
    while ((cellMatch = cellPattern.exec(rowMatch[1] as string)) !== null) {
      const attributes = cellMatch[1] ?? ''
      const inner = cellMatch[2] ?? ''
      const column = columnIndex(/r="([A-Z]+)\d+"/.exec(attributes)?.[1] ?? '')
      const type = /t="([^"]*)"/.exec(attributes)?.[1] ?? ''
      if (column >= 0) cells[column] = cellValue(type, inner, shared)
    }
    grid.push(cells)
  }
  const rows = grid.map((row) => Array.from(row, (cell) => cell ?? ''))
  while (rows.length > 0 && (rows[rows.length - 1] as string[]).every((cell) => cell.trim() === '')) rows.pop()
  return toMarkdownTable(rows)
}

function cellValue(type: string, inner: string, shared: readonly string[]): string {
  const value = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? ''
  if (type === 's') {
    const index = Number.parseInt(value, 10)
    return Number.isFinite(index) ? shared[index] ?? '' : ''
  }
  if (type === 'inlineStr') {
    let text = ''
    const pattern = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(inner)) !== null) text += decodeEntities(match[1] as string)
    return text
  }
  return decodeEntities(value)
}

/** `A`→0, `B`→1, `AA`→26. Returns -1 for an unparsable reference. */
function columnIndex(letters: string): number {
  if (letters === '') return -1
  let index = 0
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64)
  return index - 1
}

// ─── PresentationML ──────────────────────────────────────────────────────────

/** Extract one section per slide, in slide order. */
function pptxToMarkdown(entries: Map<string, Buffer>): string {
  const slides = orderedParts(entries, /^ppt\/slides\/slide\d+\.xml$/)
  if (slides.length === 0) throw new BuiltinUnsupportedError('presentation contains no slides')
  const sections: string[] = []
  slides.forEach((part, index) => {
    const xml = readEntry(entries, part)
    if (xml === undefined) return
    const paragraphs: string[] = []
    const paragraphPattern = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g
    let paragraphMatch: RegExpExecArray | null
    while ((paragraphMatch = paragraphPattern.exec(xml)) !== null) {
      let text = ''
      const runPattern = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g
      let runMatch: RegExpExecArray | null
      while ((runMatch = runPattern.exec(paragraphMatch[1] as string)) !== null) {
        text += decodeEntities(runMatch[1] as string)
      }
      if (text.trim() !== '') paragraphs.push(text.trim())
    }
    sections.push(`## Slide ${index + 1}\n\n${paragraphs.length === 0 ? '_(no text)_' : paragraphs.join('\n\n')}`)
  })
  return sections.join('\n\n')
}

// ─── EPUB ────────────────────────────────────────────────────────────────────

/** Read the spine documents in order and convert each chapter. */
function epubToMarkdown(entries: Map<string, Buffer>): string {
  const container = readEntry(entries, 'META-INF/container.xml')
  const rootfile = container === undefined ? undefined : /full-path="([^"]+)"/.exec(container)?.[1]
  const opf = rootfile === undefined ? undefined : readEntry(entries, rootfile)
  const chapters: string[] = []

  const manifest = new Map<string, string>()
  if (opf !== undefined) {
    const itemPattern = /<item\b[^>]*>/g
    let itemMatch: RegExpExecArray | null
    while ((itemMatch = itemPattern.exec(opf)) !== null) {
      const tag = itemMatch[0]
      const id = /id="([^"]*)"/.exec(tag)?.[1]
      const href = /href="([^"]*)"/.exec(tag)?.[1]
      if (id !== undefined && href !== undefined) manifest.set(id, href)
    }
  }

  const base = rootfile === undefined ? '' : (rootfile.split('/').slice(0, -1).join('/') + '/')
  const order: string[] = []
  if (opf !== undefined) {
    const spinePattern = /<itemref\b[^>]*idref="([^"]*)"/g
    let spineMatch: RegExpExecArray | null
    while ((spineMatch = spinePattern.exec(opf)) !== null) {
      const href = manifest.get(spineMatch[1] as string)
      if (href !== undefined) order.push(decodeURIComponent(base + href).replace(/^\.\//, ''))
    }
  }

  const parts = order.length > 0 ? order : orderedParts(entries, /\.x?html?$/i)
  for (const part of parts) {
    const html = readEntry(entries, part)
    if (html === undefined) continue
    const markdown = htmlToMarkdown(html)
    if (markdown !== '') chapters.push(markdown)
  }
  if (chapters.length === 0) throw new BuiltinUnsupportedError('EPUB contains no readable chapters')
  return chapters.join('\n\n')
}

// ─── Jupyter notebooks ───────────────────────────────────────────────────────

/** Render notebook cells in order. */
function notebookToMarkdown(text: string): string {
  let notebook: unknown
  try {
    notebook = JSON.parse(text)
  } catch {
    throw new BuiltinUnsupportedError('notebook is not valid JSON')
  }
  const cells = (notebook as { cells?: unknown[] }).cells
  if (!Array.isArray(cells)) throw new BuiltinUnsupportedError('notebook has no cells array')

  const blocks: string[] = []
  for (const cell of cells) {
    const record = cell as { cell_type?: string; source?: unknown; outputs?: unknown[] }
    const source = Array.isArray(record.source) ? record.source.join('') : String(record.source ?? '')
    if (source.trim() === '') continue
    if (record.cell_type === 'code') {
      blocks.push(fence(source.replace(/\s+$/u, ''), 'python'))
    } else {
      blocks.push(source.trim())
    }
  }
  return blocks.join('\n\n')
}
