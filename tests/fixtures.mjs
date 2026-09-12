/**
 * Synthetic OOXML fixtures for the built-in converter tests.
 *
 * Office files are ZIP containers, so a ~70-line ZIP writer with stored (uncom-
 * pressed) entries is all it takes to build a real, readable .docx/.xlsx/.pptx
 * without vendoring a zip library or committing anyone's actual documents. The
 * markup deliberately includes attribute-bearing tags (`<a:p ...>`, `<w:tc ...>`)
 * because a regex that only matches a bare `<tag>` silently returns nothing —
 * that was a real bug, and these fixtures keep it fixed.
 */

import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Build a ZIP archive with stored (or, with `deflate`, deflated) entries.
 * @param {Array<[string, string | Buffer]>} entries - name/content pairs.
 * @param {{ deflate?: boolean }} options - `deflate` compresses every entry (method 8).
 * @returns {Buffer} a readable ZIP archive.
 */
export function makeZip(entries, { deflate = false } = {}) {
  const parts = []
  const central = []
  let offset = 0

  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, 'utf8')
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const payload = deflate ? deflateRawSync(data) : data
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(deflate ? 8 : 0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    parts.push(local, nameBytes, payload)

    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(deflate ? 8 : 0, 10)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(payload.length, 20)
    header.writeUInt32LE(data.length, 24)
    header.writeUInt16LE(nameBytes.length, 28)
    header.writeUInt32LE(offset, 42)
    central.push(header, nameBytes)

    offset += local.length + nameBytes.length + payload.length
  }

  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, centralBytes, end])
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

/** A .docx carrying a heading, inline runs, a table, and a bullet. */
export function makeDocx() {
  const body = `
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly Report</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">Plain </w:t></w:r><w:r><w:t>body &amp; text</w:t></w:r></w:p>
    <w:tbl>
      <w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Revenue</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>APAC</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1200</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>First action item</w:t></w:r></w:p>
  `
  return makeZip([
    ['[Content_Types].xml', '<Types/>'],
    ['word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`],
  ])
}

/** A .xlsx with shared strings, a numeric cell, and a quoted inline string. */
export function makeXlsx() {
  const shared = `<sst>${['Region', 'Revenue', 'APAC', 'EMEA'].map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`
  const sheet = `
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1200</v></c></row>
    <row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3" t="inlineStr"><is><t>900</t></is></c></row>
  `
  return makeZip([
    ['[Content_Types].xml', '<Types/>'],
    ['xl/sharedStrings.xml', shared],
    ['xl/workbook.xml', '<workbook><sheets><sheet name="Regional &amp; Totals" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/worksheets/sheet1.xml', `<worksheet><sheetData>${sheet}</sheetData></worksheet>`],
  ])
}

/** A .pptx whose paragraph tags carry attributes, plus a second slide. */
export function makePptx() {
  const slide = (title, body) => `
    <p:sld><p:cSld><p:spTree>
      <p:sp><p:txBody>
        <a:p><a:pPr lvl="0"/><a:r><a:rPr sz="2400"/><a:t>${title}</a:t></a:r></a:p>
        <a:p><a:r><a:t>${body}</a:t></a:r></a:p>
      </p:txBody></p:sp>
    </p:spTree></p:cSld></p:sld>
  `
  return makeZip([
    ['[Content_Types].xml', '<Types/>'],
    ['ppt/slides/slide1.xml', slide('Slide One Title', 'First slide body')],
    ['ppt/slides/slide2.xml', slide('Slide Two Title', 'Second slide body')],
  ])
}
