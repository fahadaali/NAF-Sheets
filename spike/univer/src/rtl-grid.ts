// Right-to-left sheet grid for Univer 1.4.0 (spike).
//
// Univer mirrors only its UI chrome in `direction: 'rtl'`; the canvas grid is
// always laid out left-to-right (column A on the left). This module mirrors
// the grid as a whole and then undoes the mirror wherever it must not apply:
//
//   1. The container holding the sheet canvas is flipped with CSS scaleX(-1):
//      column A, row headers, frozen panes and scrollbars all move across.
//   2. Every piece of text the sheet scene draws is flipped back in place, so
//      it reads normally. Plain cells draw a whole line per fillText call and
//      are flipped per call; rich/wrapped cells draw glyph by glyph and are
//      flipped per glyph group (a line segment), so letter order survives.
//   3. DOM children of the flipped container (the cell editor) are flipped
//      back, keeping their mirrored position but readable content.
//   4. Popups anchored to cells compute their position from the unflipped
//      canvas geometry; their anchor rectangles are mirrored.
//   5. ArrowLeft/ArrowRight are swapped for selection moves (on a copy of the
//      command parameters), and horizontal wheel deltas are negated, so input
//      follows what the user sees.
//
// Semantics: the model is not changed. Horizontal alignment becomes logical —
// LEFT renders at the start (visual right), RIGHT at the end (visual left) —
// which is why Univer's default alignment now lands on the right.
//
// Pointer hit-testing needs no patch: Univer reads MouseEvent.offsetX, which
// browsers report in the element's own (untransformed) coordinates.

import { Direction } from '@univerjs/core'
import type { FUniver } from '@univerjs/presets'
import { Documents, IRenderManagerService } from '@univerjs/engine-render'
import { ICanvasPopupService } from '@univerjs/ui'
import { IUniverInstanceService } from '@univerjs/core'
import { ExpandSelectionCommand, MoveSelectionCommand } from '@univerjs/sheets-ui'
import { filter, firstValueFrom, map } from 'rxjs'
import type { Observable } from 'rxjs'

// >0 while the mirrored scene is rendering: only then is text flipped back.
let mirroredRenderDepth = 0
// >0 while a glyph group is flipped as a whole: individual glyphs are left alone.
let groupFlipDepth = 0

const RTL_STRONG = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/
const LTR_STRONG = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/

/** Paragraph direction the way `dir="auto"` decides it: the first strong character wins. */
export function firstStrongDirection(text: string): 'rtl' | 'ltr' {
  for (const ch of text) {
    if (RTL_STRONG.test(ch)) return 'rtl'
    if (LTR_STRONG.test(ch)) return 'ltr'
  }
  return 'rtl' // digits and punctuation only: follow the sheet
}

/** Left edge of the box a fillText call paints, from the context's alignment state. */
export function textBoxLeft(x: number, width: number, align: CanvasTextAlign, direction: CanvasDirection): number {
  if (align === 'center') return x - width / 2
  const alignsRight = align === 'right' || (align === 'end' && direction !== 'rtl') || (align === 'start' && direction === 'rtl')
  return alignsRight ? x - width : x
}

type TextDraw = (this: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth?: number) => void

function flipTextBack(original: TextDraw): TextDraw {
  return function (this: CanvasRenderingContext2D, text, x, y, maxWidth) {
    if (mirroredRenderDepth === 0 || groupFlipDepth > 0) return original.call(this, text, x, y, maxWidth)
    const value = String(text)
    let width = this.measureText(value).width
    if (maxWidth !== undefined && maxWidth < width) width = maxWidth
    const left = textBoxLeft(x, width, this.textAlign, this.direction)
    this.save()
    // Mirror around the centre of the text's own box: the box stays where
    // Univer put it, the glyphs come out mirrored on the canvas and therefore
    // readable once the container's CSS flip is applied.
    this.translate(2 * left + width, 0)
    this.scale(-1, 1)
    this.textAlign = 'left'
    this.direction = firstStrongDirection(value)
    if (maxWidth === undefined) original.call(this, value, left, y)
    else original.call(this, value, left, y, maxWidth)
    this.restore()
  }
}

let contextPatched = false
function patchCanvasText() {
  if (contextPatched) return
  contextPatched = true
  const proto = CanvasRenderingContext2D.prototype
  proto.fillText = flipTextBack(proto.fillText)
  proto.strokeText = flipTextBack(proto.strokeText)
}

interface GlyphLike { width: number; left: number; xOffset?: number; content?: string }
type DocumentsInternals = {
  _drawLiquid?: { x: number }
  _drawGlyphGroup: (ctx: CanvasRenderingContext2D, parentScale: unknown, group: GlyphLike[], line: unknown, alignOffset: { x: number }, centerAngle: number, vertexAngle: number, ...rest: unknown[]) => void
  _drawGlyphGroupBackgrounds: (ctx: CanvasRenderingContext2D, parentScale: unknown, group: GlyphLike[], lineHeight: number, alignOffset: { x: number }, centerAngle: number, vertexAngle: number, ...rest: unknown[]) => void
}

let documentsPatched = false
function patchDocumentGlyphGroups() {
  if (documentsPatched) return
  documentsPatched = true
  const proto = Documents.prototype as unknown as DocumentsInternals
  const wrap = <F extends DocumentsInternals['_drawGlyphGroup'] | DocumentsInternals['_drawGlyphGroupBackgrounds']>(original: F): F =>
    function (this: DocumentsInternals, ctx: CanvasRenderingContext2D, parentScale: unknown, group: GlyphLike[], lineArg: unknown, alignOffset: { x: number }, centerAngle: number, vertexAngle: number, ...rest: unknown[]) {
      const call = () => (original as (...a: unknown[]) => void).call(this, ctx, parentScale, group, lineArg, alignOffset, centerAngle, vertexAngle, ...rest)
      // Rotated text keeps Univer's own geometry (known gap, see report).
      if (mirroredRenderDepth === 0 || centerAngle !== 0 || vertexAngle !== 0 || !this._drawLiquid || group.length === 0) return call()
      let min = Infinity
      let max = -Infinity
      for (const g of group) {
        const start = g.left + (g.xOffset ?? 0)
        min = Math.min(min, start)
        max = Math.max(max, start + g.width)
      }
      const origin = this._drawLiquid.x + (alignOffset?.x ?? 0)
      ctx.save()
      ctx.translate(2 * origin + min + max, 0)
      ctx.scale(-1, 1)
      groupFlipDepth++
      try {
        call()
      } finally {
        groupFlipDepth--
        ctx.restore()
      }
    } as F
  proto._drawGlyphGroup = wrap(proto._drawGlyphGroup)
  proto._drawGlyphGroupBackgrounds = wrap(proto._drawGlyphGroupBackgrounds)
}

// Units whose grid is mirrored; the selection-command patch applies only to them.
const mirroredUnits = new Set<string>()

type Accessor = { get: <T>(id: unknown) => T }
type SelectionHandler = (accessor: Accessor, params?: { direction?: Direction }, options?: unknown) => unknown

let selectionCommandsPatched = false
/**
 * ArrowLeft/ArrowRight reach these commands as LEFT/RIGHT in model terms.
 * On a mirrored grid the user means the opposite column, so the handler gets
 * a swapped copy. The shortcut's own parameter object is shared between key
 * presses and must never be mutated.
 */
function patchSelectionCommands() {
  if (selectionCommandsPatched) return
  selectionCommandsPatched = true
  const swap: Partial<Record<Direction, Direction>> = { [Direction.LEFT]: Direction.RIGHT, [Direction.RIGHT]: Direction.LEFT }
  for (const command of [MoveSelectionCommand, ExpandSelectionCommand] as unknown as Array<{ handler: SelectionHandler }>) {
    const original = command.handler
    command.handler = (accessor, params, options) => {
      const focused = accessor.get<{ getFocusedUnit: () => { getUnitId: () => string } | null }>(IUniverInstanceService).getFocusedUnit()
      const flipped = params?.direction !== undefined ? swap[params.direction] : undefined
      if (!focused || !mirroredUnits.has(focused.getUnitId()) || flipped === undefined) return original(accessor, params, options)
      return original(accessor, { ...params, direction: flipped }, options)
    }
  }
}

interface Rect { left: number; right: number; top: number; bottom: number }

/** Mirror a client-coordinate rectangle across the vertical axis of `frame`. */
export function mirrorRect<T extends Rect>(rect: T, frame: Pick<DOMRect, 'left' | 'right'>): T {
  const axis = frame.left + frame.right
  return { ...rect, left: axis - rect.right, right: axis - rect.left }
}

const STYLE_ID = 'naf-rtl-grid-style'
function injectStyle() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = '.naf-rtl-grid{transform:scaleX(-1)}.naf-rtl-grid>.naf-rtl-unflip{transform:scaleX(-1)}'
  document.head.append(style)
}

type Injector = { get: <T>(id: unknown) => T }
type RenderUnitLike = {
  unitId: string
  scene: { render: (...a: unknown[]) => unknown }
  engine: { getCanvasElement: () => HTMLCanvasElement }
}
type RenderManagerLike = {
  getRenderUnitById: (id: string) => RenderUnitLike | null | undefined
  created$: Observable<RenderUnitLike>
}

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

/**
 * Mirror the grid of `unitId`. Call after `createWorkbook`: the render unit
 * and the canvas container appear asynchronously after the unit is created,
 * so this waits for both.
 */
export async function enableRtlGrid(univerAPI: FUniver, unitId: string): Promise<() => void> {
  const injector = (univerAPI as unknown as { _injector: Injector })._injector
  const manager = injector.get<RenderManagerLike>(IRenderManagerService)
  const renderUnit = manager.getRenderUnitById(unitId)
    ?? await firstValueFrom(manager.created$.pipe(filter((r) => r.unitId === unitId)))
  const { scene, engine } = renderUnit
  const canvas = engine.getCanvasElement()
  const frame = await waitFor(() => canvas.parentElement, 'the sheet canvas to be mounted')

  patchCanvasText()
  patchDocumentGlyphGroups()
  injectStyle()

  // 1 + 2. Flip the container; flip text back while this scene renders.
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

  // 4. Cell-anchored popups: mirror their anchor geometry.
  const popupService = injector.get<{ addPopup: (item: Record<string, unknown>) => string }>(ICanvasPopupService)
  const originalAddPopup = popupService.addPopup
  popupService.addPopup = function (item: Record<string, unknown>) {
    if (item.canvasElement !== canvas) return originalAddPopup.call(this, item)
    const flip = <T extends Rect>(r: T) => mirrorRect(r, canvas.getBoundingClientRect())
    const flipMany = (rs: Rect[] | null | undefined) => rs?.map(flip)
    const mirrored: Record<string, unknown> = { ...item }
    if (item.anchorRect$) mirrored.anchorRect$ = (item.anchorRect$ as Observable<Rect>).pipe(map(flip))
    if (item.anchorRect) mirrored.anchorRect = flip(item.anchorRect as Rect)
    if (item.excludeRects$) mirrored.excludeRects$ = (item.excludeRects$ as Observable<Rect[]>).pipe(map(flipMany))
    if (item.excludeRects) mirrored.excludeRects = flipMany(item.excludeRects as Rect[])
    if (item.hiddenRects$) mirrored.hiddenRects$ = (item.hiddenRects$ as Observable<Rect[]>).pipe(map(flipMany))
    return originalAddPopup.call(this, mirrored)
  }

  // 5a. Arrow keys move the selection the way the user sees the grid.
  mirroredUnits.add(unitId)
  patchSelectionCommands()

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

  return () => {
    frame.removeEventListener('wheel', onWheel, { capture: true })
    mirroredUnits.delete(unitId)
    popupService.addPopup = originalAddPopup
    observer.disconnect()
    frame.classList.remove('naf-rtl-grid')
    for (const child of Array.from(frame.children)) child.classList.remove('naf-rtl-unflip')
    scene.render = originalRender
  }
}
