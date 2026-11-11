// The container and the XML reader: what they accept, and every refusal
// (DTDs and entities, zip bombs, wrong file types, limits).

import { describe, expect, it } from 'vitest'
import { DEFAULT_XLSX_LIMITS, readXlsx, XlsxImportError } from '../src'
import { parseXmlTree, decodeEntities } from '../src/xml'
import { inflateRaw, ZipArchive } from '../src/zip'
import { buildGoogleStyleFixture } from './fixtures/excel-fixture'
import { buildZip, deflateRaw } from './helpers/zip-writer'

const enc = new TextEncoder()

async function code(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    if (typeof p === 'function') p()
    else await p
  } catch (error) {
    if (error instanceof XlsxImportError) return error.code
    throw error
  }
  return 'ok'
}

describe('XML reader', () => {
  it('reads elements, attributes, text, CDATA and the five predefined entities', () => {
    const tree = parseXmlTree('<?xml version="1.0"?><!-- c --><a x="1 &amp; 2"><b>&lt;&#1576;&#x062A;&gt;</b><c><![CDATA[<raw>]]></c><d:e xmlns:d="u" d:k="v"/></a>')
    expect(tree.name).toBe('a')
    expect(tree.attrs.x).toBe('1 & 2')
    expect(tree.children[0]?.text).toBe('<بت>')
    expect(tree.children[1]?.text).toBe('<raw>')
    expect(tree.children[2]?.name).toBe('e')
    expect(tree.children[2]?.attrs['d:k']).toBe('v')
    expect(tree.children[2]?.attrs.k).toBe('v')
  })

  it('refuses any DTD, so no entity is ever expanded (billion laughs, external entities)', async () => {
    const laughs = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><lolz>&lol2;</lolz>'
    expect(await code(() => parseXmlTree(laughs))).toBe('corrupt')
    const xxe = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>'
    expect(await code(() => parseXmlTree(xxe))).toBe('corrupt')
    expect(await code(() => decodeEntities('&nbsp;'))).toBe('corrupt')
    expect(await code(() => decodeEntities('&#0;'))).toBe('corrupt')
  })

  it('refuses malformed documents', async () => {
    for (const bad of ['<a><b></a>', '<a>', '<a x=1/>', 'text', '<a/><b/>', '<a x="1></a>']) {
      expect(await code(() => parseXmlTree(bad)), bad).toBe('corrupt')
    }
  })

  it('refuses a DTD inside a workbook part', async () => {
    const zip = await buildZip([
      { name: '_rels/.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', data: '<!DOCTYPE w [<!ENTITY a "aaaaaaaa">]><workbook>&a;</workbook>' },
    ])
    expect(await code(readXlsx(zip))).toBe('corrupt')
  })
})

describe('zip container', () => {
  it('recognises what is not an .xlsx: HTML, CSV, PDF, empty', async () => {
    expect(await code(readXlsx(enc.encode('<!DOCTYPE html><html><body>Sign in</body></html>')))).toBe('not_xlsx')
    expect(await code(readXlsx(enc.encode('a,b,c\n1,2,3\n')))).toBe('not_xlsx')
    expect(await code(readXlsx(enc.encode('%PDF-1.7')))).toBe('not_xlsx')
    expect(await code(readXlsx(new Uint8Array()))).toBe('not_xlsx')
  })

  it('names legacy .xls and password-protected workbooks (OLE compound files)', async () => {
    const ole = new Uint8Array(512)
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    expect(await code(readXlsx(ole))).toBe('legacy_or_encrypted')
  })

  it('refuses a zip that is not a spreadsheet (a .docx)', async () => {
    const docx = await buildZip([
      { name: '_rels/.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
      { name: 'word/document.xml', data: '<w:document xmlns:w="w"/>' },
    ])
    expect(await code(readXlsx(docx))).toBe('not_xlsx')
  })

  it('stops a zip bomb while inflating, whatever the headers claim', async () => {
    // 64 MiB of zeros deflates to ~64 KiB; the header lies and says 10 bytes.
    const zeros = new Uint8Array(64 * 1024 * 1024)
    const bomb = await buildZip([{ name: 'xl/worksheets/sheet1.xml', data: zeros, lieAboutSize: 10 }])
    expect(bomb.length).toBeLessThan(200 * 1024)
    const zip = ZipArchive.open(bomb, { ...DEFAULT_XLSX_LIMITS, maxPartBytes: 8 * 1024 * 1024 })
    expect(await code(zip.read('xl/worksheets/sheet1.xml'))).toBe('too_large')
  })

  it('refuses a header that declares more than a part may unpack to', async () => {
    const zip = await buildZip([{ name: 'a.xml', data: '<a/>', lieAboutSize: DEFAULT_XLSX_LIMITS.maxPartBytes + 1 }])
    expect(await code(() => ZipArchive.open(zip, DEFAULT_XLSX_LIMITS))).toBe('too_large')
  })

  it('counts every part read against the total limit', async () => {
    const big = new Uint8Array(3000).fill(65)
    const zip = ZipArchive.open(await buildZip([{ name: 'a.xml', data: big }, { name: 'b.xml', data: big }]), { ...DEFAULT_XLSX_LIMITS, maxTotalBytes: 5000 })
    await zip.read('a.xml')
    expect(await code(zip.read('b.xml'))).toBe('too_large')
  })

  it('limits the number of entries and the file size', async () => {
    const many = await buildZip(Array.from({ length: 30 }, (_, i) => ({ name: `p${i}.xml`, data: '<a/>' })))
    expect(await code(() => ZipArchive.open(many, { ...DEFAULT_XLSX_LIMITS, maxEntries: 20 }))).toBe('too_large')
    expect(await code(() => ZipArchive.open(many, { ...DEFAULT_XLSX_LIMITS, maxFileBytes: 100 }))).toBe('too_large')
  })

  it('refuses encrypted entries and corrupt deflate data', async () => {
    const zip = await buildZip([{ name: 'a.xml', data: '<a/>' }])
    const flagged = zip.slice()
    // Central directory general-purpose flag: set bit 0 (encrypted).
    const cd = flagged.length - 22 - (46 + 5)
    flagged[cd + 8] = (flagged[cd + 8] as number) | 1
    expect(await code(() => ZipArchive.open(flagged, DEFAULT_XLSX_LIMITS))).toBe('legacy_or_encrypted')
    expect(await code(inflateRaw(new Uint8Array([0xff, 0xff, 0xff, 0xff]), 1000))).toBe('corrupt')
  })

  it('reads stored and deflated parts alike', async () => {
    const zip = ZipArchive.open(await buildZip([{ name: 'a.xml', data: '<a>1</a>', deflate: false }, { name: 'B.xml', data: '<b>2</b>' }]), DEFAULT_XLSX_LIMITS)
    expect(new TextDecoder().decode((await zip.read('a.xml')) as Uint8Array)).toBe('<a>1</a>')
    // Part names are case-insensitive (OPC).
    expect(new TextDecoder().decode((await zip.read('b.xml')) as Uint8Array)).toBe('<b>2</b>')
    expect(await deflateRaw(new Uint8Array())).toBeInstanceOf(Uint8Array)
  })

  it('refuses more cells than the limit, before converting anything', async () => {
    const file = await buildGoogleStyleFixture()
    expect(await code(readXlsx(file, { limits: { maxCells: 5 } }))).toBe('too_large')
    expect(await code(readXlsx(file))).toBe('ok')
  })
})
