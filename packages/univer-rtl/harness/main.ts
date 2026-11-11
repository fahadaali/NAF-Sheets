// Verification harness for @naf-sheets/univer-rtl. Copied from the phase 0
// spike page (spike/univer/src/main.ts, kept there as evidence); the only
// functional change is that the layer comes from this package's source
// (../src), so the interaction suite tests the copy the application ships.
// Nothing here is production code.
//
// Query params:
//   ?dir=rtl   Univer UI direction rtl + worksheet.rightToLeft = 1 (default)
//   ?dir=ltr   both left-to-right, as a baseline for comparison
//   ?align=1   force horizontalAlign=right on Arabic cells (workaround probe)
//   ?grid=mirror            mirror the grid (and apply the document-text layer)
//   ?textLayer=1            unmirrored grid with only the document-text layer
//                           (the reference for comparisons with the mirrored grid)
//   ?simulateBreak=contract|heartbeat|text-contract|text-heartbeat|formula-contract
//                           break the layer on purpose to prove its safety nets
//   ?formulaColours=0       Univer's own formula colouring (no formula-colours layer)

import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import SheetsCoreArSA from '@univerjs/preset-sheets-core/locales/ar-SA'
import { UniverSheetsConditionalFormattingPreset } from '@univerjs/preset-sheets-conditional-formatting'
import SheetsCfArSA from '@univerjs/preset-sheets-conditional-formatting/locales/ar-SA'
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter'
import SheetsFilterArSA from '@univerjs/preset-sheets-filter/locales/ar-SA'
import { UniverSheetsSortPreset } from '@univerjs/preset-sheets-sort'
import SheetsSortArSA from '@univerjs/preset-sheets-sort/locales/ar-SA'
import { UniverSheetsDataValidationPreset } from '@univerjs/preset-sheets-data-validation'
import SheetsDvArSA from '@univerjs/preset-sheets-data-validation/locales/ar-SA'
import { UniverSheetsHyperLinkPreset } from '@univerjs/preset-sheets-hyper-link'
import SheetsLinkArSA from '@univerjs/preset-sheets-hyper-link/locales/ar-SA'
import { UniverSheetsNotePreset } from '@univerjs/preset-sheets-note'
import SheetsNoteArSA from '@univerjs/preset-sheets-note/locales/ar-SA'
import { UniverSheetsDrawingPreset } from '@univerjs/preset-sheets-drawing'
import SheetsDrawingArSA from '@univerjs/preset-sheets-drawing/locales/ar-SA'
import { UniverSheetsFindReplacePreset } from '@univerjs/preset-sheets-find-replace'
import SheetsFindReplaceArSA from '@univerjs/preset-sheets-find-replace/locales/ar-SA'
import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets'
import type { IWorkbookData } from '@univerjs/presets'
import { InterceptorEffectEnum, LifecycleStages } from '@univerjs/core'
import { INTERCEPTOR_POINT, SheetInterceptorService } from '@univerjs/sheets'
import { enableFormulaColours, enableRtlGrid, enableRtlText, formulaColourCounters, textLayerCounters, textLayerState } from '../src/index'
import type { FormulaPalette } from '../src/index'
import type { RtlGridStatus } from '../src/index'
import { Documents, IRenderManagerService } from '@univerjs/engine-render'
import { NodePositionConvertToCursor } from '@univerjs/docs-ui'
import { IPlatformService } from '@univerjs/ui'
import { RefSelectionsRenderService } from '@univerjs/sheets-formula-ui'

import '@univerjs/preset-sheets-core/lib/index.css'
import '@univerjs/preset-sheets-conditional-formatting/lib/index.css'
import '@univerjs/preset-sheets-filter/lib/index.css'
import '@univerjs/preset-sheets-sort/lib/index.css'
import '@univerjs/preset-sheets-data-validation/lib/index.css'
import '@univerjs/preset-sheets-hyper-link/lib/index.css'
import '@univerjs/preset-sheets-note/lib/index.css'
import '@univerjs/preset-sheets-drawing/lib/index.css'
import '@univerjs/preset-sheets-find-replace/lib/index.css'
// Spike only: community packaging of Thmanyah, served from jsDelivr.
// Production must self-host the official files (see docs/phase-0-report.md).
import '@dawod/thmanyah-font-web/sans.css'

// Univer's Nullable<T> includes `void`, which optional chaining rejects.
const some = <T>(x: T | null | undefined | void): T | undefined => (x ?? undefined) as T | undefined

const params = new URLSearchParams(location.search)
const dir = params.get('dir') === 'ltr' ? 'ltr' : 'rtl'
const forceAlign = params.get('align') === '1'
// ?marks=1 — probe: do Unicode bidi controls inside the value fix mixed Arabic/Latin order?
const probeMarks = params.get('marks') === '1'
// ?isolate=1 — probe: wrap mixed Arabic/Latin strings in RLI…PDI at display time
// only, through the CELL_CONTENT interceptor, leaving the stored value untouched.
const probeIsolate = params.get('isolate') === '1'
// ?grid=mirror — mirror the whole grid right-to-left (../src/rtl-grid.ts)
const mirrorGrid = params.get('grid') === 'mirror'
const FONT = 'Thmanyah Sans'

// Arabic cells, plus the mixed-direction strings the spec calls high-risk:
// digits, Latin words, dates and slash-separated case numbers.
const header = ['المهمة', 'المسؤول', 'تاريخ البدء', 'تاريخ الاستحقاق', 'الحالة', 'المرفقات', 'ملاحظات']
const rows = [
  ['إعداد خطة الاتصال للربع الأول', 'فهد', '2026-11-01', '2026-11-20', 'قيد التنفيذ', '', 'مراجعة مع الفريق'],
  ['مراجعة البيان الصحفي', 'سارة', '2026-11-02', '2026-11-05', 'منجز', 'report.pdf', 'نسخة v2 معتمدة'],
  ['متابعة قضية رقم 2291/ت/1447', 'خالد', '2026-11-03', '2026-11-04', 'متأخر', '', 'الجلسة 10:30'],
  ['تصميم إنفوجرافيك النظام الجديد', 'نورة', '2026-11-05', '2026-11-25', 'قيد التنفيذ', '', ''],
  ['نشر المقال على LinkedIn', 'فهد', '2026-11-06', '2026-11-07', 'منجز', '', 'المبلغ 12,400.00 ريال'],
]

type Cell = { v: string | number; s?: string; f?: string }
const cellData: Record<number, Record<number, Cell>> = {}
cellData[0] = Object.fromEntries(header.map((h, c) => [c, { v: h, s: 'hdr' }]))
rows.forEach((r, i) => {
  cellData[i + 1] = Object.fromEntries(r.map((v, c) => [c, { v, s: 'body' }]))
})
// Row 8: a wrapped cell — drawn glyph by glyph through Univer's document
// renderer, unlike the single-line cells above. Mixed Arabic, Latin and a
// slash-separated case number on purpose.
cellData[7] = {
  0: { v: 'نص طويل يلتف على أكثر من سطر داخل الخلية، فيه كلمة Basecamp ورقم القضية 2291/ت/1447 لاختبار الترتيب', s: 'wrap' },
}

if (probeMarks) {
  const probe = 'نشر المقال على LinkedIn'
  const variants: [string, string][] = [
    ['plain', probe],
    ['RLM prefix', '\u200F' + probe],
    ['RLM suffix', probe + '\u200F'],
    ['RLE…PDF', '\u202B' + probe + '\u202C'],
    ['RLI…PDI', '\u2067' + probe + '\u2069'],
    ['LRI around Latin', 'نشر المقال على \u2066LinkedIn\u2069'],
  ]
  variants.forEach(([label, value], i) => {
    cellData[10 + i] = { 0: { v: value, s: 'body' }, 6: { v: label, s: 'body' } }
  })
}

// Sheet "bidi": the mixed-direction strings the document-text layer (cell
// editor, formula bar) must order as the browser does. Row 7 stays empty for
// typing; B1 holds an Arabic hyperlink (a rich-text cell drawn as a document).
const bidiRows = [
  'نشر المقال على LinkedIn Ads',
  'موعد التسليم 2026-11-10 بمبلغ 12,400.00 ريال',
  'متابعة قضية رقم 2291/ت/1447',
  'هل انتهى العمل؟',
  '(مسودة) خطة الربع الأول.',
  'Basecamp API v2',
  '',
  'إعداد خطة الاتصال',
]

// Sheet "lists": the items and chip colours of its status dropdown.
const LIST_STATUSES = ['قيد التنفيذ', 'منجز', 'متأخر']
const LIST_COLOURS = ['#bfe1f6', '#d4edbc', '#ffcfc9']

const hAlign = forceAlign ? { ht: 3 } : {} // HorizontalAlign.RIGHT = 3

const workbook: Partial<IWorkbookData> = {
  id: 'spike-wb',
  name: 'اختبار الجدوى',
  appVersion: '1.4.0',
  locale: LocaleType.AR_SA,
  sheetOrder: ['tasks', 'summary', 'extras', 'bidi', 'lists'],
  styles: {
    hdr: { ff: FONT, fs: 12, bl: 1, bg: { rgb: '#E8F0FE' }, ...hAlign },
    body: { ff: FONT, fs: 11, ...hAlign },
    wrap: { ff: FONT, fs: 11, tb: 3, ...hAlign }, // WrapStrategy.WRAP
    rot45: { ff: FONT, fs: 11, tr: { a: 45 } },
    rot90: { ff: FONT, fs: 11, tr: { a: 90 } },
  },
  sheets: {
    tasks: {
      id: 'tasks',
      name: 'المهام',
      tabColor: '#1a73e8',
      rowCount: 50,
      columnCount: 12,
      rightToLeft: dir === 'rtl' ? 1 : 0,
      freeze: { xSplit: 1, ySplit: 1, startRow: 1, startColumn: 1 },
      columnData: { 0: { w: 260 }, 1: { w: 90 }, 2: { w: 110 }, 3: { w: 120 }, 4: { w: 100 }, 5: { w: 110 }, 6: { w: 200 } },
      rowData: { 7: { h: 72 } },
      cellData,
    },
    summary: {
      id: 'summary',
      name: 'ملخص',
      rowCount: 20,
      columnCount: 6,
      rightToLeft: dir === 'rtl' ? 1 : 0,
      columnData: { 0: { w: 200 }, 1: { w: 260 } },
      cellData: {
        0: { 0: { v: 'المؤشر', s: 'hdr' }, 1: { v: 'القيمة', s: 'hdr' } },
        1: { 0: { v: 'أول مهمة', s: 'body' }, 1: { f: "='المهام'!A2", v: '', s: 'body' } },
        2: { 0: { v: 'عدد المنجز', s: 'body' }, 1: { f: "=COUNTIF('المهام'!E2:E6,\"منجز\")", v: '', s: 'body' } },
        3: { 0: { v: 'عدد المهام', s: 'body' }, 1: { f: "=COUNTA('المهام'!A2:A50)", v: '', s: 'body' } },
        4: { 0: { v: 'طول A6', s: 'body' }, 1: { f: "=LEN('المهام'!A6)", v: '', s: 'body' } },
      },
    },
    // Special cases kept off the main sheet so its evidence screenshots stay stable.
    extras: {
      id: 'extras',
      name: 'حالات خاصة',
      rowCount: 30,
      columnCount: 10,
      rightToLeft: dir === 'rtl' ? 1 : 0,
      columnData: { 0: { w: 120 }, 1: { w: 120 }, 2: { w: 120 }, 3: { w: 140 } },
      rowData: { 1: { h: 80 } },
      mergeData: [{ startRow: 0, endRow: 0, startColumn: 0, endColumn: 2 }],
      cellData: {
        0: { 0: { v: 'خلية مدمجة على ثلاثة أعمدة A1:C1', s: 'hdr' }, 3: { v: 'نص عادي', s: 'body' } },
        1: { 0: { v: 'نص مائل 45', s: 'rot45' }, 1: { v: 'Rotated 45', s: 'rot45' }, 2: { v: 'رأسي 90', s: 'rot90' } },
        3: { 0: { v: 10, s: 'body' }, 1: { v: 20, s: 'body' } },
        4: { 0: { v: 30, s: 'body' }, 1: { v: 40, s: 'body' } },
      },
    },
    bidi: {
      id: 'bidi',
      name: 'نصوص',
      rowCount: 20,
      columnCount: 6,
      rightToLeft: dir === 'rtl' ? 1 : 0,
      columnData: { 0: { w: 420 }, 1: { w: 200 } },
      cellData: Object.fromEntries(bidiRows.map((v, r) => [r, { 0: { v, s: 'body' } }])),
    },
    // Dropdowns as the Google Sheets / Excel import writes them (apps/api
    // OPEN_QUESTIONS.md "Google import" G32): coloured chips with Arabic items
    // in A, a multiple selection in B (Google's "a, b" text), on enough rows
    // that a list can open in the lower half of the screen.
    lists: {
      id: 'lists',
      name: 'قوائم',
      rowCount: 40,
      columnCount: 6,
      rightToLeft: dir === 'rtl' ? 1 : 0,
      columnData: { 0: { w: 160 }, 1: { w: 220 } },
      cellData: Object.fromEntries(
        Array.from({ length: 30 }, (_, r): [number, Record<number, Cell>] => {
          if (r === 0) return [r, { 0: { v: 'الحالة', s: 'hdr' }, 1: { v: 'الفريق', s: 'hdr' } }]
          const line: Record<number, Cell> = { 0: { v: LIST_STATUSES[(r - 1) % 3] as string, s: 'body' } }
          if (r === 1) line[1] = { v: 'فهد, سارة', s: 'body' }
          return [r, line]
        }),
      ),
    },
  },
  resources: [
    {
      name: 'SHEET_DATA_VALIDATION_PLUGIN',
      data: JSON.stringify({
        lists: [
          // renderMode 2 = chip; formula2 = colours by position (sheets-data-validation computeAndCache).
          { uid: 'dv-status', type: 'list', formula1: JSON.stringify(LIST_STATUSES), formula2: LIST_COLOURS.join(','), renderMode: 2, errorStyle: 1, allowBlank: true, ranges: [{ startRow: 1, endRow: 29, startColumn: 0, endColumn: 0 }] },
          { uid: 'dv-team', type: 'listMultiple', formula1: JSON.stringify(['فهد', 'سارة', 'خالد']), formula2: '#bfe1f6,#ffcfc9,#d4edbc', renderMode: 2, errorStyle: 1, allowBlank: true, ranges: [{ startRow: 1, endRow: 29, startColumn: 1, endColumn: 1 }] },
        ],
      }),
    },
  ],
}

const { univerAPI } = createUniver({
  locale: LocaleType.AR_SA,
  direction: dir,
  locales: {
    [LocaleType.AR_SA]: mergeLocales(
      SheetsCoreArSA,
      SheetsCfArSA,
      SheetsFilterArSA,
      SheetsSortArSA,
      SheetsDvArSA,
      SheetsLinkArSA,
      SheetsNoteArSA,
      SheetsDrawingArSA,
      SheetsFindReplaceArSA,
    ),
  },
  presets: [
    UniverSheetsCorePreset({ container: 'app' }),
    UniverSheetsConditionalFormattingPreset(),
    UniverSheetsFilterPreset(),
    UniverSheetsSortPreset(),
    UniverSheetsDataValidationPreset(),
    UniverSheetsHyperLinkPreset(),
    UniverSheetsNotePreset(),
    UniverSheetsDrawingPreset(),
    UniverSheetsFindReplacePreset(),
  ],
})

// Every executed command (id + params), from before the workbook exists: lets
// tests see exactly what changed the model and when.
const commandLog: Array<{ id: string; params: string }> = []
;(window as unknown as { __commandLog: typeof commandLog }).__commandLog = commandLog
univerAPI.addEvent(univerAPI.Event.CommandExecuted, (e) => {
  let params: string
  try {
    params = JSON.stringify(e.params ?? null).slice(0, 300)
  } catch {
    params = '[unserialisable]' // some operations carry circular objects
  }
  commandLog.push({ id: e.id, params })
})

const results: Record<string, unknown> = { dir, forceAlign, probeIsolate, mirrorGrid }

// The layer's status, where the interaction suite reads it.
function publishStatus(s: RtlGridStatus) {
  ;(window as unknown as { __rtlStatus: unknown }).__rtlStatus = { mirrored: s.mirrored, reason: s.reason, versions: s.versions, verifiedVersion: s.verifiedVersion, problems: s.problems, textProblems: s.textProblems, text: s.text }
}

const errors: string[] = []
const attempt = async (name: string, fn: () => unknown | Promise<unknown>) => {
  try {
    results[name] = (await fn()) ?? true
  } catch (e) {
    results[name] = false
    errors.push(`${name}: ${(e as Error).message}`)
  }
}

async function run() {
  // Fonts must be ready before the canvas lays out text, or the first paint
  // uses the fallback face and metrics are wrong.
  await document.fonts.load(`16px "${FONT}"`, 'ثمانية')
  results.fontLoaded = document.fonts.check(`16px "${FONT}"`, 'ثمانية')

  const fWorkbook = univerAPI.createWorkbook(workbook)
  // ?enableEarly=1 — enable the mirror right after createWorkbook, before
  // Univer has rendered, as apps/web does (the text layer must then wait for
  // Univer's cursor controller). Awaited below, after the steady wait.
  const enableEarly = params.get('enableEarly') === '1'
  const earlyEnable = mirrorGrid && enableEarly ? enableRtlGrid(univerAPI, 'spike-wb', { onStatus: publishStatus }) : null

  // Deterministic start in every mode: wait until Univer is steady and the cell
  // editor is initialised before mutating anything. Otherwise Univer's automatic
  // row heights run or not depending on timing (seen as row 8 = 72 vs 59 px).
  await new Promise<void>((resolve) => {
    const started = performance.now()
    const tick = () => {
      const ready = univerAPI.getCurrentLifecycleStage() >= LifecycleStages.Steady && commandLog.some((c) => c.id === 'doc.command-replace-snapshot')
      if (ready || performance.now() - started > 5000) return resolve()
      requestAnimationFrame(tick)
    }
    tick()
  })
  const ws = fWorkbook.getSheetBySheetId('tasks')!

  // Formula colours (../src/formula-colours.ts), on unless ?formulaColours=0.
  // The palette is test data copied from apps/web/src/styles/theme.css
  // (--formula-*): the application reads it from there.
  if (params.get('formulaColours') !== '0') {
    if (params.get('simulateBreak') === 'formula-contract') {
      // A hooked internal with a changed signature, as an upgrade might bring.
      const proto = RefSelectionsRenderService.prototype as unknown as { resetSelectionsByModelData: (...a: unknown[]) => unknown }
      const original = proto.resetSelectionsByModelData
      proto.resetSelectionsByModelData = function (this: unknown, ...a: unknown[]) {
        return original.apply(this, a)
      }
    }
    const palette: FormulaPalette = {
      references: ['#326ac7', '#c0353e', '#8157b7', '#007c20', '#b03e84', '#b64900', '#267392'],
      plain: '#1f2a2e', function: '#8a5a00', sheet: '#55606a', string: '#6b6e12', number: '#0d6e60',
      boolean: '#3b4a8a', comparison: '#7a2350', operator: '#6b6355', error: '#8b1a1a',
    }
    const status = enableFormulaColours(univerAPI, palette)
    ;(window as unknown as { __formulaColours: unknown }).__formulaColours = { palette, applied: status.applied, themed: status.themed, reason: status.reason, problems: status.problems, counters: formulaColourCounters }
  }

  // Diagnostic handles for the performance script (rtl-perf.mjs) and the
  // interaction suite: the sheet scene, and the render manager (the cell
  // editor's and the formula bar's document skeletons are read through it).
  {
    const rm = (univerAPI as unknown as { _injector: { get: (t: unknown) => { getRenderUnitById: (id: string) => { scene: unknown } | null } } })._injector.get(IRenderManagerService)
    ;(window as unknown as { __sheetScene: unknown }).__sheetScene = rm.getRenderUnitById('spike-wb')?.scene
    ;(window as unknown as { __renderManager: unknown }).__renderManager = rm
  }

  // ?delay=ms — wait before the setup steps (diagnostic: separates timing effects from mirroring effects)
  const delay = Number(params.get('delay') ?? 0)
  if (delay > 0) await new Promise((r) => setTimeout(r, delay))

  // ?simulateBreak=contract|heartbeat — break the layer on purpose to prove the
  // safety nets: a missing Univer hook must leave the stock grid untouched; text
  // that stops flowing through the flip-back path must withdraw the mirror.
  const simulateBreak = params.get('simulateBreak')
  // The stock glyph-group painter, before the layer wraps it (for text-heartbeat below).
  const stockGlyphGroup = (Documents.prototype as unknown as { _drawGlyphGroup: unknown })._drawGlyphGroup
  if (simulateBreak === 'text-contract') {
    // A docs-ui hook with a different signature: only the text layer must notice.
    const proto = NodePositionConvertToCursor.prototype as unknown as { getRangePointData: (...a: unknown[]) => unknown }
    const original = proto.getRangePointData
    proto.getRangePointData = function (this: unknown, ...a: unknown[]) {
      return original.apply(this, a)
    }
  }
  if (simulateBreak === 'contract') {
    // Same behaviour, different signature — as an upgrade might change it.
    // Univer keeps working; only the layer's contract check notices.
    const proto = Documents.prototype as unknown as { _drawGlyphGroup: (...a: unknown[]) => unknown }
    const original = proto._drawGlyphGroup
    proto._drawGlyphGroup = function (this: unknown, ...a: unknown[]) {
      return original.apply(this, a)
    }
  }

  // ?enableAfterIdle=1 — enable the mirror only once the sheet has been painted
  // and has gone idle, as apps/web does when it opens a file (regression test:
  // without a repaint on enable, the idle sheet kept mirrored glyphs and the
  // heartbeat withdrew the mirror).
  const enableAfterIdle = params.get('enableAfterIdle') === '1'
  const enableMirror = () =>
    attempt('rtlGridEnabled', async () => {
      const status = await enableRtlGrid(univerAPI, 'spike-wb', { onStatus: publishStatus })
      if (simulateBreak === 'text-heartbeat') {
        // Univer painting document glyphs another way: the stock painter back in place of the hooks.
        ;(Documents.prototype as unknown as { _drawGlyphGroup: unknown })._drawGlyphGroup = stockGlyphGroup
      }
      if (simulateBreak === 'heartbeat') {
        // Put the browser's own fillText back (taken from a fresh realm), so
        // text bypasses the flip-back wrapper as if Univer drew another way.
        const frame = document.createElement('iframe')
        document.body.append(frame)
        const native = (frame.contentWindow as unknown as { CanvasRenderingContext2D: typeof CanvasRenderingContext2D }).CanvasRenderingContext2D.prototype.fillText
        CanvasRenderingContext2D.prototype.fillText = native
      }
      return status.mirrored
    })
  if (earlyEnable) await attempt('rtlGridEnabled', async () => (await earlyEnable).mirrored)
  else if (mirrorGrid && !enableAfterIdle) await enableMirror()
  if (!mirrorGrid && params.get('textLayer') === '1') {
    await attempt('textLayerOnly', () => {
      const layer = enableRtlText((univerAPI as unknown as { _injector: unknown })._injector, () => {})
      ws.refreshCanvas()
      return layer.applied
    })
  }

  // A floating image on the special-cases sheet: asymmetric on purpose (an
  // arrow and Latin text), so an accidental mirror is obvious.
  await attempt('imageInserted', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="60"><rect width="160" height="60" fill="#fde68a"/><path d="M10 30 H120 M100 12 L124 30 L100 48" stroke="#1d4ed8" stroke-width="8" fill="none"/><text x="128" y="22" font-size="14" font-family="sans-serif" fill="#111">RTL</text></svg>'
    const url = 'data:image/svg+xml;base64,' + btoa(svg)
    return fWorkbook.getSheetBySheetId('extras')!.insertImage(url, 4, 3)
  })

  // Sheet services exist only after the first sheet unit is created.
  if (probeIsolate) {
    const ARABIC = /[\u0600-\u06FF]/
    const LATIN = /[A-Za-z]/
    const injector = (univerAPI as unknown as { _injector: { get: (t: unknown) => SheetInterceptorService } })._injector
    injector.get(SheetInterceptorService).intercept(INTERCEPTOR_POINT.CELL_CONTENT, {
      effect: InterceptorEffectEnum.Value,
      priority: 100,
      handler: (cell, _location, next) => {
        const c = some(cell)
        const v = c?.v
        if (typeof v === 'string' && ARABIC.test(v) && LATIN.test(v) && !c?.p) {
          return next({ ...cell, v: '\u2067' + v + '\u2069' })
        }
        return next(cell)
      },
    })
  }

  await attempt('conditionalFormatting', () => {
    const range = ws.getRange('E2:E50')
    const rule = ws.newConditionalFormattingRule()
      .whenTextEqualTo('متأخر')
      .setRanges([range.getRange()])
      .setBackground('#F4C7C3')
      .setFontColor('#A50E0E')
      .build()
    ws.addConditionalFormattingRule(rule)
    return ws.getConditionalFormattingRules().length
  })

  await attempt('dataValidationDropdown', () => {
    const rule = univerAPI.newDataValidation()
      .requireValueInList(['فهد', 'سارة', 'خالد', 'نورة'], true, true)
      .setOptions({ showErrorMessage: true, error: 'اختر اسماً من القائمة' })
      .build()
    ws.getRange('B2:B50').setDataValidation(rule)
    return some(ws.getRange('B2').getDataValidation())?.getCriteriaType()
  })

  await attempt('filter', () => {
    const filter = ws.getRange('A1:G6').createFilter()
    return Boolean(filter && ws.getFilter())
  })

  await attempt('note', () => {
    ws.getRange('G4').createOrUpdateNote({ note: 'ملاحظة على الخلية: الجلسة الساعة 10:30', width: 180, height: 80, show: false })
    return some(ws.getRange('G4').getNote())?.note
  })

  await attempt('hyperlink', async () => {
    await ws.getRange('F3').setHyperLink('https://example.com/report.pdf', 'report.pdf')
    return ws.getRange('F3').getValue()
  })

  await attempt('sortCommandAvailable', () => typeof ws.getRange('A2:G6').sort === 'function')

  // A rich-text cell with Arabic text: drawn through Univer's document renderer, not fillText per cell.
  await attempt('arabicHyperlink', async () => {
    const bidi = fWorkbook.getSheetBySheetId('bidi')!
    await bidi.getRange('B1').setHyperLink('https://example.com/q1', 'تقرير الربع الأول')
    return bidi.getRange('B1').getValue()
  })

  // Execute a real sort (due date, descending), then undo it: covers §5.1
  // "sorting" and "undo/redo", and leaves the sheet as it was for screenshots.
  // ?selftest=0 skips this mutate-then-undo check, so interaction tests start
  // from exactly the loaded data (an undo racing Univer's auto row height can
  // otherwise leave the sort applied).
  if (params.get('selftest') !== '0') await attempt('sortAndUndo', async () => {
    const before = ws.getRange('A2').getValue()
    await ws.getRange('A2:G6').sort({ column: 3, ascending: false })
    await new Promise((r) => setTimeout(r, 300))
    const afterSort = ws.getRange('A2').getValue()
    await univerAPI.undo()
    await new Promise((r) => setTimeout(r, 300))
    const afterUndo = ws.getRange('A2').getValue()
    return { before, afterSort, afterUndo }
  })

  // Wait for the formula engine to finish the cross-sheet formulas.
  await new Promise((r) => setTimeout(r, 1500))
  const summary = fWorkbook.getSheetBySheetId('summary')!
  await attempt('crossSheetFormula', () => ({
    firstTask: summary.getRange('B2').getValue(),
    doneCount: summary.getRange('B3').getValue(),
    taskCount: summary.getRange('B4').getValue(),
    lenA6: summary.getRange('B5').getValue(),
  }))
  // What the API and the stored model return for the mixed cell: must stay raw.
  results.a6ViaFacade = JSON.stringify(ws.getRange('A6').getValue())
  results.a6RawModel = JSON.stringify(some(ws.getSheet().getCellRaw(5, 0))?.v)

  if (mirrorGrid && enableAfterIdle) {
    await new Promise((r) => setTimeout(r, 1500))
    await enableMirror()
  }

  results.rightToLeftModel = (ws.getSheet().getConfig() as { rightToLeft?: number }).rightToLeft
  results.errors = errors
  ;(window as unknown as { __spike: unknown }).__spike = results
  document.title = 'SPIKE-READY'
}

run().catch((e) => {
  errors.push(`run: ${(e as Error).message}`)
  ;(window as unknown as { __spike: unknown }).__spike = { ...results, errors }
  document.title = 'SPIKE-READY'
})

;(window as unknown as { univerAPI: unknown }).univerAPI = univerAPI
// Diagnostics of the document-text layer, for the interaction suite.
;(window as unknown as { __rtlText: unknown }).__rtlText = { state: textLayerState, counters: textLayerCounters }
// Univer's own platform decision, which picks its key map: with Mac bindings,
// line start/end are Cmd+Left/Right and Home/End are not bound. Playwright's
// WebKit identifies itself as Safari on a Mac, so it gets Mac bindings.
;(window as unknown as { __univerKeys: unknown }).__univerKeys = () => ({
  mac: (univerAPI as unknown as { _injector: { get: (t: unknown) => { isMac: boolean } } })._injector.get(IPlatformService).isMac,
  appVersion: navigator.appVersion,
  platform: navigator.platform,
})
