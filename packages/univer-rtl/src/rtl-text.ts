// Right-to-left text for Univer's document surfaces (verified against Univer 1.4.0).
//
// The cell editor, the formula bar and rich-text cells are Univer documents.
// Univer 1.4.0's document layout has no bidi stage: every line is laid out
// left to right in logical order (the paragraph `direction` field is declared
// but never read), so «إعداد خطة الاتصال» shows as «الاتصال خطة إعداد». It
// also makes every Arabic word one glyph, so the caret cannot stop inside a
// word, Backspace deletes the whole word and the arrow keys skip it.
//
// This layer leaves the layout (and the model) logical and changes how the
// layout is shown and hit:
//
//   1. Words: after layout, every run of Arabic glyphs of an editor document
//      is re-cut into one glyph per grapheme, with in-context advances
//      measured from the font. Univer's own caret, deletion and selection
//      logic then works per character. The run is still painted as one
//      string, so its letters stay joined.
//   2. Order: per line, the Unicode bidi algorithm (bidi.ts) gives every glyph
//      its visual position. On the editor surfaces a line also moves to the
//      start side of the right-to-left surface (logical alignment, as in the
//      mirrored grid: start = visual right).
//   3. Paint: glyphs are drawn at their visual positions, right-to-left runs
//      with `direction = 'rtl'` (so brackets mirror, UAX #9 L4).
//   4. Caret and selection: computed from the visual positions; a selection
//      that is visually split is drawn as several rectangles.
//   5. Hit testing: a pointer x is mapped back to the logical x Univer expects.
//   6. Arrow keys move the caret visually; Home and End stay logical.
//
// Every hook is listed in `checkTextContract()`. A heartbeat withdraws the
// layer if right-to-left text is painted without passing through it.

import { Direction, UniverInstanceType } from '@univerjs/core'
import { Documents, DocumentSkeleton } from '@univerjs/engine-render'
import { NodePositionConvertToCursor } from '@univerjs/docs-ui'
import { lineLevels, paragraphDirection, resolveParagraph } from './bidi'
import type { ParagraphLevels } from './bidi'

// ---------------------------------------------------------------------------
// Pure helpers (no Univer, no DOM)
// ---------------------------------------------------------------------------

/** A glyph's visual box on its line: `left` in the divide's coordinates; `odd` = right-to-left level. */
export interface VisualBox { left: number; width: number; odd: boolean }

/**
 * Visual boxes of one line segment (rule L2, done geometrically): from the
 * highest level down to the lowest odd level, every maximal run at that level
 * or higher is mirrored within its own extent. Gaps between glyphs travel
 * with them. `shift` then moves the whole segment. Input and output are in
 * logical order.
 */
export function visualBoxes(lefts: readonly number[], widths: readonly number[], levels: readonly number[], shift = 0): VisualBox[] {
  const n = lefts.length
  const boxes: VisualBox[] = lefts.map((left, i) => ({ left, width: widths[i]!, odd: levels[i]! % 2 === 1 }))
  if (n > 0) {
    const order = boxes.map((_, i) => i)
    const max = Math.max(...levels)
    const min = Math.min(...levels)
    for (let level = max; level >= (min % 2 ? min : min + 1); level--) {
      for (let i = 0; i < n; i++) {
        if (levels[order[i]!]! < level) continue
        let end = i
        while (end < n && levels[order[end]!]! >= level) end++
        let lo = Infinity
        let hi = -Infinity
        for (let k = i; k < end; k++) {
          const b = boxes[order[k]!]!
          lo = Math.min(lo, b.left)
          hi = Math.max(hi, b.left + b.width)
        }
        for (let k = i; k < end; k++) {
          const b = boxes[order[k]!]!
          b.left = lo + hi - (b.left + b.width)
        }
        order.splice(i, end - i, ...order.slice(i, end).reverse())
        i = end
      }
    }
  }
  if (shift !== 0) for (const b of boxes) b.left += shift
  return boxes
}

/**
 * How far a line moves on a right-to-left surface: its extent [e0, e1] inside
 * [0, width] is mirrored, so text aligned to the logical start (left in the
 * layout) appears at the right, centred text stays, end-aligned text goes
 * left. A line wider than the surface, or a surface of unknown width, stays.
 */
export function surfaceShift(e0: number, e1: number, width: number): number {
  if (!Number.isFinite(width) || width <= 0 || width > 1e6 || e1 - e0 > width + 0.5) return 0
  return width - e1 - e0
}

/** Caret x at a glyph: before it in logical order (`isBack`) or after it. */
export function caretEdge(box: VisualBox, isBack: boolean): number {
  const start = box.odd ? box.left + box.width : box.left
  const end = box.odd ? box.left : box.left + box.width
  return isBack ? start : end
}

/** Visual spans [x0, x1] covered by the boxes `from..to` (inclusive), merged and sorted left to right. */
export function selectionSpans(boxes: readonly VisualBox[], from: number, to: number): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  for (let i = Math.max(0, from); i <= to && i < boxes.length; i++) {
    const b = boxes[i]!
    if (b.width > 0) spans.push([b.left, b.left + b.width])
  }
  spans.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const s of spans) {
    const last = merged[merged.length - 1]
    if (last && s[0] <= last[1] + 0.5) last[1] = Math.max(last[1], s[1])
    else merged.push([s[0], s[1]])
  }
  return merged
}

/**
 * Advances of the graphemes of a joined word. `prefixWidth(k)` is the width
 * of the first k graphemes as they look inside the word (the caller measures
 * them followed by ZWJ, which keeps the last letter's joining form); the
 * result is scaled to `total`, never negative, and a ligature's advance is
 * shared equally by its graphemes (see below).
 */
export function graphemeAdvances(count: number, prefixWidth: (k: number) => number, total: number): number[] {
  const full = prefixWidth(count)
  const scale = full > 0 ? total / full : 0
  const raw: number[] = []
  let previous = 0
  for (let k = 1; k <= count; k++) {
    const boundary = k === count ? total : Math.min(total, Math.max(previous, prefixWidth(k) * scale))
    raw.push(boundary - previous)
    previous = boundary
  }
  // A grapheme with (almost) no advance of its own is part of a ligature with
  // its neighbour (lam-alef; some fonts also join other pairs). Browsers share
  // a ligature's advance equally between its characters, so a caret can stop
  // inside it: do the same, so no two caret stops coincide.
  const clusters: Array<{ from: number; to: number; width: number }> = []
  for (let k = 0; k < raw.length; k++) {
    const last = clusters[clusters.length - 1]
    if (last && raw[k]! < MIN_ADVANCE) {
      last.to = k + 1
      last.width += raw[k]!
    } else clusters.push({ from: k, to: k + 1, width: raw[k]! })
  }
  // A leading zero-width grapheme joins the cluster after it.
  if (clusters.length > 1 && clusters[0]!.width < MIN_ADVANCE) {
    const [head, next] = clusters as [{ from: number; to: number; width: number }, { from: number; to: number; width: number }]
    next.from = head.from
    next.width += head.width
    clusters.shift()
  }
  const out = new Array<number>(raw.length)
  for (const c of clusters) for (let k = c.from; k < c.to; k++) out[k] = c.width / (c.to - c.from)
  return out
}
const MIN_ADVANCE = 0.75

/**
 * Paragraph direction for a document paragraph. An explicit paragraph style
 * wins; a formula (text starting with `=`) is always left-to-right; otherwise
 * the first strong character decides, as `dir="auto"` does, and a paragraph
 * without one follows the surface (right-to-left in NAF Sheets).
 */
export function documentParagraphDirection(text: string, explicit?: number | null, fallback: 'ltr' | 'rtl' = 'rtl'): 'ltr' | 'rtl' {
  if (explicit === 1) return 'ltr' // TextDirection.LEFT_TO_RIGHT
  if (explicit === 2) return 'rtl' // TextDirection.RIGHT_TO_LEFT
  // OPEN: formulas are shown left to right (as Google Sheets and Excel do);
  // a paragraph with no strong character follows the RTL surface. Both are
  // safe defaults, not owner decisions.
  if (/^\s*=/.test(text)) return 'ltr'
  return paragraphDirection(text) ?? fallback
}

/**
 * Univer's data stream marks structure (tables, custom ranges, blocks) with C0
 * control characters; the bidi algorithm would read some of them as
 * paragraph or segment separators. They become ZWSP (an invisible BN), one
 * code unit for one, so offsets are unchanged. Tab, CR and LF keep their meaning.
 */
export function bidiTextOfStream(stream: string): string {
  return stream.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '\u200B')
}

const ARABIC_WORD = /^[\u0600-\u06FF\u0750-\u077F\u0870-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]+$/

/** Graphemes of a string (Intl.Segmenter where available, else code points). */
export function graphemes(text: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment: (s: string) => Iterable<{ segment: string }> } }).Segmenter
  if (Segmenter) return Array.from(new Segmenter('ar', { granularity: 'grapheme' }).segment(text), (s) => s.segment)
  return Array.from(text)
}

// ---------------------------------------------------------------------------
// Contract: every Univer internal this layer relies on
// ---------------------------------------------------------------------------

type AnyFn = (...args: any[]) => unknown // eslint-disable-line @typescript-eslint/no-explicit-any
const isFn = (v: unknown): v is AnyFn => typeof v === 'function'

/** Static part of the text contract (module-level hooks). Empty means the layer can be applied. */
export function checkTextContract(): string[] {
  const problems: string[] = []
  const ske = DocumentSkeleton.prototype as unknown as Record<string, unknown>
  const docs = Documents.prototype as unknown as Record<string, unknown>
  const conv = (NodePositionConvertToCursor as unknown as { prototype?: Record<string, unknown> } | undefined)?.prototype ?? {}
  const need = (owner: Record<string, unknown>, name: string, label: string, minArgs = 0) => {
    const f = owner[name]
    if (!isFn(f) || f.length < minArgs) problems.push(label)
  }
  need(ske, 'calculate', 'DocumentSkeleton.prototype.calculate')
  need(ske, 'getSkeletonData', 'DocumentSkeleton.prototype.getSkeletonData')
  need(ske, '_collectNearestTextNode', 'DocumentSkeleton.prototype._collectNearestTextNode(page, segment, cache, x, y, nestLevel)', 6)
  need(ske, 'findNodePositionByCharIndex', 'DocumentSkeleton.prototype.findNodePositionByCharIndex(charIndex, ...)', 1)
  need(ske, 'findGlyphByPosition', 'DocumentSkeleton.prototype.findGlyphByPosition(position)', 1)
  need(ske, 'getViewModel', 'DocumentSkeleton.prototype.getViewModel')
  need(docs, 'draw', 'Documents.prototype.draw(ctx, bounds)', 2)
  need(docs, 'getSkeleton', 'Documents.prototype.getSkeleton')
  need(conv, 'getRangePointData', 'NodePositionConvertToCursor.prototype.getRangePointData(start, end)', 2)
  need(conv, '_selectionIterator', 'NodePositionConvertToCursor.prototype._selectionIterator(start, end, func)', 3)
  return problems
}

// ---------------------------------------------------------------------------
// Univer shapes this layer reads (only what it touches)
// ---------------------------------------------------------------------------

interface Glyph {
  content: string
  raw?: string
  count: number
  width: number
  left: number
  xOffset?: number
  glyphType?: number
  streamType?: string
  ts?: Record<string, unknown>
  fontStyle?: { fontString?: string; fontKerning?: CanvasFontKerning }
  bBox?: Record<string, unknown> & { width?: number }
  adjustability?: { stretchability: number[]; shrinkability: number[] }
  parent?: Divide
}
interface Divide { glyphGroup: Glyph[]; width: number; left: number; paddingLeft?: number; st: number; parent?: Line }
interface Line { divides: Divide[]; st: number; ed: number; top: number; lineHeight?: number; paragraphIndex?: number; type?: number; parent?: Column }
interface Column { lines: Line[]; left: number }
interface Section { columns: Column[]; top?: number }
interface Page { sections: Section[]; renderConfig?: { useTextInkForHitTesting?: number }; cellTextDirection?: string }
interface SkeletonData { pages: Page[] }
interface Skeleton {
  getSkeletonData(): SkeletonData | null | undefined
  getViewModel(): { getDataModel(): { getUnitId(): string; getBody(): { dataStream: string; paragraphs?: Array<{ startIndex: number; paragraphStyle?: { direction?: number } }> } | undefined } }
  findGlyphByPosition(p: NodePosition): Glyph | undefined
  findNodePositionByCharIndex(i: number, isBack?: boolean, ...rest: unknown[]): NodePosition | undefined
  _findLiquid: { x: number; y: number }
}
interface NodePosition { glyph: number; divide: number; line: number; column: number; section: number; page: number; isBack: boolean; [k: symbol]: unknown }

const EDITOR_PREFIX = '__INTERNAL_EDITOR__'
const GLYPH_LIST = 2 // GlyphType.LIST
const GLYPH_PLACEHOLDER = 3 // the section break glyph

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  /** Workbooks that enabled the layer. The patches are inert while this is 0 or after a withdrawal. */
  enabled: 0,
  withdrawn: null as string | null,
  /** Lines painted through the layer (the heartbeat and the tests read it). */
  paintedLines: 0,
  /** Consecutive document draws with right-to-left content that bypassed the paint hook. */
  bypassedDraws: 0,
  onWithdraw: new Set<(reason: string) => void>(),
}
const active = () => state.enabled > 0 && state.withdrawn === null

/** Diagnostics for tests and the status: is the layer live, and how much has it painted. */
export function textLayerState() {
  return { active: active(), withdrawn: state.withdrawn, paintedLines: state.paintedLines }
}

const FROM_OFFSET = Symbol('naf-rtl.fromOffset')

// A skeleton's document never changes unit, so the answer is cached per skeleton.
const editorSkeletons = new WeakMap<object, boolean>()
const isEditor = (skeleton: unknown): boolean => {
  if (!skeleton || typeof skeleton !== 'object') return false
  let editor = editorSkeletons.get(skeleton)
  if (editor === undefined) {
    try {
      editor = (skeleton as Skeleton).getViewModel().getDataModel().getUnitId().startsWith(EDITOR_PREFIX)
    } catch {
      return false
    }
    editorSkeletons.set(skeleton, editor)
  }
  return editor
}

// ---------------------------------------------------------------------------
// 1. Words: Arabic runs of editor documents become one glyph per grapheme
// ---------------------------------------------------------------------------
//
// Univer makes a whole Arabic word one glyph, but after punctuation with no
// space («(مسودة)») it makes every letter its own glyph, measured and painted
// isolated, so the letters do not join (a stock bug). Either way, in an editor
// document every run of adjacent Arabic glyphs with the same font and colour
// is re-cut into graphemes with the advances they have inside the joined word;
// the glyphs after the run move by the width difference. Other documents
// (rich-text cells) are not re-cut: their runs are only painted joined (3).

interface Word { text: string; glyphs: Glyph[] }
const wordOf = new WeakMap<Glyph, Word>()
const shapedDivides = new WeakSet<Divide>()
let measureContext: CanvasRenderingContext2D | null = null
const advanceCache = new Map<string, number[]>()

function measuringContext(font: string, kerning: CanvasFontKerning | undefined): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null
  measureContext ??= document.createElement('canvas').getContext('2d')
  const ctx = measureContext
  if (!ctx) return null
  ctx.font = font
  if ('fontKerning' in ctx) ctx.fontKerning = kerning ?? 'auto'
  return ctx
}

/** In-context advances of the graphemes of a joined Arabic string, or null where nothing can be measured. */
function joinedAdvances(text: string, parts: string[], glyph: Glyph): number[] | null {
  const font = glyph.fontStyle?.fontString
  if (!font) return null
  const key = `${font}\u0000${text}`
  const cached = advanceCache.get(key)
  if (cached) return cached
  const ctx = measuringContext(font, glyph.fontStyle?.fontKerning)
  if (!ctx) return null
  const total = ctx.measureText(text).width
  const prefix = (k: number) => (k >= parts.length ? total : ctx.measureText(parts.slice(0, k).join('') + '\u200d').width)
  const advances = graphemeAdvances(parts.length, prefix, total)
  if (advanceCache.size > 4000) advanceCache.clear()
  advanceCache.set(key, advances)
  return advances
}

const colourOf = (g: Glyph) => JSON.stringify((g.ts as { cl?: unknown } | undefined)?.cl ?? null)
const joinable = (g: Glyph) =>
  g.glyphType === 0 && !g.streamType && typeof g.content === 'string' && g.content.length > 0 && g.count === g.content.length &&
  (g.raw === undefined || g.raw === g.content) && (g.xOffset ?? 0) === 0 && g.width > 0 &&
  !(g.ts && ('textAdvance' in g.ts || 'sc' in g.ts)) && ARABIC_WORD.test(g.content)
const sameRun = (a: Glyph, b: Glyph) => a.fontStyle?.fontString === b.fontStyle?.fontString && colourOf(a) === colourOf(b)

/** Maximal runs [from, to) of adjacent joinable Arabic glyphs that share font and colour. */
function arabicRuns(group: readonly Glyph[]): Array<[number, number]> {
  const runs: Array<[number, number]> = []
  for (let i = 0; i < group.length; i++) {
    if (!joinable(group[i]!)) continue
    let j = i + 1
    while (j < group.length && joinable(group[j]!) && sameRun(group[i]!, group[j]!)) j++
    runs.push([i, j])
    i = j - 1
  }
  return runs
}

function shapeArabicRuns(skeleton: Skeleton, data: SkeletonData | null | undefined) {
  if (!active() || !data || !isEditor(skeleton)) return
  for (const page of data.pages ?? []) for (const section of page.sections ?? []) for (const column of section.columns ?? []) for (const line of column.lines ?? []) {
    for (const divide of line.divides ?? []) {
      if (shapedDivides.has(divide)) continue
      shapedDivides.add(divide)
      const group = divide.glyphGroup
      const runs = arabicRuns(group)
      // Right to left, so earlier indices stay valid while runs are replaced.
      for (let r = runs.length - 1; r >= 0; r--) {
        const [from, to] = runs[r]!
        const old = group.slice(from, to)
        if (old.every((g) => wordOf.has(g))) continue
        const text = old.map((g) => g.content).join('')
        const parts = graphemes(text)
        if (parts.length < 2) continue
        const advances = joinedAdvances(text, parts, old[0]!)
        if (!advances) continue
        // The glyph each grapheme came from (its style and metrics are kept).
        const owners: Glyph[] = []
        for (const g of old) for (let k = 0; k < g.content.length; k++) owners.push(g)
        const word: Word = { text, glyphs: [] }
        let left = old[0]!.left
        let unit = 0
        for (let k = 0; k < parts.length; k++) {
          const part = parts[k]!
          const owner = owners[unit]!
          const width = advances[k]!
          const piece: Glyph = {
            ...owner,
            content: part,
            raw: part,
            count: part.length,
            width,
            left,
            bBox: owner.bBox ? { ...owner.bBox, width } : owner.bBox,
            adjustability: owner.adjustability ? { stretchability: [...owner.adjustability.stretchability], shrinkability: [...owner.adjustability.shrinkability] } : owner.adjustability,
          }
          unit += part.length
          left += width
          word.glyphs.push(piece)
          wordOf.set(piece, word)
        }
        const delta = left - (old[old.length - 1]!.left + old[old.length - 1]!.width)
        for (let k = to; k < group.length; k++) group[k]!.left += delta
        group.splice(from, to - from, ...word.glyphs)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Order: visual geometry of a line segment
// ---------------------------------------------------------------------------

interface Geometry {
  boxes: VisualBox[]
  /** Offsets of every glyph (logical order). */
  starts: number[]
  paragraphRtl: boolean
  /** False when the layout already is the visual result (nothing to change). */
  needed: boolean
}
const geometryCache = new WeakMap<Divide, { length: number; last: Glyph | undefined; width: number; stream: string; geometry: Geometry | null }>()
const paragraphCache = new Map<string, ParagraphLevels>()
const RTL_OR_CONTROL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u200F\u202A-\u202E\u2066-\u2069]|[\uD802-\uD803\uD83A-\uD83B]/

function paragraphLevels(text: string, direction: 'ltr' | 'rtl'): ParagraphLevels {
  const key = direction + text
  let p = paragraphCache.get(key)
  if (!p) {
    p = resolveParagraph(text, direction)
    if (paragraphCache.size > 500) paragraphCache.clear()
    paragraphCache.set(key, p)
  }
  return p
}

function geometryOf(skeleton: unknown, divide: Divide): Geometry | null {
  if (!skeleton || !divide?.glyphGroup) return null
  let body: ReturnType<ReturnType<Skeleton['getViewModel']>['getDataModel']>['getBody'] extends () => infer T ? T : never
  try {
    body = (skeleton as Skeleton).getViewModel().getDataModel().getBody()
  } catch {
    return null
  }
  const stream = body?.dataStream
  if (typeof stream !== 'string') return null
  const group = divide.glyphGroup
  const cached = geometryCache.get(divide)
  if (cached && cached.length === group.length && cached.last === group[group.length - 1] && cached.width === divide.width && cached.stream === stream) return cached.geometry
  const geometry = computeGeometry(skeleton as Skeleton, divide, stream, body?.paragraphs ?? [])
  geometryCache.set(divide, { length: group.length, last: group[group.length - 1], width: divide.width, stream, geometry })
  return geometry
}

function computeGeometry(skeleton: Skeleton, divide: Divide, stream: string, paragraphs: Array<{ startIndex: number; paragraphStyle?: { direction?: number } }>): Geometry | null {
  const line = divide.parent
  const group = divide.glyphGroup
  if (!line || group.length === 0) return null
  const editor = isEditor(skeleton)
  // The paragraph this line belongs to: [start, end], `end` being its '\r'.
  const end = line.paragraphIndex ?? -1
  if (end < 0 || end >= stream.length || stream[end] !== '\r') return null
  let start = 0
  let explicit: number | undefined
  for (const p of paragraphs) {
    if (p.startIndex < end) start = Math.max(start, p.startIndex + 1)
    if (p.startIndex === end) explicit = p.paragraphStyle?.direction
  }
  const text = bidiTextOfStream(stream.slice(start, end + 1))
  if (!editor && !RTL_OR_CONTROL.test(text)) return null
  const direction = documentParagraphDirection(text, explicit, 'rtl')
  const p = paragraphLevels(text, direction)
  const from = Math.max(line.st, start) - start
  const to = Math.min(line.ed, end) - start + 1
  const levels = lineLevels(p, from, Math.max(from, to))
  const starts: number[] = []
  const glyphLevels: number[] = []
  let offset = divide.st
  for (const g of group) {
    starts.push(offset)
    const k = offset - start - from
    glyphLevels.push(k >= 0 && k < levels.length ? levels[k]! : p.paragraphLevel)
    offset += g.count
  }
  const lefts = group.map((g) => g.left)
  const widths = group.map((g) => g.width)
  let shift = 0
  if (editor && line.divides.length === 1) {
    let e0 = Infinity
    let e1 = -Infinity
    for (let i = 0; i < group.length; i++) {
      e0 = Math.min(e0, lefts[i]!)
      e1 = Math.max(e1, lefts[i]! + widths[i]!)
    }
    // OPEN: every paragraph of an editor surface sits on the start side (the
    // right), a left-to-right one included, so the editor matches the mirrored
    // cell it edits (which shows Latin text on the right too). Word order still
    // follows each paragraph's own direction.
    shift = surfaceShift(e0, e1, divide.width)
  }
  const boxes = visualBoxes(lefts, widths, glyphLevels, shift)
  const needed = shift !== 0 || glyphLevels.some((l) => l % 2 === 1)
  return { boxes, starts, paragraphRtl: p.paragraphLevel === 1, needed }
}

// ---------------------------------------------------------------------------
// 3. Paint
// ---------------------------------------------------------------------------

type GroupDraw = (this: unknown, ctx: CanvasRenderingContext2D, parentScale: unknown, group: Glyph[], lineOrHeight: unknown, alignOffset: unknown, centerAngle: number, vertexAngle: number, ...rest: unknown[]) => void
let paintedByHook = 0

function wrapGroupDraw(original: GroupDraw, background: boolean): GroupDraw {
  return function (this: unknown, ctx, parentScale, group, lineOrHeight, alignOffset, centerAngle, vertexAngle, ...rest) {
    const call = (g: Glyph[]) => original.call(this, ctx, parentScale, g, lineOrHeight, alignOffset, centerAngle, vertexAngle, ...rest)
    if (!active() || !Array.isArray(group) || group.length === 0) return call(group)
    const divide = group[0]!.parent
    if (!divide || divide.glyphGroup !== group) return call(group)
    const skeleton = (this as { getSkeleton?: () => unknown }).getSkeleton?.()
    const geometry = geometryOf(skeleton, divide)
    if (!geometry?.needed) return call(group)
    paintedByHook++
    if (!background) state.paintedLines++
    const saved = group.map((g) => [g.left, g.width, g.content] as const)
    const direction = ctx.direction
    const textAlign = ctx.textAlign
    try {
      group.forEach((g, i) => (g.left = geometry.boxes[i]!.left))
      if (background) return call(group)
      // An Arabic run is painted once, as one string, so its letters join.
      // Re-cut runs (editors) fill their boxes exactly; other runs of
      // single-letter glyphs (rich-text cells) are measured joined and set at
      // the run's start side.
      const runs: Array<{ glyphs: Glyph[]; text: string; fit: boolean }> = []
      const covered = new Set<Glyph>()
      for (const g of group) {
        const word = wordOf.get(g)
        if (!word || covered.has(g) || !word.glyphs.every((w) => w.parent === divide)) continue
        for (const w of word.glyphs) covered.add(w)
        runs.push({ glyphs: word.glyphs, text: word.text, fit: false })
      }
      for (const [from, to] of arabicRuns(group)) {
        const glyphs = group.slice(from, to)
        if (to - from > 1 && !glyphs.some((g) => covered.has(g))) runs.push({ glyphs, text: glyphs.map((g) => g.content).join(''), fit: true })
      }
      for (const run of runs) {
        const head = run.glyphs[0]!
        let lo = Infinity
        let hi = -Infinity
        for (const w of run.glyphs) {
          lo = Math.min(lo, w.left)
          hi = Math.max(hi, w.left + w.width)
        }
        let width = hi - lo
        let left = lo
        if (run.fit) {
          const ctx2 = measuringContext(head.fontStyle?.fontString ?? '', head.fontStyle?.fontKerning)
          const natural = ctx2 && head.fontStyle?.fontString ? ctx2.measureText(run.text).width : width
          if (natural > 0 && natural < width) {
            width = natural
            if (geometry.boxes[group.indexOf(head)]!.odd) left = hi - natural
          }
        }
        for (const w of run.glyphs) w.content = ''
        head.content = run.text
        head.left = left
        head.width = width
      }
      // Right-to-left runs are drawn with direction 'rtl' (brackets mirror); others 'ltr'.
      let i = 0
      while (i < group.length) {
        const odd = geometry.boxes[i]!.odd
        let j = i
        while (j < group.length && geometry.boxes[j]!.odd === odd) j++
        ctx.direction = odd ? 'rtl' : 'ltr'
        ctx.textAlign = 'left'
        call(group.slice(i, j))
        i = j
      }
    } finally {
      group.forEach((g, i) => {
        const [left, width, content] = saved[i]!
        g.left = left
        g.width = width
        g.content = content
      })
      ctx.direction = direction
      ctx.textAlign = textAlign
    }
  }
}

/** True when some line of the document needs the layer (it has right-to-left text or sits on an RTL surface). */
function documentNeedsLayer(skeleton: unknown): boolean {
  const data = (skeleton as Skeleton | null)?.getSkeletonData?.()
  for (const page of data?.pages ?? []) for (const section of page.sections) for (const column of section.columns) for (const line of column.lines) {
    for (const divide of line.divides) if (divide.glyphGroup.some((g) => g.content && g.content.trim()) && geometryOf(skeleton, divide)?.needed) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// 4. Caret and selection
// ---------------------------------------------------------------------------

/** The caret spot an arrow move chose for an offset (bidi offsets can have two spots). */
let preferredCaret: { skeleton: unknown; offset: number; glyph: Glyph; isBack: boolean } | null = null

/**
 * The visual x (in the divide's coordinates) of a collapsed caret at `position`.
 * Positions Univer derived from an offset have no side of their own: the caret
 * then sits after the previous character on the line (where typed text
 * appears), unless an arrow move asked for the other spot.
 */
function caretX(skeleton: unknown, divide: Divide, geometry: Geometry, index: number, isBack: boolean, fromOffset: boolean): number {
  const group = divide.glyphGroup
  if (fromOffset) {
    const offset = isBack ? geometry.starts[index]! : geometry.starts[index]! + group[index]!.count
    const pref = preferredCaret
    if (pref && pref.skeleton === skeleton && pref.offset === offset) {
      const k = group.indexOf(pref.glyph)
      if (k >= 0) return caretEdge(geometry.boxes[k]!, pref.isBack)
    }
    // OPEN: at a boundary between runs of different direction an offset has
    // two possible spots; the caret takes the one after the previous character
    // (where the next typed character appears). Browsers vary here.
    if (isBack && index > 0) return caretEdge(geometry.boxes[index - 1]!, false)
  }
  return caretEdge(geometry.boxes[index]!, isBack)
}

interface Segment { startSp: number; endSp: number; isFirst: boolean; isLast: boolean; divide: Divide; x: number; clipped: boolean }
interface Recorder { segments: Segment[]; start: NodePosition | null; end: NodePosition | null }
let recorder: Recorder | null = null
type Point = { x: number; y: number }

const withX = (points: Point[], x0: number, x1: number): Point[] => {
  const [p0, , p2] = points
  if (!p0 || !p2) return points
  return [{ x: x0, y: p0.y }, { x: x1, y: p0.y }, { x: x1, y: p2.y }, { x: x0, y: p2.y }, { x: x0, y: p0.y }]
}

function remapRangePoints(skeleton: unknown, result: { borderBoxPointGroup: Point[][]; contentBoxPointGroup: Point[][]; cursorList: unknown[] }, rec: Recorder) {
  const segments = rec.segments.filter((s) => s.divide.glyphGroup.length > 0)
  const { borderBoxPointGroup: border, contentBoxPointGroup: content } = result
  if (!rec.start || !rec.end || segments.some((s) => s.clipped) || border.length !== segments.length || content.length !== segments.length) return result
  const collapsed = rec.start === rec.end
  const outBorder: Point[][] = []
  const outContent: Point[][] = []
  segments.forEach((seg, k) => {
    const geometry = geometryOf(skeleton, seg.divide)
    if (!geometry?.needed) {
      outBorder.push(border[k]!)
      outContent.push(content[k]!)
      return
    }
    const group = seg.divide.glyphGroup
    let spans: Array<[number, number]>
    if (collapsed) {
      const x = caretX(skeleton, seg.divide, geometry, Math.min(seg.startSp, group.length - 1), rec.start!.isBack, Boolean(rec.start![FROM_OFFSET]))
      spans = [[x, x]]
    } else {
      const isStartBack = rec.start!.glyph === seg.startSp && seg.isFirst ? rec.start!.isBack : true
      const isEndBack = rec.end!.glyph === seg.endSp && seg.isLast ? rec.end!.isBack : false
      let from = isStartBack ? seg.startSp : seg.startSp + 1
      if (group[from]?.glyphType === GLYPH_LIST) from++
      const to = isEndBack ? seg.endSp - 1 : seg.endSp
      spans = selectionSpans(geometry.boxes, from, to)
      if (spans.length === 0) {
        const x = caretEdge(geometry.boxes[Math.min(seg.startSp, group.length - 1)]!, isStartBack)
        spans = [[x, x]]
      }
    }
    for (const [x0, x1] of spans) {
      outBorder.push(withX(border[k]!, seg.x + x0, seg.x + x1))
      outContent.push(withX(content[k]!, seg.x + x0, seg.x + x1))
    }
  })
  return { ...result, borderBoxPointGroup: outBorder, contentBoxPointGroup: outContent }
}

// ---------------------------------------------------------------------------
// 5. Hit testing
// ---------------------------------------------------------------------------

/** The logical x Univer's hit test expects for a pointer at visual `x`, or null to leave it. */
function logicalHitX(skeleton: Skeleton, page: Page, x: number, y: number): number | null {
  const { x: originX, y: originY } = skeleton._findLiquid
  let best: { line: Line; column: Column } | null = null
  let bestDistance = Infinity
  for (const section of page.sections) for (const column of section.columns) for (const line of column.lines) {
    if (line.type === 1) continue
    const top = originY + (section.top ?? 0) + line.top
    const bottom = top + (line.lineHeight ?? 0)
    const distance = y >= top && y <= bottom ? -1 : Math.abs(y - bottom)
    if (distance < bestDistance) {
      bestDistance = distance
      best = { line, column }
    }
  }
  if (!best || best.line.divides.length !== 1) return null
  const divide = best.line.divides[0]!
  const geometry = geometryOf(skeleton, divide)
  if (!geometry?.needed) return null
  const divideLeft = originX + best.column.left + divide.left + (divide.paddingLeft ?? 0)
  const rel = x - divideLeft
  let target = -1
  let targetDistance = Infinity
  divide.glyphGroup.forEach((g, i) => {
    const b = geometry.boxes[i]!
    if (b.width <= 0 || g.glyphType === GLYPH_PLACEHOLDER) return
    const d = rel < b.left ? b.left - rel : rel > b.left + b.width ? rel - b.left - b.width : 0
    if (d < targetDistance) {
      targetDistance = d
      target = i
    }
  })
  if (target < 0) return null
  const box = geometry.boxes[target]!
  const glyph = divide.glyphGroup[target]!
  const f = Math.min(0.999, Math.max(0.001, (rel - box.left) / box.width))
  return divideLeft + glyph.left + (box.odd ? 1 - f : f) * glyph.width
}

// ---------------------------------------------------------------------------
// 6. Arrow keys
// ---------------------------------------------------------------------------

interface TextRangeLike { startOffset: number; endOffset: number; collapsed: boolean; direction?: string; style?: unknown; segmentId?: string; startNodePosition?: NodePosition | null; endNodePosition?: NodePosition | null }
interface MoveController {
  _handleMoveCursor: (direction: Direction, granularity?: string) => unknown
  _handleShiftMoveSelection: (direction: Direction, granularity?: string) => unknown
  _scrollToFocusNodePosition?: (unitId: string, offset: number) => void
  _textSelectionManagerService: { getActiveTextRange(): TextRangeLike | null | undefined; getTextRanges(): TextRangeLike[] | null | undefined; replaceDocRanges(ranges: unknown[], params?: unknown, isEditing?: boolean): void }
  _univerInstanceService: { getCurrentUnitOfType(type: UniverInstanceType): { getUnitId(): string } | null | undefined }
  _renderManagerService: { getRenderUnitById(id: string): { mainComponent?: { getSkeleton?: () => unknown } } | null | undefined }
  __nafRtlText?: boolean
}

/** Where a caret at `position` is drawn: its divide, geometry and visual x. */
function spotOf(skeleton: Skeleton, position: NodePosition | null | undefined) {
  if (!position) return null
  const glyph = skeleton.findGlyphByPosition(position)
  const divide = glyph?.parent
  if (!glyph || !divide) return null
  const geometry = geometryOf(skeleton, divide)
  if (!geometry) return null
  const index = divide.glyphGroup.indexOf(glyph)
  return { divide, geometry, index, x: geometry.needed ? caretX(skeleton, divide, geometry, index, position.isBack, Boolean(position[FROM_OFFSET])) : NaN }
}

/** The visually next caret position on the same line, or null at the visual end of the line. */
function visualNeighbour(skeleton: Skeleton, divide: Divide, geometry: Geometry, fromX: number, fromOffset: number, left: boolean, maxOffset: number) {
  let best: { offset: number; glyph: Glyph; isBack: boolean; x: number } | null = null
  divide.glyphGroup.forEach((g, i) => {
    if (g.glyphType === GLYPH_PLACEHOLDER) return
    const box = geometry.boxes[i]!
    const candidates: Array<[number, boolean]> = [[geometry.starts[i]!, true]]
    if (g.streamType !== '\r') candidates.push([geometry.starts[i]! + g.count, false])
    for (const [offset, isBack] of candidates) {
      if (offset > maxOffset) continue
      const x = caretEdge(box, isBack)
      if (left ? x >= fromX - 0.5 : x <= fromX + 0.5) continue
      const better = !best || (left ? x > best.x + 0.5 : x < best.x - 0.5) || (Math.abs(x - best.x) <= 0.5 && Math.abs(offset - fromOffset) < Math.abs(best.offset - fromOffset))
      if (better) best = { offset, glyph: g, isBack, x }
    }
  })
  return best as { offset: number; glyph: Glyph; isBack: boolean; x: number } | null
}

const PASS = Symbol('pass')

function visualMove(ctl: MoveController, direction: Direction, granularity: string, extend: boolean): unknown {
  if (!active() || (direction !== Direction.LEFT && direction !== Direction.RIGHT)) return PASS
  const selection = ctl._textSelectionManagerService
  const range = selection.getActiveTextRange()
  const all = selection.getTextRanges()
  const doc = ctl._univerInstanceService.getCurrentUnitOfType(UniverInstanceType.UNIVER_DOC)
  if (!range || !all || all.length !== 1 || !doc || range.segmentId) return PASS
  const skeleton = ctl._renderManagerService.getRenderUnitById(doc.getUnitId())?.mainComponent?.getSkeleton?.() as Skeleton | undefined
  if (!skeleton || !isEditor(skeleton)) return PASS
  const forwardFocus = range.direction !== 'backward'
  const anchor = range.collapsed ? range.startOffset : forwardFocus ? range.startOffset : range.endOffset
  const focus = range.collapsed ? range.endOffset : forwardFocus ? range.endOffset : range.startOffset
  const focusPosition = range.collapsed ? range.startNodePosition : forwardFocus ? range.endNodePosition : range.startNodePosition
  const spot = spotOf(skeleton, focusPosition ?? skeleton.findNodePositionByCharIndex(focus, true))
  if (!spot || !spot.geometry.needed) return PASS
  const left = direction === Direction.LEFT
  const logicalDirection = left === spot.geometry.paragraphRtl ? Direction.RIGHT : Direction.LEFT
  // Word steps stay logical, in the reading direction of the paragraph.
  // OPEN: Ctrl+Arrow (word) and Up/Down stay Univer's logical moves (Up/Down
  // match lines by logical x); only character steps are visual.
  if (granularity === 'word') return { swap: logicalDirection }
  if (granularity !== 'character') return PASS
  const stream = skeleton.getViewModel().getDataModel().getBody()?.dataStream ?? ''
  const maxOffset = Math.max(0, stream.length - 2)
  const apply = (offset: number, glyph: Glyph | null, isBack: boolean) => {
    preferredCaret = glyph ? { skeleton, offset, glyph, isBack } : null
    selection.replaceDocRanges([{ startOffset: extend ? anchor : offset, endOffset: offset, style: range.style }], undefined, false)
    ctl._scrollToFocusNodePosition?.(doc.getUnitId(), offset)
    return undefined
  }
  // A selection collapses to its visual end in the direction of the key.
  if (!extend && !range.collapsed) {
    const a = spotOf(skeleton, skeleton.findNodePositionByCharIndex(range.startOffset, true))
    const b = spotOf(skeleton, skeleton.findNodePositionByCharIndex(range.endOffset, true))
    if (!a || !b || a.divide.parent !== b.divide.parent || !Number.isFinite(a.x) || !Number.isFinite(b.x)) {
      return apply(logicalDirection === Direction.RIGHT ? range.endOffset : range.startOffset, null, true)
    }
    return apply((left ? a.x <= b.x : a.x >= b.x) ? range.startOffset : range.endOffset, null, true)
  }
  const next = visualNeighbour(skeleton, spot.divide, spot.geometry, spot.x, focus, left, maxOffset)
  if (next) return apply(next.offset, next.glyph, next.isBack)
  // At the visual end of the line: continue on the adjacent line in reading order, if any.
  const line = spot.divide.parent
  const lines = line?.parent?.lines ?? []
  const index = line ? lines.indexOf(line) : -1
  const forward = logicalDirection === Direction.RIGHT
  const neighbour = lines[index + (forward ? 1 : -1)]
  if (index < 0 || !neighbour) return undefined
  return apply(Math.min(maxOffset, forward ? neighbour.st : Math.max(neighbour.st, neighbour.ed - 1)), null, true)
}

/**
 * Docs-UI's cursor controller (not exported; found by its shape among the
 * instances of Univer's root injector). It exists once Univer has rendered:
 * `pending` means it may still appear; any other string is a contract problem.
 */
function findMoveController(injector: unknown): MoveController | string {
  const resolved = (injector as { resolvedDependencyCollection?: { resolvedDependencies?: unknown } } | undefined)?.resolvedDependencyCollection?.resolvedDependencies
  if (!(resolved instanceof Map)) return 'Injector.resolvedDependencyCollection.resolvedDependencies (redi)'
  const found: MoveController[] = []
  for (const items of resolved.values()) {
    for (const item of Array.isArray(items) ? items : []) {
      const c = item as Partial<MoveController> | null
      if (c && isFn(c._handleMoveCursor) && isFn(c._handleShiftMoveSelection) && isFn(c._textSelectionManagerService?.replaceDocRanges) && isFn(c._textSelectionManagerService?.getActiveTextRange) &&
        isFn(c._univerInstanceService?.getCurrentUnitOfType) && isFn(c._renderManagerService?.getRenderUnitById)) found.push(c as MoveController)
    }
  }
  if (found.length === 0) return PENDING
  if (found.length !== 1) return `DocMoveCursorController._handleMoveCursor/_handleShiftMoveSelection (found ${found.length} instances, expected 1)`
  return found[0]!
}
const PENDING = 'pending'
const CONTROLLER_TIMEOUT_MS = 10000

function patchMoveController(ctl: MoveController) {
  if (ctl.__nafRtlText) return
  ctl.__nafRtlText = true
  const move = ctl._handleMoveCursor
  const shift = ctl._handleShiftMoveSelection
  const wrap = (original: MoveController['_handleMoveCursor'], extend: boolean) =>
    function (this: MoveController, direction: Direction, granularity = 'character') {
      let outcome: unknown = PASS
      try {
        outcome = visualMove(this, direction, granularity, extend)
      } catch (e) {
        console.error('[rtl-text] arrow move failed; using Univer\'s', e)
      }
      if (outcome === PASS) return original.call(this, direction, granularity)
      if (outcome && typeof outcome === 'object' && 'swap' in outcome) return original.call(this, (outcome as { swap: Direction }).swap, granularity)
      return outcome
    }
  ctl._handleMoveCursor = wrap(move, false)
  ctl._handleShiftMoveSelection = wrap(shift, true)
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

let installed = false
function install() {
  if (installed) return
  installed = true

  const ske = DocumentSkeleton.prototype as unknown as Record<string, AnyFn>
  const calculate = ske.calculate!
  ske.calculate = function (this: Skeleton, ...args: unknown[]) {
    const result = calculate.apply(this, args)
    try {
      shapeArabicRuns(this, (this as unknown as { _skeletonData?: SkeletonData })._skeletonData)
    } catch (e) {
      console.error('[rtl-text] word split failed', e)
    }
    return result
  }
  const getSkeletonData = ske.getSkeletonData!
  ske.getSkeletonData = function (this: Skeleton, ...args: unknown[]) {
    const data = getSkeletonData.apply(this, args) as SkeletonData | null | undefined
    try {
      shapeArabicRuns(this, data)
    } catch (e) {
      console.error('[rtl-text] word split failed', e)
    }
    return data
  }
  const findNodePosition = ske.findNodePositionByCharIndex!
  ske.findNodePositionByCharIndex = function (this: Skeleton, ...args: unknown[]) {
    const position = findNodePosition.apply(this, args) as NodePosition | undefined
    // Tag positions derived from an offset: they carry no caret side of their own (see caretX).
    if (position && active() && typeof position === 'object') return { ...position, [FROM_OFFSET]: true }
    return position
  }
  const collect = ske._collectNearestTextNode!
  ske._collectNearestTextNode = function (this: Skeleton, page: Page, segment: unknown, cache: unknown, x: number, y: number, nestLevel: number) {
    let mapped: number | null = null
    if (active() && isEditor(this) && page?.renderConfig?.useTextInkForHitTesting !== 1 && !page?.cellTextDirection) {
      try {
        mapped = logicalHitX(this, page, x, y)
      } catch (e) {
        console.error('[rtl-text] hit test mapping failed', e)
      }
      if (mapped !== null) hitsMapped++
    }
    return collect.call(this, page, segment, cache, mapped ?? x, y, nestLevel)
  }

  const docs = Documents.prototype as unknown as Record<string, AnyFn>
  docs._drawGlyphGroup = wrapGroupDraw(docs._drawGlyphGroup as unknown as GroupDraw, false) as unknown as AnyFn
  docs._drawGlyphGroupBackgrounds = wrapGroupDraw(docs._drawGlyphGroupBackgrounds as unknown as GroupDraw, true) as unknown as AnyFn
  const draw = docs.draw!
  docs.draw = function (this: { getSkeleton?: () => unknown; makeDirty?: (b: boolean) => void }, ctx: unknown, bounds: unknown) {
    if (!active()) return draw.call(this, ctx, bounds)
    // Only the glyph painter counts: backgrounds go through a separate hook.
    const before = state.paintedLines
    const result = draw.call(this, ctx, bounds)
    // Heartbeat: a document with right-to-left text that is drawn without
    // passing through the paint hook means Univer paints another way now.
    // Withdraw instead of leaving visual carets over logical text.
    try {
      const skeleton = this.getSkeleton?.()
      if (state.paintedLines === before && isEditor(skeleton) && documentNeedsLayer(skeleton)) {
        if (++state.bypassedDraws >= 3) {
          withdraw('heartbeat failed: right-to-left document text was painted without passing through Documents._drawGlyphGroup')
          this.makeDirty?.(true) // repaint stock
        }
      } else if (state.paintedLines !== before) state.bypassedDraws = 0
    } catch (e) {
      console.error('[rtl-text] heartbeat check failed', e)
    }
    return result
  }

  const conv = (NodePositionConvertToCursor as unknown as { prototype: Record<string, AnyFn> }).prototype
  const iterate = conv._selectionIterator!
  conv._selectionIterator = function (this: { _liquid: { x: number }; _horizontalClip: unknown; _verticalCellOrigin: unknown }, start: NodePosition, end: NodePosition, func?: AnyFn) {
    const rec = recorder
    if (!rec || !func) return iterate.call(this, start, end, func)
    rec.start = start
    rec.end = end
    return iterate.call(this, start, end, (startSp: number, endSp: number, isFirst: boolean, isLast: boolean, divide: Divide, ...rest: unknown[]) => {
      rec.segments.push({ startSp, endSp, isFirst, isLast, divide, x: this._liquid.x, clipped: this._horizontalClip != null || this._verticalCellOrigin != null })
      return func(startSp, endSp, isFirst, isLast, divide, ...rest)
    })
  }
  const rangePoints = conv.getRangePointData!
  conv.getRangePointData = function (this: { _docSkeleton: unknown }, start: NodePosition | null, end: NodePosition | null) {
    if (!active() || start == null || end == null || !isEditor(this._docSkeleton)) return rangePoints.call(this, start, end)
    const rec: Recorder = { segments: [], start: null, end: null }
    const previous = recorder
    recorder = rec
    let result: ReturnType<typeof remapRangePoints>
    try {
      result = rangePoints.call(this, start, end) as typeof result
    } finally {
      recorder = previous
    }
    try {
      return remapRangePoints(this._docSkeleton, result, rec)
    } catch (e) {
      console.error('[rtl-text] caret geometry failed; using Univer\'s', e)
      return result
    }
  }
}
let hitsMapped = 0

// OPEN: after a withdrawal (or dispose), an editor document that was already
// re-cut into graphemes keeps those glyphs until Univer lays it out again (the
// next edit or the next cell opened), so its Arabic letters show unjoined
// until then. Text, offsets and the model are unaffected.
function withdraw(reason: string) {
  if (state.withdrawn !== null) return
  state.withdrawn = reason
  preferredCaret = null
  console.error(`[rtl-text] right-to-left text layer withdrawn: ${reason}`)
  for (const listener of state.onWithdraw) listener(reason)
}

export interface TextLayer {
  applied: boolean
  reason?: string
  /** Missing or changed hooks (static and instance); empty when applied. */
  problems: string[]
  dispose: () => void
}

/**
 * Apply the text layer for one enabled workbook. `injector` is Univer's root
 * injector (for the arrow-key controller). Never throws: a missing hook gives
 * `applied: false` with the reason, and everything stays stock.
 */
export function enableRtlText(injector: unknown, onWithdraw: (reason: string) => void): TextLayer {
  const problems = checkTextContract()
  const controller = findMoveController(injector)
  if (typeof controller === 'string' && controller !== PENDING) problems.push(controller)
  if (problems.length) return { applied: false, reason: `text contract broken: ${problems.join('; ')}`, problems, dispose: () => {} }
  if (state.withdrawn !== null) return { applied: false, reason: state.withdrawn, problems, dispose: () => {} }
  install()
  state.enabled++
  state.onWithdraw.add(onWithdraw)
  let disposed = false
  if (typeof controller !== 'string') patchMoveController(controller)
  else {
    // Enabled before Univer has rendered (as apps/web does, right after
    // createWorkbook): the cursor controller does not exist yet. Nothing can be
    // typed before it does; if it never appears, withdraw rather than leave
    // logical arrow keys over visual text.
    const started = Date.now()
    const poll = () => {
      if (disposed || state.withdrawn !== null) return
      const found = findMoveController(injector)
      if (typeof found !== 'string') return patchMoveController(found)
      if (found !== PENDING) return withdraw(`text contract broken: ${found}`)
      if (Date.now() - started > CONTROLLER_TIMEOUT_MS) return withdraw(`text contract broken: DocMoveCursorController not created within ${CONTROLLER_TIMEOUT_MS} ms`)
      setTimeout(poll, 50)
    }
    poll()
  }
  return {
    applied: true,
    problems,
    dispose: () => {
      if (disposed) return
      disposed = true
      state.enabled--
      state.onWithdraw.delete(onWithdraw)
      preferredCaret = null
    },
  }
}

/** For tests: lines painted, pointer positions mapped, and draws that bypassed the paint hook. */
export function textLayerCounters() {
  return { paintedLines: state.paintedLines, hitsMapped, paintedByHook, bypassedDraws: state.bypassedDraws }
}
