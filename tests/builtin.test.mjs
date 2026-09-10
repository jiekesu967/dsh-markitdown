/**
 * Built-in converter tests. These run with no network, no Python, and no
 * MarkItDown install, which is exactly the situation the fallback engine exists
 * for — so they are also the ones that must never need an external tool.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BuiltinUnsupportedError,
  builtinSupports,
  convertBuiltin,
  convertBuiltinResponse,
} from '../lib/builtin.js'
import { htmlToMarkdown, parseDelimited, toMarkdownTable } from '../lib/text.js'
import { unzip } from '../lib/zip.js'
import { makeDocx, makePptx, makeXlsx, makeZip } from './fixtures.mjs'

test('zip reader recovers stored entries and nested names', () => {
  const archive = makeZip([
    ['a.txt', 'alpha'],
    ['nested/dir/b.bin', Buffer.from([0, 1, 2, 255])],
  ])
  const entries = unzip(archive)
  assert.equal(entries.size, 2)
  assert.equal(entries.get('a.txt').toString('utf8'), 'alpha')
  assert.deepEqual([...entries.get('nested/dir/b.bin')], [0, 1, 2, 255])
})

test('zip reader reports a non-archive clearly', () => {
  assert.throws(() => unzip(Buffer.from('not a zip at all')), /not a ZIP container/)
})

test('docx keeps headings, runs, tables, and bullets', () => {
  const markdown = convertBuiltin(makeDocx(), 'report.docx')
  assert.match(markdown, /^# Quarterly Report$/m)
  assert.match(markdown, /Plain body & text/)
  assert.match(markdown, /\| Region \| Revenue \|/)
  assert.match(markdown, /\| APAC \| 1200 \|/)
  assert.match(markdown, /^- First action item$/m)
})

test('xlsx resolves shared strings, numbers, and inline strings', () => {
  const markdown = convertBuiltin(makeXlsx(), 'book.xlsx')
  assert.match(markdown, /^## Regional & Totals$/m)
  assert.match(markdown, /\| Region \| Revenue \|/)
  assert.match(markdown, /\| APAC \| 1200 \|/)
  assert.match(markdown, /\| EMEA \| 900 \|/)
})

test('xlsx falls back to positional sheet names without a workbook part', () => {
  const markdown = convertBuiltin(makeXlsx(), 'book.xlsx')
  assert.ok(markdown.includes('Regional'))
  assert.ok(!markdown.includes('Sheet1'))
})

test('pptx finds text in attribute-bearing paragraph tags', () => {
  const markdown = convertBuiltin(makePptx(), 'deck.pptx')
  assert.match(markdown, /^## Slide 1$/m)
  assert.match(markdown, /Slide One Title/)
  assert.match(markdown, /First slide body/)
  assert.match(markdown, /Second slide body/)
  assert.ok(!markdown.includes('_(no text)_'), 'slide text must not be lost')
})

test('csv becomes a pipe table with quoted fields intact', () => {
  const csv = 'name,note\n"Smith, Jane","said ""hi"""\n'
  const markdown = convertBuiltin(Buffer.from(csv), 'rows.csv')
  assert.match(markdown, /\| name \| note \|/)
  assert.match(markdown, /\| Smith, Jane \| said "hi" \|/)
})

test('delimited parsing handles CRLF and embedded newlines', () => {
  const rows = parseDelimited('a,b\r\n"line1\nline2",c\r\n', ',')
  assert.deepEqual(rows, [['a', 'b'], ['line1\nline2', 'c']])
})

test('json is emitted as a fenced block', () => {
  const markdown = convertBuiltin(Buffer.from('{"a":[1,2]}'), 'data.json')
  assert.match(markdown, /^```json$/m)
  assert.match(markdown, /"a": \[/)
})

test('html keeps structure and decodes entities', () => {
  const html = '<html><head><title>T</title><style>p{}</style></head><body><h2>Head</h2><p>A &amp; B</p><ul><li>one</li></ul><a href="https://x.test">link</a></body></html>'
  const markdown = convertBuiltin(Buffer.from(html), 'page.html')
  assert.match(markdown, /^## Head$/m)
  assert.match(markdown, /A & B/)
  assert.match(markdown, /- one/)
  assert.match(markdown, /\[link\]\(https:\/\/x\.test\)/)
  assert.ok(!markdown.includes('p{}'), 'style content must be dropped')
})

test('html table conversion produces a markdown table', () => {
  const html = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'
  assert.match(htmlToMarkdown(html), /\| A \| B \|\n\| --- \| --- \|\n\| 1 \| 2 \|/)
})

test('plain text passes through and strips a BOM', () => {
  assert.equal(convertBuiltin(Buffer.from('\uFEFFhello\nworld\n'), 'notes.txt'), 'hello\nworld')
})

test('unknown but textual extensions still convert', () => {
  assert.equal(convertBuiltin(Buffer.from('key=value\n'), 'app.conf'), 'key=value')
})

test('pdf is refused with a message naming the real engine', () => {
  assert.throws(
    () => convertBuiltin(Buffer.from('%PDF-1.7'), 'doc.pdf'),
    (error) => error instanceof BuiltinUnsupportedError && /real MarkItDown engine/.test(error.message),
  )
})

test('binary data with an unknown extension is refused, not mojibake', () => {
  assert.throws(() => convertBuiltin(Buffer.from([0, 1, 2, 3]), 'blob.dat'), /binary data/)
})

test('a name with no extension is refused with a clear reason', () => {
  assert.throws(() => convertBuiltin(Buffer.from('x'), 'blob'), /no file extension/)
})

test('builtinSupports reports coverage without pretending', () => {
  assert.equal(builtinSupports('a.docx'), true)
  assert.equal(builtinSupports('a.csv'), true)
  assert.equal(builtinSupports('a.pdf'), false)
  assert.equal(builtinSupports('a.png'), false)
})

test('response conversion honours content-type over the file name', () => {
  assert.match(convertBuiltinResponse(Buffer.from('<h1>Hi</h1>'), 'text/html; charset=utf-8', 'x'), /# Hi/)
})

test('table cells escape pipes so rows stay intact', () => {
  const table = toMarkdownTable([['a|b'], ['c']])
  assert.match(table, /\\\|/)
  assert.equal(table.split('\n').length, 3)
})

test('conversion is stable across repeated calls (no shared state)', () => {
  const first = convertBuiltin(makeDocx(), 'x.docx')
  const second = convertBuiltin(makeDocx(), 'x.docx')
  assert.equal(first, second)
})
