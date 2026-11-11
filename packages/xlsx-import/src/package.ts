// The package layer: relationships (OPC §9.3), part names and text decoding.

import { XlsxImportError } from './errors'
import { children, parseXmlTree, type XmlNode } from './xml'
import type { ZipArchive } from './zip'

export const REL = {
  officeDocument: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  strictOfficeDocument: 'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument',
  worksheet: '/worksheet',
  chartsheet: '/chartsheet',
  dialogsheet: '/dialogsheet',
  macrosheet: '/xlMacrosheet',
  styles: '/styles',
  sharedStrings: '/sharedStrings',
  theme: '/theme',
  hyperlink: '/hyperlink',
  comments: '/comments',
  threadedComment: '/threadedComment',
  drawing: '/drawing',
  table: '/table',
  pivotTable: '/pivotTable',
  chart: '/chart',
  image: '/image',
  externalLink: '/externalLink',
  vmlDrawing: '/vmlDrawing',
} as const

export interface Relationship {
  id: string
  type: string
  /** Resolved absolute part name without the leading slash, or the URL for external targets. */
  target: string
  external: boolean
}

/** `a` ends with the relationship type suffix `suffix` (types differ between transitional and strict). */
export function relIs(rel: Relationship, suffix: string): boolean {
  return rel.type.endsWith(suffix)
}

/** Resolves a relative target against the source part's folder. */
export function resolvePartName(sourcePart: string, target: string): string {
  if (target.startsWith('/')) return normalise(target.slice(1))
  const folder = sourcePart.includes('/') ? sourcePart.slice(0, sourcePart.lastIndexOf('/') + 1) : ''
  return normalise(folder + target)
}

function normalise(path: string): string {
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

export function relsPartOf(part: string): string {
  const slash = part.lastIndexOf('/')
  const folder = slash === -1 ? '' : part.slice(0, slash + 1)
  const file = slash === -1 ? part : part.slice(slash + 1)
  return `${folder}_rels/${file}.rels`
}

/** Decodes a part's bytes: UTF-8 (with or without BOM) or UTF-16 with a BOM. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  return new TextDecoder('utf-8').decode(bytes)
}

export class XlsxPackage {
  readonly zip: ZipArchive
  private readonly relCache = new Map<string, Relationship[]>()

  constructor(zip: ZipArchive) {
    this.zip = zip
  }

  has(part: string): boolean {
    return this.zip.has(part)
  }

  async text(part: string): Promise<string | null> {
    const bytes = await this.zip.read(part)
    return bytes ? decodeText(bytes) : null
  }

  async tree(part: string): Promise<XmlNode | null> {
    const text = await this.text(part)
    return text === null ? null : parseXmlTree(text)
  }

  async rels(part: string): Promise<Relationship[]> {
    const cached = this.relCache.get(part)
    if (cached) return cached
    const tree = await this.tree(relsPartOf(part))
    const out: Relationship[] = []
    for (const r of children(tree ?? undefined, 'Relationship')) {
      const id = r.attrs.Id
      const type = r.attrs.Type
      const target = r.attrs.Target
      if (!id || !type || target === undefined) continue
      const external = r.attrs.TargetMode === 'External'
      out.push({ id, type, external, target: external ? target : resolvePartName(part, target) })
    }
    this.relCache.set(part, out)
    return out
  }

  async rel(part: string, id: string | undefined): Promise<Relationship | undefined> {
    if (!id) return undefined
    return (await this.rels(part)).find((r) => r.id === id)
  }

  /** The workbook part named by the package relationship (`xl/workbook.xml` in practice). */
  async workbookPart(): Promise<string> {
    const rels = await this.rels('')
    const main = rels.find((r) => r.type === REL.officeDocument || r.type === REL.strictOfficeDocument)
    if (main && this.has(main.target)) return main.target
    if (this.has('xl/workbook.xml')) return 'xl/workbook.xml'
    throw new XlsxImportError('not_xlsx', 'no workbook part')
  }
}
