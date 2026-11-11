// An .xlsx package → the Google `Spreadsheet` intermediate model of
// @naf-sheets/gsheets-import, normalised by origin, plus the report items
// only the package can tell (drawings, tables, macros…).

import type { GsNamedRange, GsSheet, GsSpreadsheet } from '@naf-sheets/gsheets-import'
import { MESSAGES } from '@naf-sheets/gsheets-import'
import { readIndexedPalette, readTheme, XlsxColors } from './colors'
import { DEFAULT_XLSX_LIMITS, XlsxImportError, type XlsxLimits } from './errors'
import { detectOrigin, type DetectedOrigin } from './origin'
import { REL, relIs, XlsxPackage } from './package'
import { parseSheetRef, toGridRange } from './ref'
import { readSharedStrings, type SharedString } from './shared-strings'
import { readSheet, type OriginFamily, type PendingItem } from './sheet'
import { readStyleSheet, type DefaultFont } from './styles'
import { child, children, deepText } from './xml'
import { ZipArchive } from './zip'

export interface ReadOptions {
  limits?: Partial<XlsxLimits>
}

export interface LocatedItem {
  /** Null: the workbook as a whole. */
  sheet: { gid: number; name: string } | null
  item: PendingItem
}

export interface XlsxReadResult {
  spreadsheet: GsSpreadsheet
  origin: DetectedOrigin
  defaultFont: DefaultFont
  dateSystem: 'date1900' | 'date1904'
  items: LocatedItem[]
  /** docProps/core.xml dc:title, when the file has one. */
  title: string | null
  /** Unpacked bytes read, for the audit. */
  unpackedBytes: number
}

const MAX_NAME = 200

export async function readXlsx(bytes: Uint8Array, options: ReadOptions = {}): Promise<XlsxReadResult> {
  const limits: XlsxLimits = { ...DEFAULT_XLSX_LIMITS, ...options.limits }
  const zip = ZipArchive.open(bytes, limits)
  const pkg = new XlsxPackage(zip)
  const workbookPart = await pkg.workbookPart()
  if (!workbookPart.toLowerCase().endsWith('.xml')) throw new XlsxImportError('not_xlsx', `workbook part ${workbookPart}`)
  const workbook = await pkg.tree(workbookPart)
  if (!workbook || workbook.name !== 'workbook') throw new XlsxImportError('not_xlsx', 'no <workbook>')
  const wbRels = await pkg.rels(workbookPart)

  // ---- origin signals from the package ------------------------------------------
  const app = await pkg.tree('docProps/app.xml').catch(() => null)
  const core = await pkg.tree('docProps/core.xml').catch(() => null)
  const application = app ? deepText(child(app, 'Application')).trim() || null : null
  const hasDocProps = zip.names().some((n) => n.toLowerCase().startsWith('docprops/'))
  const themeRel = wbRels.find((r) => relIs(r, REL.theme) && !r.external)
  const themeTree = themeRel ? await pkg.tree(themeRel.target) : null
  const theme = readTheme(themeTree)
  const namespaces = Object.entries(workbook.attrs)
    .filter(([k]) => k.startsWith('xmlns'))
    .map(([, v]) => v)
  const signals = {
    application,
    hasDocProps,
    workbookNamespaces: namespaces,
    themeName: theme.name,
    hasPersonsPart: zip.names().some((n) => /^xl\/persons\//i.test(n)),
    googleDummyFunction: false,
  }
  const preliminary = detectOrigin(signals)
  const family: OriginFamily = preliminary.kind === 'google_export' ? 'google_export' : 'excel_like'

  // ---- styles and strings ----------------------------------------------------------
  const stylesRel = wbRels.find((r) => relIs(r, REL.styles) && !r.external)
  const stylesTree = stylesRel ? await pkg.tree(stylesRel.target) : null
  const colors = new XlsxColors(theme, readIndexedPalette(stylesTree))
  const styles = readStyleSheet(stylesTree, colors)
  const sstRel = wbRels.find((r) => relIs(r, REL.sharedStrings) && !r.external)
  const sstText = sstRel ? await pkg.text(sstRel.target) : null
  const sharedStrings: SharedString[] = sstText ? readSharedStrings(sstText, colors, styles) : []

  const wbPr = child(workbook, 'workbookPr')
  const date1904 = wbPr?.attrs.date1904 === '1' || wbPr?.attrs.date1904 === 'true'

  // ---- sheets ------------------------------------------------------------------------
  const sheetNodes = children(child(workbook, 'sheets'), 'sheet')
  const usedGids = new Set<number>()
  const entries = sheetNodes.map((node, index) => {
    let gid = Number(node.attrs.sheetId)
    if (!Number.isInteger(gid) || gid < 0 || usedGids.has(gid)) gid = 1_000_000 + index
    usedGids.add(gid)
    const name = Array.from((node.attrs.name ?? `Sheet${index + 1}`).trim()).slice(0, MAX_NAME).join('') || `Sheet${index + 1}`
    return { node, gid, name, index }
  })
  const sheetGids = new Map(entries.map((e) => [e.name, e.gid]))
  let cells = 0
  const declared = { remaining: limits.maxCells * 2 }
  const countCell = () => {
    cells++
    if (cells > limits.maxCells) throw new XlsxImportError('too_large', `more than ${limits.maxCells} cells`)
  }

  const sheets: GsSheet[] = []
  const items: LocatedItem[] = []
  let sawGoogleDummy = false
  for (const e of entries) {
    const rel = wbRels.find((r) => r.id === (e.node.attrs['r:id'] ?? e.node.attrs.id))
    const hidden = e.node.attrs.state === 'hidden' || e.node.attrs.state === 'veryHidden'
    if (!rel || rel.external || !relIs(rel, REL.worksheet)) {
      // Chart sheets, dialog sheets and Excel 4 macro sheets have no grid to import.
      sheets.push({ properties: { sheetId: e.gid, title: e.name, index: e.index, sheetType: 'OBJECT', hidden } })
      continue
    }
    const result = await readSheet({
      pkg,
      part: rel.target,
      gid: e.gid,
      name: e.name,
      family,
      styles,
      colors,
      sharedStrings,
      sheetGids,
      date1904,
      countCell,
      maxDeclaredCells: declared,
    })
    sawGoogleDummy ||= result.sawGoogleDummy
    const props = result.sheet.properties as NonNullable<GsSheet['properties']>
    props.index = e.index
    props.hidden = hidden
    sheets.push(result.sheet)
    for (const item of result.items) items.push({ sheet: { gid: e.gid, name: e.name }, item })
  }
  if (!sheets.some((s) => s.properties?.sheetType === 'GRID')) throw new XlsxImportError('no_sheets')

  // ---- defined names ---------------------------------------------------------------------
  const namedRanges: GsNamedRange[] = []
  let printSettings = false
  for (const dn of children(child(workbook, 'definedNames'), 'definedName')) {
    const name = dn.attrs.name ?? ''
    if (/^_xlnm\._FilterDatabase$/i.test(name)) continue // Excel's own bookkeeping for autofilters
    if (/^_xlnm\.(Print_Area|Print_Titles)$/i.test(name)) {
      printSettings = true
      continue
    }
    const ref = parseSheetRef(dn.text)
    const gid = ref ? sheetGids.get(ref.sheet) : undefined
    if (!ref || gid === undefined || name.startsWith('_xlnm.')) {
      items.push({
        sheet: null,
        item: { kind: 'named_range', outcome: 'not_transferred', range: null, message: MESSAGES.namedRange('قيمته معادلة أو ثابت أو نطاق غير متصل، لا نطاق واحد'), detail: name },
      })
      continue
    }
    // OPEN: G28 — a name local to one sheet (localSheetId) becomes workbook-wide.
    namedRanges.push({ namedRangeId: `xlsx-${namedRanges.length}`, name, range: toGridRange(ref.range, gid) })
  }

  // ---- what only the package can tell ---------------------------------------------------
  const names = zip.names().map((n) => n.toLowerCase())
  const workbookItem = (message: string, kind: PendingItem['kind'] = 'unsupported_feature', outcome: PendingItem['outcome'] = 'not_transferred') =>
    items.push({ sheet: null, item: { kind, outcome, range: null, message } })
  if (names.some((n) => n.endsWith('vbaproject.bin'))) workbookItem(MESSAGES.macros())
  if (names.some((n) => n.startsWith('xl/externallinks/')) || children(child(workbook, 'externalReferences'), 'externalReference').length > 0) {
    workbookItem(MESSAGES.externalLinks())
  }
  if (names.includes('xl/connections.xml')) workbookItem(MESSAGES.dataConnections())
  if (names.some((n) => n.startsWith('xl/featurepropertybag/'))) {
    const bag = await pkg.text('xl/featurePropertyBag/featurePropertyBag.xml').catch(() => null)
    if (bag?.includes('Checkbox')) workbookItem(MESSAGES.excelCheckboxes())
  }
  if (printSettings) workbookItem(MESSAGES.printSettings())
  if (styles.patternFills > 0) workbookItem(MESSAGES.patternFill(), 'cell_format', 'converted')

  const calcPr = child(workbook, 'calcPr')
  const spreadsheet: GsSpreadsheet = {
    properties: { title: '', locale: undefined },
    sheets,
    namedRanges,
  }
  if (calcPr && (calcPr.attrs.iterate === '1' || calcPr.attrs.iterate === 'true')) {
    const settings: { maxIterations?: number; convergenceThreshold?: number } = {}
    const count = Number(calcPr.attrs.iterateCount)
    const delta = Number(calcPr.attrs.iterateDelta)
    settings.maxIterations = Number.isFinite(count) && count > 0 ? count : 100
    settings.convergenceThreshold = Number.isFinite(delta) && delta > 0 ? delta : 0.001
    ;(spreadsheet.properties as NonNullable<GsSpreadsheet['properties']>).iterativeCalculationSettings = settings
  }

  const origin = detectOrigin({ ...signals, googleDummyFunction: sawGoogleDummy })
  const title = core ? deepText(child(core, 'title')).trim() || null : null
  return {
    spreadsheet,
    origin,
    defaultFont: styles.defaultFont,
    dateSystem: date1904 ? 'date1904' : 'date1900',
    items,
    title,
    unpackedBytes: zip.unpackedBytes,
  }
}
