// Right-to-left sheet grid for Univer (spike; verified against Univer 1.4.0).
//
// Univer mirrors only its UI chrome in `direction: 'rtl'`; the canvas grid is
// always laid out left-to-right (column A on the left). This module mirrors
// the grid as a whole and then undoes the mirror wherever it must not apply:
//
//   1. The container holding the sheet canvas is flipped with CSS scaleX(-1):
//      column A, row headers, frozen panes and scrollbars all move across.
//   2. Text the sheet scene draws is flipped back in place so it reads
//      normally: plain cells per fillText call, rich/wrapped cells per glyph
//      group (a line segment), rotated cells as a whole cell. Images are
//      flipped back the same way. Cache compositing (canvas sources) is not.
//   3. DOM children of the flipped container (the cell editor) are flipped
//      back, keeping their mirrored position but readable content.
//   4. Cell-anchored popups: their anchor rectangles and their placement
//      direction are mirrored (a popup to the right of a cell opens on its left).
//   5. Input: ArrowLeft/ArrowRight are swapped for selection moves, touch hit
//      testing uses the mirrored x, and horizontal wheel deltas are negated.
//   6. Alignment is logical in the model (LEFT = start = visual right). The
//      toolbar and shortcuts are swapped so their left/right buttons mean what
//      they show; programmatic calls (Facade, sync, import) are not swapped.
//   7. Document text (the cell editor, the formula bar, rich-text cells) is
//      laid out by Univer in logical order with no bidi at all; rtl-text.ts
//      shows it in Unicode bidi order and makes caret, selection, hit testing
//      and arrow keys follow (see that file).
//
// The model is never changed by the mirror itself.
//
// Robustness against Univer upgrades: everything this module hooks is listed
// in `checkUniverContract()`. If any grid hook is missing, the stock grid is
// left untouched instead of half-mirroring it; if only a text hook is missing,
// the grid is mirrored and the document text stays stock. After enabling, a
// heartbeat confirms that text really went through the flip-back path; if it
// did not, the mirror is withdrawn (the text layer has a heartbeat of its own).
// Every outcome is reported through `RtlGridStatus`.

import { Direction, HorizontalAlign, IUniverInstanceService, Plugin } from '@univerjs/core'
import { Documents, Font, IRenderManagerService, UniverRenderEnginePlugin } from '@univerjs/engine-render'
import type { FUniver } from '@univerjs/presets'
import { SetHorizontalTextAlignCommand } from '@univerjs/sheets'
import { ExpandSelectionCommand, MoveSelectionCommand, UniverSheetsUIPlugin } from '@univerjs/sheets-ui'
import { ICanvasPopupService, IMenuManagerService } from '@univerjs/ui'
import { UniverDocsUIPlugin } from '@univerjs/docs-ui'
import { filter, firstValueFrom, map } from 'rxjs'
import type { Observable } from 'rxjs'
import { checkTextContract, enableRtlText } from './rtl-text'
import type { TextLayer } from './rtl-text'

/** The Univer release this layer was built and tested against. */
export const VERIFIED_UNIVER_VERSION = '1.4.0'

// ---------------------------------------------------------------------------
// Pure helpers (no Univer)
// ---------------------------------------------------------------------------

// Strong characters in the Unicode bidi sense are letters (Bidi_Class L, R, AL).
// Digits (EN/AN, incl. Arabic-Indic) and combining marks (NSM) are not strong,
// exactly as the browser's `dir="auto"` treats them.
const RTL_LETTER = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}]/u
const LETTER = /\p{L}/u

/** Paragraph direction the way `dir="auto"` decides it: the first strong character wins. */
export function firstStrongDirection(text: string): 'rtl' | 'ltr' {
  for (const ch of text) {
    if (!LETTER.test(ch)) continue
    return RTL_LETTER.test(ch) ? 'rtl' : 'ltr'
  }
  return 'rtl' // digits and punctuation only: follow the sheet
}

/** Left edge of the box a fillText call paints, from the context's alignment state. */
export function textBoxLeft(x: number, width: number, align: CanvasTextAlign, direction: CanvasDirection): number {
  if (align === 'center') return x - width / 2
  const alignsRight = align === 'right' || (align === 'end' && direction !== 'rtl') || (align === 'start' && direction === 'rtl')
  return alignsRight ? x - width : x
}

export interface Rect { left: number; right: number; top: number; bottom: number }

/** Mirror a client-coordinate rectangle across the vertical axis of `frame`. */
export function mirrorRect<T extends Rect>(rect: T, frame: Pick<DOMRect, 'left' | 'right'>): T {
  const axis = frame.left + frame.right
  return { ...rect, left: axis - rect.right, right: axis - rect.left }
}

/**
 * Mirror a Univer popup direction. Univer's plain `vertical`/`top`/`bottom`
 * align a popup with the anchor's left edge; mirrored, that is the right edge.
 * `horizontal` opens to the right of the anchor; mirrored, to the left.
 */
export function mirrorPopupDirection(direction: string | undefined): string {
  const d = direction ?? 'vertical'
  if (d === 'vertical' || d === 'top' || d === 'bottom') return `${d}-right`
  if (d === 'horizontal') return 'left'
  if (d.startsWith('horizontal-')) return `left-${d.slice('horizontal-'.length)}`
  return d.replace(/left|right/g, (m) => (m === 'left' ? 'right' : 'left'))
}

/**
 * Room a mirrored "vertical" popup needs below its anchor to open there: the
 * tallest cell popup Univer 1.4.0 draws is the data-validation list
 * (sheets-ui ListDropDown: search field, options capped at max-h-52 = 208 px,
 * «تحرير»; about 300 px), plus RectPopup's 16 px pushing gap.
 */
export const MIRRORED_POPUP_ROOM = 320

/**
 * The direction for a popup Univer asked to open "vertical" (or with no
 * direction), mirrored. Stock "vertical" opens below unless the popup does
 * not fit there (ui RectPopup calcPopupPosition: `endY > maxTop`) and aligns
 * with the anchor's left edge. The mirror needs the right edge, which only the
 * "-right" directions give, and Univer resolves "vertical-right" by which side
 * has MORE room (resolvePopupDirection), so a list in the lower half of the
 * screen opened above its cell although it fitted below (found by the apps/web
 * dropdown e2e at 375 px). With the room known: "bottom-right" when the popup
 * fits below, else "vertical-right" (Univer then takes the roomier side, as
 * stock does when it does not fit).
 */
export function mirroredVerticalDirection(roomBelow: number | null): 'bottom-right' | 'vertical-right' {
  return roomBelow !== null && roomBelow >= MIRRORED_POPUP_ROOM ? 'bottom-right' : 'vertical-right'
}

/** The anchor's current rectangle when the popup is added: its static rect, or the value its stream holds now. */
function currentAnchor(item: Record<string, unknown>): Rect | null {
  if (item.anchorRect) return item.anchorRect as Rect
  const stream = item.anchorRect$ as Observable<Rect> | undefined
  if (!stream || typeof stream.subscribe !== 'function') return null
  let now: Rect | null = null
  try {
    stream.subscribe((r) => (now ??= r)).unsubscribe()
  } catch {
    return null
  }
  return now
}

/**
 * Popups whose side Univer itself already picks from the UI direction:
 * sheets-drawing-ui 1.4.0 opens the image menu (`COMPONENT_IMAGE_POPUP_MENU`)
 * with `direction: localeService.getDirection() === 'rtl' ? 'left' : 'horizontal'`
 * (DrawingPopupMenuController). Its 'left' is meant for a right-to-left UI,
 * so on the mirrored grid it stays 'left': the menu opens at the image's end
 * side, as Univer intends. Checked against the installed source in
 * test/contract.test.ts.
 */
export const RTL_AWARE_POPUPS: ReadonlyMap<string, string> = new Map([['COMPONENT_IMAGE_POPUP_MENU', 'left']])

/** True when `item` is a popup of RTL_AWARE_POPUPS asking for the side Univer chose for a right-to-left UI. */
export function keepsRtlDirection(item: { componentKey?: unknown }, asked: string | undefined): boolean {
  return typeof item.componentKey === 'string' && asked !== undefined && RTL_AWARE_POPUPS.get(item.componentKey) === asked
}

/** LEFT and RIGHT trade places; everything else (CENTER, JUSTIFIED, ...) is direction-free. */
export function swapHorizontalAlign<T>(value: T): T {
  if (value === (HorizontalAlign.LEFT as unknown as T)) return HorizontalAlign.RIGHT as unknown as T
  if (value === (HorizontalAlign.RIGHT as unknown as T)) return HorizontalAlign.LEFT as unknown as T
  return value
}

// ---------------------------------------------------------------------------
// Contract: every Univer internal this module relies on, checked up front
// ---------------------------------------------------------------------------

type AnyFn = (...args: any[]) => unknown // eslint-disable-line @typescript-eslint/no-explicit-any
const isFn = (v: unknown): v is AnyFn => typeof v === 'function'

export interface ContractReport {
  /** Installed Univer versions (core, engine-render, sheets-ui, docs-ui). */
  versions: Record<string, string>
  /** True when every installed version equals VERIFIED_UNIVER_VERSION. */
  verifiedVersion: boolean
  /** Missing or changed grid hooks. Empty means the grid can be mirrored safely. */
  problems: string[]
  /** Missing or changed hooks of the document-text layer (rtl-text.ts). Empty means it can be applied. */
  textProblems: string[]
}

/** Static part of the contract: module-level hooks that exist before any workbook. */
export function checkUniverContract(): ContractReport {
  const versions = {
    core: String((Plugin as unknown as { version?: string }).version),
    'engine-render': String((UniverRenderEnginePlugin as unknown as { version?: string }).version),
    'sheets-ui': String((UniverSheetsUIPlugin as unknown as { version?: string }).version),
    'docs-ui': String((UniverDocsUIPlugin as unknown as { version?: string }).version),
  }
  const problems: string[] = []
  const docs = Documents.prototype as unknown as Record<string, unknown>
  const font = Font.prototype as unknown as Record<string, unknown>
  if (!isFn(docs._drawGlyphGroup) || docs._drawGlyphGroup.length < 7) problems.push('Documents.prototype._drawGlyphGroup(ctx, scale, group, line, alignOffset, centerAngle, vertexAngle, ...)')
  if (!isFn(docs._drawGlyphGroupBackgrounds) || docs._drawGlyphGroupBackgrounds.length < 7) problems.push('Documents.prototype._drawGlyphGroupBackgrounds(...7 args)')
  if (!isFn(font._renderDocuments)) problems.push('Font.prototype._renderDocuments')
  for (const [name, cmd, id] of [
    ['MoveSelectionCommand', MoveSelectionCommand, 'sheet.command.move-selection'],
    ['ExpandSelectionCommand', ExpandSelectionCommand, 'sheet.command.expand-selection'],
    ['SetHorizontalTextAlignCommand', SetHorizontalTextAlignCommand, 'sheet.command.set-horizontal-text-align'],
  ] as const) {
    const c = cmd as unknown as { id?: string; handler?: unknown }
    if (c.id !== id || !isFn(c.handler)) problems.push(`${name} (id ${id}, handler)`)
  }
  const ctx2d = CanvasRenderingContext2D.prototype as unknown as Record<string, unknown>
  if (!('direction' in CanvasRenderingContext2D.prototype)) problems.push('CanvasRenderingContext2D.direction (browser)')
  for (const m of ['fillText', 'strokeText', 'drawImage', 'measureText']) if (!isFn(ctx2d[m])) problems.push(`CanvasRenderingContext2D.${m}`)
  return { versions, verifiedVersion: Object.values(versions).every((v) => v === VERIFIED_UNIVER_VERSION), problems, textProblems: checkTextContract() }
}

// ---------------------------------------------------------------------------
// Global patches (installed once, inert unless a mirrored scene is rendering)
// ---------------------------------------------------------------------------

// >0 while a mirrored scene is rendering: only then is anything flipped back.
let mirroredRenderDepth = 0
// >0 while an enclosing transform already flipped content back (glyph group or rotated cell).
let flippedBackDepth = 0
// Plain text draws that went through the flip-back path. Plain cells and the
// headers are the bulk of what a sheet draws, so the heartbeat watches this.
let textFlipCount = 0

/** Run `draw` mirrored around the vertical axis through the middle of [left, left + width]. */
function flipBackAround(ctx: CanvasRenderingContext2D, left: number, width: number, draw: () => void) {
  ctx.save()
  ctx.translate(2 * left + width, 0)
  ctx.scale(-1, 1)
  try {
    draw()
  } finally {
    ctx.restore()
  }
}

type TextDraw = (this: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth?: number) => void
function flipTextBack(original: TextDraw): TextDraw {
  return function (this: CanvasRenderingContext2D, text, x, y, maxWidth) {
    if (mirroredRenderDepth === 0 || flippedBackDepth > 0) return original.call(this, text, x, y, maxWidth)
    const value = String(text)
    let width = this.measureText(value).width
    if (maxWidth !== undefined && maxWidth < width) width = maxWidth
    const left = textBoxLeft(x, width, this.textAlign, this.direction)
    textFlipCount++
    flipBackAround(this, left, width, () => {
      this.textAlign = 'left'
      this.direction = firstStrongDirection(value)
      if (maxWidth === undefined) original.call(this, value, left, y)
      else original.call(this, value, left, y, maxWidth)
    })
  }
}

const isCanvasSource = (s: unknown) =>
  s instanceof HTMLCanvasElement || (typeof OffscreenCanvas !== 'undefined' && s instanceof OffscreenCanvas)

type DrawImage = (this: CanvasRenderingContext2D, ...args: unknown[]) => void
function flipImageBack(original: DrawImage): DrawImage {
  return function (this: CanvasRenderingContext2D, ...args: unknown[]) {
    // Canvas sources are Univer compositing its own (already mirrored) caches.
    if (mirroredRenderDepth === 0 || flippedBackDepth > 0 || isCanvasSource(args[0])) return original.apply(this, args)
    let dx: number
    let dw: number
    if (args.length >= 9) [dx, dw] = [args[5] as number, args[7] as number]
    else if (args.length >= 5) [dx, dw] = [args[1] as number, args[3] as number]
    else {
      const src = args[0] as { width?: number; naturalWidth?: number }
      ;[dx, dw] = [args[1] as number, src.naturalWidth ?? src.width ?? 0]
    }
    flipBackAround(this, dx, dw, () => original.apply(this, args))
  }
}

let contextPatched = false
function patchCanvas() {
  if (contextPatched) return
  contextPatched = true
  const proto = CanvasRenderingContext2D.prototype
  proto.fillText = flipTextBack(proto.fillText)
  proto.strokeText = flipTextBack(proto.strokeText)
  proto.drawImage = flipImageBack(proto.drawImage as unknown as DrawImage) as unknown as typeof proto.drawImage
}

interface GlyphLike { width: number; left: number; xOffset?: number }
type GroupDraw = (ctx: CanvasRenderingContext2D, parentScale: unknown, group: GlyphLike[], lineOrHeight: unknown, alignOffset: { x: number }, centerAngle: number, vertexAngle: number, ...rest: unknown[]) => void

let documentsPatched = false
function patchDocuments() {
  if (documentsPatched) return
  documentsPatched = true
  const proto = Documents.prototype as unknown as { _drawGlyphGroup: GroupDraw; _drawGlyphGroupBackgrounds: GroupDraw }
  const wrap = (original: GroupDraw): GroupDraw =>
    function (this: { _drawLiquid?: { x: number } }, ctx, parentScale, group, lineOrHeight, alignOffset, centerAngle, vertexAngle, ...rest) {
      const call = () => original.call(this, ctx, parentScale, group, lineOrHeight, alignOffset, centerAngle, vertexAngle, ...rest)
      // Rotated text is handled a level up, as a whole cell (see patchFont).
      if (mirroredRenderDepth === 0 || flippedBackDepth > 0 || centerAngle !== 0 || vertexAngle !== 0 || !this._drawLiquid || group.length === 0) return call()
      let min = Infinity
      let max = -Infinity
      for (const g of group) {
        const start = g.left + (g.xOffset ?? 0)
        min = Math.min(min, start)
        max = Math.max(max, start + g.width)
      }
      const origin = this._drawLiquid.x + (alignOffset?.x ?? 0)
        flippedBackDepth++
      try {
        flipBackAround(ctx, origin + min, max - min, call)
      } finally {
        flippedBackDepth--
      }
    }
  proto._drawGlyphGroup = wrap(proto._drawGlyphGroup)
  proto._drawGlyphGroupBackgrounds = wrap(proto._drawGlyphGroupBackgrounds)
}

type RenderDocuments = (ctx: CanvasRenderingContext2D, row: number, col: number, renderFontCtx: { startX: number; endX: number; fontCache?: { vertexAngle?: number; centerAngle?: number } }, overflowCache: unknown) => void

let fontPatched = false
/** Rotated cells: flip the whole cell back, so it looks exactly as in an unmirrored grid. */
function patchFont() {
  if (fontPatched) return
  fontPatched = true
  const proto = Font.prototype as unknown as { _renderDocuments: RenderDocuments }
  const original = proto._renderDocuments
  proto._renderDocuments = function (this: unknown, ctx, row, col, renderFontCtx, overflowCache) {
    const fc = renderFontCtx.fontCache
    const rotated = (fc?.vertexAngle ?? 0) !== 0 || (fc?.centerAngle ?? 0) !== 0
    if (mirroredRenderDepth === 0 || flippedBackDepth > 0 || !rotated) return original.call(this, ctx, row, col, renderFontCtx, overflowCache)
    // The context is already translated to the cell's start.
    flippedBackDepth++
    try {
      flipBackAround(ctx, 0, renderFontCtx.endX - renderFontCtx.startX, () => original.call(this, ctx, row, col, renderFontCtx, overflowCache))
    } finally {
      flippedBackDepth--
    }
  }
}

// Units whose grid is mirrored; command patches apply only while one of them has focus.
const mirroredUnits = new Set<string>()
type Accessor = { get: <T>(id: unknown) => T }
const focusedIsMirrored = (accessor: Accessor) => {
  const unit = accessor.get<{ getFocusedUnit: () => { getUnitId: () => string } | null }>(IUniverInstanceService).getFocusedUnit()
  return Boolean(unit && mirroredUnits.has(unit.getUnitId()))
}

type Handler<P> = (accessor: Accessor, params?: P, options?: unknown) => unknown
let commandsPatched = false
/**
 * Command parameters from shortcuts are shared objects reused on every key
 * press: never mutate them. Each handler is wrapped and given a swapped copy.
 */
function patchCommands() {
  if (commandsPatched) return
  commandsPatched = true
  const swapDir: Partial<Record<Direction, Direction>> = { [Direction.LEFT]: Direction.RIGHT, [Direction.RIGHT]: Direction.LEFT }
  for (const command of [MoveSelectionCommand, ExpandSelectionCommand] as unknown as Array<{ handler: Handler<{ direction?: Direction }> }>) {
    const original = command.handler
    command.handler = (accessor, params, options) => {
      const d = params?.direction
      const swapped = d !== undefined ? swapDir[d] : undefined
      if (swapped === undefined || !focusedIsMirrored(accessor)) return original(accessor, params, options)
      return original(accessor, { ...params, direction: swapped }, options)
    }
  }
  // Toolbar and shortcuts send only `{ value }`; Facade, import and sync send an
  // explicit `range` and mean the model value. Only the former is swapped.
  const align = SetHorizontalTextAlignCommand as unknown as { handler: Handler<{ value?: HorizontalAlign; range?: unknown }> }
  const originalAlign = align.handler
  align.handler = (accessor, params, options) => {
    if (!params || params.range !== undefined || params.value === undefined || !focusedIsMirrored(accessor)) return originalAlign(accessor, params, options)
    return originalAlign(accessor, { ...params, value: swapHorizontalAlign(params.value) }, options)
  }
}

// ---------------------------------------------------------------------------
// Per-workbook enable
// ---------------------------------------------------------------------------

const STYLE_ID = 'naf-rtl-grid-style'
function injectStyle() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = '.naf-rtl-grid{transform:scaleX(-1)}.naf-rtl-grid>.naf-rtl-unflip{transform:scaleX(-1)}'
  document.head.append(style)
}

type Injector = { get: <T>(id: unknown) => T }
type InputManagerLike = { _getObjectAtEvent: AnyFn; _getObjectAtPos: AnyFn }
type SceneLike = { render: AnyFn; _inputManager?: Partial<InputManagerLike> }
type RenderUnitLike = { unitId: string; scene: SceneLike; engine: { getCanvasElement: () => HTMLCanvasElement; width: number; height: number } }
type RenderManagerLike = { getRenderUnitById: (id: string) => RenderUnitLike | null | undefined; created$: Observable<RenderUnitLike> }
type MenuFactory = (accessor: Accessor) => Record<string, unknown>

/** Poll once per frame until `probe` returns a value, or fail after `timeoutMs`. */
function waitFor<T>(probe: () => T | null | undefined, what: string, timeoutMs = 5000): Promise<T> {
  const started = performance.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const value = probe()
      if (value != null) return resolve(value)
      if (performance.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${what}`))
      requestAnimationFrame(tick)
    }
    tick()
  })
}

/** Paths (from the menu root) of every node keyed by `id`. */
function findMenuPaths(node: Record<string, unknown>, id: string, path: string[] = []): string[][] {
  const out: string[][] = []
  for (const [key, child] of Object.entries(node)) {
    if (!child || typeof child !== 'object') continue
    if (key === id) out.push([...path, key])
    else out.push(...findMenuPaths(child as Record<string, unknown>, id, [...path, key]))
  }
  return out
}

export interface RtlGridOptions {
  /**
   * When the installed Univer differs from VERIFIED_UNIVER_VERSION but every
   * hook is present: `'mirror'` (default) applies and reports
   * `verifiedVersion: false`; `'skip'` leaves the stock grid.
   */
  onUnverifiedVersion?: 'mirror' | 'skip'
  /** Called with the outcome; called again if the heartbeat later withdraws the mirror. */
  onStatus?: (status: RtlGridStatus) => void
}

export interface RtlGridStatus extends ContractReport {
  mirrored: boolean
  /** Set when the grid is not mirrored, or when it is but the text layer is not applied (English, for an administrator). */
  reason?: string
  /** The document-text layer (cell editor, formula bar, rich-text cells): applied, or why not. */
  text: { applied: boolean; reason?: string; formula?: { applied: boolean; reason?: string } }
  dispose: () => void
}

/**
 * Mirror the grid of `unitId`. Call after `createWorkbook`: the render unit and
 * the canvas container appear asynchronously, so this waits for both. Never
 * throws for a contract problem: it returns `mirrored: false` with the reason
 * and leaves the stock grid untouched.
 */
export async function enableRtlGrid(univerAPI: FUniver, unitId: string, options: RtlGridOptions = {}): Promise<RtlGridStatus> {
  const report = checkUniverContract()
  const noop = () => {}
  const report$ = (status: RtlGridStatus) => {
    options.onStatus?.(status)
    if (!status.mirrored) console.error(`[rtl-grid] grid left unmirrored: ${status.reason}`, status)
    else if (!status.text.applied) console.error(`[rtl-grid] grid mirrored, document text left stock: ${status.text.reason}`, status)
    return status
  }
  const noText = { applied: false, reason: 'the grid is not mirrored' }
  if (report.problems.length) return report$({ ...report, mirrored: false, reason: `Univer contract broken: ${report.problems.join('; ')}`, text: noText, dispose: noop })
  if (!report.verifiedVersion && options.onUnverifiedVersion === 'skip') {
    return report$({ ...report, mirrored: false, reason: `Univer ${JSON.stringify(report.versions)} is not the verified ${VERIFIED_UNIVER_VERSION}`, text: noText, dispose: noop })
  }

  const injector = (univerAPI as unknown as { _injector?: Injector })._injector
  if (!injector || !isFn(injector.get)) return report$({ ...report, mirrored: false, reason: 'Univer contract broken: FUniver._injector', text: noText, dispose: noop })
  const manager = injector.get<RenderManagerLike>(IRenderManagerService)
  const renderUnit = manager.getRenderUnitById(unitId) ?? (await firstValueFrom(manager.created$.pipe(filter((r) => r.unitId === unitId))))
  const { scene, engine } = renderUnit
  const canvas = engine.getCanvasElement()
  const inputManager = scene._inputManager
  const popupService = injector.get<{ addPopup: (item: Record<string, unknown>) => string }>(ICanvasPopupService)
  const menuService = injector.get<{ _menu?: Record<string, unknown>; mergeMenu: (source: Record<string, unknown>) => void }>(IMenuManagerService)
  const instanceProblems: string[] = []
  if (!isFn(scene.render)) instanceProblems.push('scene.render')
  if (!inputManager || !isFn(inputManager._getObjectAtEvent) || !isFn(inputManager._getObjectAtPos)) instanceProblems.push('scene._inputManager._getObjectAtEvent/_getObjectAtPos')
  if (!isFn(popupService?.addPopup)) instanceProblems.push('ICanvasPopupService.addPopup')
  if (!menuService?._menu || !isFn(menuService.mergeMenu)) instanceProblems.push('IMenuManagerService._menu/mergeMenu')
  else if (findMenuPaths(menuService._menu, SetHorizontalTextAlignCommand.id).length === 0) instanceProblems.push('toolbar item sheet.command.set-horizontal-text-align')
  if (instanceProblems.length) {
    return report$({ ...report, problems: instanceProblems, mirrored: false, reason: `Univer contract broken: ${instanceProblems.join('; ')}`, text: noText, dispose: noop })
  }
  const frame = await waitFor(() => canvas.parentElement, 'the sheet canvas to be mounted')

  patchCanvas()
  // The text layer goes first: its glyph-group hook then sits inside the
  // grid's flip-back (either order composes; this one is the tested one).
  let status: RtlGridStatus | null = null
  const text: TextLayer = enableRtlText(injector, (why) => {
    if (!status) return
    status.text = { applied: false, reason: why, formula: { applied: false, reason: why } }
    if (status.mirrored) status.reason = `document text left stock: ${why}`
    report$(status)
  })
  patchDocuments()
  patchFont()
  patchCommands()
  injectStyle()
  mirroredUnits.add(unitId)

  // 1 + 2. Flip the container; flip content back while this scene renders.
  const originalRender = scene.render
  scene.render = function (this: unknown, ...args: unknown[]) {
    mirroredRenderDepth++
    try {
      return originalRender.apply(this, args)
    } finally {
      mirroredRenderDepth--
    }
  }
  frame.classList.add('naf-rtl-grid')

  // 3. DOM children other than the canvas (the cell editor) read normally.
  const unflipChildren = () => {
    for (const child of Array.from(frame.children)) if (child !== canvas) child.classList.add('naf-rtl-unflip')
  }
  unflipChildren()
  const observer = new MutationObserver(unflipChildren)
  observer.observe(frame, { childList: true })

  // 4. Cell-anchored popups: mirror anchor geometry and placement direction.
  const originalAddPopup = popupService.addPopup
  popupService.addPopup = function (item: Record<string, unknown>) {
    if (item.canvasElement !== canvas) return originalAddPopup.call(this, item)
    const flip = <T extends Rect>(r: T) => mirrorRect(r, canvas.getBoundingClientRect())
    const flipMany = (rs: Rect[] | null | undefined) => rs?.map(flip)
    const asked = item.direction as string | undefined
    // A popup that already chose its side for a right-to-left UI keeps it
    // (mirroring it again would put it back on the start side).
    let direction = keepsRtlDirection(item, asked) ? (asked as string) : mirrorPopupDirection(asked)
    if (asked === undefined || asked === 'vertical') {
      const anchor = currentAnchor(item)
      // The boundary is the window unless the popup names another (data-validation lists do not).
      direction = mirroredVerticalDirection(anchor && !item.boundaryElement && !item.constrainToCanvas ? window.innerHeight - anchor.bottom : null)
    }
    const mirrored: Record<string, unknown> = { ...item, direction }
    if (item.anchorRect$) mirrored.anchorRect$ = (item.anchorRect$ as Observable<Rect>).pipe(map(flip))
    if (item.anchorRect) mirrored.anchorRect = flip(item.anchorRect as Rect)
    if (item.excludeRects$) mirrored.excludeRects$ = (item.excludeRects$ as Observable<Rect[]>).pipe(map(flipMany))
    if (item.excludeRects) mirrored.excludeRects = flipMany(item.excludeRects as Rect[])
    if (item.hiddenRects$) mirrored.hiddenRects$ = (item.hiddenRects$ as Observable<Rect[]>).pipe(map(flipMany))
    return originalAddPopup.call(this, mirrored)
  }

  // 5a. Touch hit testing reads clientX (mouse uses the transform-aware offsetX).
  const im = inputManager as InputManagerLike
  const originalGetObjectAtEvent = im._getObjectAtEvent
  im._getObjectAtEvent = function (this: InputManagerLike, evt: { deviceType?: number; clientX: number; clientY: number }) {
    const rect = canvas.getBoundingClientRect()
    if (evt.deviceType !== 3 || !Number.isFinite(evt.clientX) || rect.width <= 0 || rect.height <= 0) return originalGetObjectAtEvent.call(this, evt)
    return this._getObjectAtPos((rect.right - evt.clientX) * engine.width / rect.width, (evt.clientY - rect.top) * engine.height / rect.height, evt.deviceType)
  }

  // 5b. A physical horizontal swipe scrolls the way it looks.
  const onWheel = (e: WheelEvent) => {
    if (e.deltaX === 0 || (e as WheelEvent & { __nafMirrored?: boolean }).__nafMirrored) return
    e.stopImmediatePropagation()
    e.preventDefault()
    const copy = new WheelEvent('wheel', {
      bubbles: true, cancelable: true, composed: true,
      clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
      deltaX: -e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ, deltaMode: e.deltaMode,
      ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
    })
    ;(copy as WheelEvent & { __nafMirrored?: boolean }).__nafMirrored = true
    e.target?.dispatchEvent(copy)
  }
  frame.addEventListener('wheel', onWheel, { capture: true, passive: false })

  // 6. Toolbar: the alignment selector shows the button that matches what the
  //    user sees. Its factory is wrapped and written back through mergeMenu.
  const menuRoot = menuService._menu!
  for (const path of findMenuPaths(menuRoot, SetHorizontalTextAlignCommand.id)) {
    let node = menuRoot
    for (const key of path) node = node[key] as Record<string, unknown>
    const original = node.menuItemFactory as (MenuFactory & { __nafRtl?: boolean }) | undefined
    if (!isFn(original) || original.__nafRtl) continue
    const wrapped: MenuFactory & { __nafRtl?: boolean } = (accessor) => {
      const item = original(accessor)
      if (!focusedIsMirrored(accessor)) return item
      const selections = item.selections as Array<{ value: unknown; icon?: string }> | undefined
      const value$ = item.value$ as Observable<unknown> | undefined
      // With no alignment the text sits at the start (visual right): show that button.
      const shownDefault = selections?.find((s) => s.value === HorizontalAlign.RIGHT)
      return { ...item, icon: shownDefault?.icon ?? item.icon, value$: value$?.pipe(map(swapHorizontalAlign)) }
    }
    wrapped.__nafRtl = true
    const patch = path.reduceRight<Record<string, unknown>>(
      (acc, key, i) => (i === path.length - 1 ? { [key]: { ...node, menuItemFactory: wrapped } } : { [key]: acc }),
      {},
    )
    menuService.mergeMenu(patch)
  }

  // Full repaint of the workbook's active sheet through the public Facade.
  const redraw = () => {
    try {
      ;(univerAPI as unknown as { getWorkbook: (id: string) => { getActiveSheet: () => { refreshCanvas: () => unknown } } | null }).getWorkbook(unitId)?.getActiveSheet().refreshCanvas()
    } catch (e) {
      console.error('[rtl-grid] redraw failed', e)
    }
  }

  const dispose = () => {
    text.dispose()
    frame.removeEventListener('wheel', onWheel, { capture: true })
    im._getObjectAtEvent = originalGetObjectAtEvent
    popupService.addPopup = originalAddPopup
    observer.disconnect()
    frame.classList.remove('naf-rtl-grid')
    for (const child of Array.from(frame.children)) child.classList.remove('naf-rtl-unflip')
    scene.render = originalRender
    mirroredUnits.delete(unitId)
    redraw() // repaint unmirrored, so no flipped-back text is left on the canvas
  }

  status = {
    ...report,
    textProblems: text.problems,
    mirrored: true,
    reason: report.verifiedVersion ? (text.applied ? undefined : `document text left stock: ${text.reason}`) : `unverified Univer ${JSON.stringify(report.versions)}`,
    text: { applied: text.applied, reason: text.reason, formula: text.formula },
    dispose,
  }
  const mirroredStatus = status
  // Heartbeat: within a few frames, plain text must have gone through the
  // flip-back path. If Univer stopped drawing through the hooked calls, the
  // mirrored text would be unreadable: withdraw the mirror instead and report it.
  const before = textFlipCount
  // Whatever was painted before the mirror existed is now shown flipped by the
  // CSS transform: glyphs mirrored. Repaint everything now, through the hooks.
  // (Without this, a sheet that was already painted and then sits idle shows
  // mirrored text and fails the heartbeat — found by the apps/web e2e suite.)
  redraw()
  void (async () => {
    const start = performance.now()
    while (performance.now() - start < 3000 && textFlipCount === before) await new Promise((r) => requestAnimationFrame(r))
    if (textFlipCount === before) {
      dispose()
      mirroredStatus.mirrored = false
      mirroredStatus.reason = 'heartbeat failed: no text went through the flip-back path'
      mirroredStatus.text = { applied: false, reason: 'the grid mirror was withdrawn' }
      report$(mirroredStatus)
    }
  })()
  return report$(mirroredStatus)
}
