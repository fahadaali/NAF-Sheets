// Pictures of an .xlsx (owner, 2026-11-11; apps/api OPEN_QUESTIONS.md "Images"):
//
// - floating, over the grid: every worksheet's drawing part (`/drawing`
//   relationship → xl/drawings/drawingN.xml, ECMA-376 Part 1 §20.5), its
//   `twoCellAnchor` / `oneCellAnchor` / `absoluteAnchor` holding a `pic`
//   whose `a:blip r:embed` names the picture in xl/media/ through the
//   drawing's relationships. Both origins write this: Excel (all three anchor
//   kinds) and Google Sheets' export (seen: `oneCellAnchor` with `ext`,
//   on 16 public exports, 2026-11-11);
// - inside a cell (Excel 365 "Place in cell"): the cell carries `vm="N"`, the
//   Nth `valueMetadata` block of xl/metadata.xml points through
//   `futureMetadata name="XLRICHVALUE"` (`xlrd:rvb i`) at a rich value of
//   xl/richData/rdrichvalue.xml; a `_localImage` structure's
//   `_rvRel:LocalImageIdentifier` indexes xl/richData/richValueRel.xml, whose
//   relationship names the picture in xl/media/. A `_webimage` (the cached
//   picture of `IMAGE(url)`) has no bytes in the file: it is reported, never
//   fetched (the server does not load pictures from the internet).
//
// Units: EMU (914400 per inch, 9525 per pixel at 96 dpi).
//
// Only the package is read here; checking each picture's bytes (type, size)
// and storing it is the caller's (the API, src/xlsx-import).

import type { ImageAnchor } from '@naf-sheets/gsheets-import'
import { REL, relIs, type XlsxPackage } from './package'
import { child, children, deepText, descendants, type XmlNode } from './xml'

export const EMU_PER_PIXEL = 9525

/** At most this many pictures are imported from one file; the rest are reported. */
export const MAX_IMPORTED_PICTURES = 200
/** Unpacked bytes of pictures read from one file; beyond it the rest are reported. */
export const MAX_PICTURE_BYTES_TOTAL = 40 * 1024 * 1024

export interface XlsxPicture {
  sheet: { gid: number; name: string }
  kind: 'floating' | 'in_cell'
  /** Floating pictures only. */
  anchor: ImageAnchor | null
  /** The anchor's top-left cell (floating) or the picture's cell (in cell), 0-based. */
  row: number
  column: number
  /** Natural size in pixels when the file says it (in-cell pictures: null). */
  width: number | null
  height: number | null
  /** The picture's part (`xl/media/image1.png`), or null when the file does not carry it. */
  part: string | null
  /** Why `part` is null. */
  missing?: 'external' | 'missing'
  /** The external address of a linked or web picture (never fetched). */
  url?: string
  title?: string
  description?: string
}

const px = (emu: string | undefined): number => {
  const n = Number(emu ?? 0)
  return Number.isFinite(n) ? n / EMU_PER_PIXEL : 0
}
const int = (text: string | undefined): number => {
  const n = Number((text ?? '').trim())
  return Number.isInteger(n) && n >= 0 ? n : 0
}

function marker(node: XmlNode | undefined) {
  return {
    column: int(child(node, 'col')?.text),
    columnOffset: px(child(node, 'colOff')?.text),
    row: int(child(node, 'row')?.text),
    rowOffset: px(child(node, 'rowOff')?.text),
  }
}

/** An attribute by local name, whatever its namespace prefix (`r:embed`, `rel:embed`). */
function attr(node: XmlNode | undefined, local: string): string | undefined {
  if (!node) return undefined
  for (const [k, v] of Object.entries(node.attrs)) if (k === local || k.endsWith(`:${local}`)) return v
  return undefined
}

/** Floating pictures of one worksheet part. */
export async function readSheetPictures(pkg: XlsxPackage, sheetPart: string, sheet: { gid: number; name: string }): Promise<XlsxPicture[]> {
  const out: XlsxPicture[] = []
  for (const rel of (await pkg.rels(sheetPart)).filter((r) => relIs(r, REL.drawing) && !r.external)) {
    const drawing = await pkg.tree(rel.target)
    if (!drawing) continue
    const drawingRels = await pkg.rels(rel.target)
    for (const anchor of drawing.children.filter((n) => /Anchor$/.test(n.name))) {
      // A picture of its own (pictures inside a group shape are reported as shapes by sheet.ts).
      const pic = children(anchor, 'pic')[0] ?? children(child(anchor, 'AlternateContent'), 'Choice').flatMap((c) => children(c, 'pic'))[0]
      if (!pic) continue
      let geometry: ImageAnchor
      if (anchor.name === 'twoCellAnchor') {
        const editAs = anchor.attrs.editAs === 'oneCell' || anchor.attrs.editAs === 'absolute' ? anchor.attrs.editAs : 'twoCell'
        geometry = { type: 'twoCell', from: marker(child(anchor, 'from')), to: marker(child(anchor, 'to')), editAs }
      } else if (anchor.name === 'oneCellAnchor') {
        const ext = child(anchor, 'ext')
        geometry = { type: 'oneCell', from: marker(child(anchor, 'from')), width: px(ext?.attrs.cx), height: px(ext?.attrs.cy) }
      } else if (anchor.name === 'absoluteAnchor') {
        const pos = child(anchor, 'pos')
        const ext = child(anchor, 'ext')
        geometry = { type: 'absolute', x: px(pos?.attrs.x), y: px(pos?.attrs.y), width: px(ext?.attrs.cx), height: px(ext?.attrs.cy) }
      } else continue
      const nv = descendants(pic, 'cNvPr')[0]
      const blip = descendants(pic, 'blip')[0]
      const embed = attr(blip, 'embed')
      const link = attr(blip, 'link')
      const target = embed ? drawingRels.find((r) => r.id === embed) : undefined
      const linked = link ? drawingRels.find((r) => r.id === link) : undefined
      const top = geometry.type === 'absolute' ? { row: 0, column: 0 } : { row: geometry.from.row, column: geometry.from.column }
      const size = geometry.type === 'twoCell' ? { width: null, height: null } : { width: geometry.width, height: geometry.height }
      const picture: XlsxPicture = { sheet, kind: 'floating', anchor: geometry, ...top, ...size, part: null }
      if (target && !target.external && pkg.has(target.target)) picture.part = target.target
      else if (linked?.external || target?.external) {
        picture.missing = 'external'
        picture.url = (linked ?? target)?.target
      } else picture.missing = 'missing'
      const title = nv?.attrs.title?.trim()
      const description = nv?.attrs.descr?.trim()
      if (title) picture.title = title
      if (description) picture.description = description
      out.push(picture)
    }
  }
  return out
}

/** What the `vm` index of a cell points at: a stored picture, a web picture, or nothing known. */
export type ValueMetadataImage = { part: string; description?: string } | { external: string } | null

/**
 * The in-cell pictures of the workbook by 1-based `vm` index (xl/metadata.xml
 * and xl/richData). Empty when the file has none.
 */
export async function readCellPictureIndex(pkg: XlsxPackage): Promise<Map<number, ValueMetadataImage>> {
  const out = new Map<number, ValueMetadataImage>()
  const find = (name: string) => pkg.zip.names().find((n) => n.toLowerCase() === name.toLowerCase()) ?? null
  const metadataPart = find('xl/metadata.xml')
  if (!metadataPart) return out
  const metadata = await pkg.tree(metadataPart)
  if (!metadata) return out
  const types = children(child(metadata, 'metadataTypes'), 'metadataType').map((t) => t.attrs.name ?? '')
  // futureMetadata blocks of XLRICHVALUE → rich value index.
  const future = children(metadata, 'futureMetadata').find((f) => f.attrs.name === 'XLRICHVALUE')
  const richIndexOfFuture = children(future, 'bk').map((bk) => {
    const rvb = descendants(bk, 'rvb')[0]
    return rvb ? int(rvb.attrs.i) : -1
  })

  const valuesPart = find('xl/richData/rdrichvalue.xml')
  const structuresPart = find('xl/richData/rdrichvaluestructure.xml')
  const relsPart = find('xl/richData/richValueRel.xml')
  const webPart = find('xl/richData/rdRichValueWebImage.xml')
  const values = valuesPart ? children((await pkg.tree(valuesPart)) ?? undefined, 'rv') : []
  const structures = structuresPart ? children((await pkg.tree(structuresPart)) ?? undefined, 's') : []
  const relList = relsPart ? children((await pkg.tree(relsPart)) ?? undefined, 'rel') : []
  const relTargets = relsPart ? await pkg.rels(relsPart) : []
  const webImages = webPart ? children((await pkg.tree(webPart)) ?? undefined, 'webImageSrd') : []
  const webRels = webPart ? await pkg.rels(webPart) : []

  const resolve = (richIndex: number): ValueMetadataImage => {
    const rv = values[richIndex]
    if (!rv) return null
    const structure = structures[int(rv.attrs.s)]
    if (!structure) return null
    const keys = children(structure, 'k').map((k) => k.attrs.n ?? '')
    const vals = children(rv, 'v').map((v) => deepText(v).trim())
    const get = (name: string) => {
      const i = keys.findIndex((k) => k === name)
      return i === -1 ? undefined : vals[i]
    }
    const kind = (structure.attrs.t ?? '').toLowerCase()
    if (kind === '_localimage') {
      const local = get('_rvRel:LocalImageIdentifier')
      const relNode = local === undefined ? undefined : relList[int(local)]
      const id = attr(relNode, 'id')
      const rel = id ? relTargets.find((r) => r.id === id) : undefined
      if (!rel || rel.external || !pkg.has(rel.target)) return null
      const text = get('Text')
      return text ? { part: rel.target, description: text } : { part: rel.target }
    }
    if (kind === '_webimage') {
      const web = webImages[int(get('WebImageIdentifier'))]
      const id = attr(child(web, 'address'), 'id')
      const rel = id ? webRels.find((r) => r.id === id) : undefined
      return { external: rel?.target ?? '' }
    }
    return null
  }

  children(child(metadata, 'valueMetadata'), 'bk').forEach((bk, i) => {
    const rc = child(bk, 'rc')
    if (!rc) return
    const type = types[int(rc.attrs.t) - 1]
    if (type !== 'XLRICHVALUE') return
    const richIndex = richIndexOfFuture[int(rc.attrs.v)]
    if (richIndex === undefined || richIndex < 0) return
    const resolved = resolve(richIndex)
    if (resolved !== null) out.set(i + 1, resolved)
  })
  return out
}

/** In-cell pictures of one sheet from its `vm` cells. */
export function cellPicturesOf(
  sheet: { gid: number; name: string },
  cells: ReadonlyArray<{ row: number; col: number; vm: number }>,
  index: ReadonlyMap<number, ValueMetadataImage>,
): XlsxPicture[] {
  const out: XlsxPicture[] = []
  for (const c of cells) {
    const target = index.get(c.vm)
    if (!target) continue
    const picture: XlsxPicture = { sheet, kind: 'in_cell', anchor: null, row: c.row, column: c.col, width: null, height: null, part: null }
    if ('part' in target) {
      picture.part = target.part
      if (target.description) picture.description = target.description
    } else {
      picture.missing = 'external'
      if (target.external) picture.url = target.external
    }
    out.push(picture)
  }
  return out
}

/** Pixel size of a PNG, GIF, JPEG or WebP from its header; null when it cannot be read. */
export function pictureSize(bytes: Uint8Array): { width: number; height: number } | null {
  const b = bytes
  const u16be = (o: number) => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0)
  const u16le = (o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8)
  const u32be = (o: number) => (((b[o] ?? 0) << 24) >>> 0) + ((b[o + 1] ?? 0) << 16) + ((b[o + 2] ?? 0) << 8) + (b[o + 3] ?? 0)
  if (b[0] === 0x89 && b[1] === 0x50) return { width: u32be(16), height: u32be(20) }
  if (b[0] === 0x47 && b[1] === 0x49) return { width: u16le(6), height: u16le(8) }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) return null
      const m = b[o + 1] as number
      const len = u16be(o + 2)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: u16be(o + 5), width: u16be(o + 7) }
      o += 2 + len
    }
    return null
  }
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const chunk = String.fromCharCode(b[12] ?? 0, b[13] ?? 0, b[14] ?? 0, b[15] ?? 0)
    if (chunk === 'VP8X') return { width: 1 + ((b[24] ?? 0) | ((b[25] ?? 0) << 8) | ((b[26] ?? 0) << 16)), height: 1 + ((b[27] ?? 0) | ((b[28] ?? 0) << 8) | ((b[29] ?? 0) << 16)) }
    if (chunk === 'VP8 ') return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff }
    if (chunk === 'VP8L') {
      const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
  }
  return null
}
