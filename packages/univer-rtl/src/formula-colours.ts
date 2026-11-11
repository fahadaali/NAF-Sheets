// Formula colouring while a formula is edited (owner decision 2026-11-11):
// exactly like Excel for what Excel colours, plus calm extra colours for what
// Excel leaves black. Verified against Univer 1.4.0. The research behind every
// rule (sources, the colour sequence) is recorded in apps/web/OPEN_QUESTIONS.md
// (F1–F4).
//
// What Excel does (and this module reproduces):
//   - Every distinct reference to a range on the sheet shown gets the next
//     colour of a fixed, repeating sequence of seven, left to right by first
//     appearance. A repeated reference keeps the colour of its first mention;
//     "repeated" means the same range (A1 and $A$1 are the same reference).
//   - Each such reference is outlined on the grid in its colour, with a light
//     fill (10 % of the colour) and a square handle at each of the four corners.
//   - A reference to another worksheet is not coloured (Excel 2021+).
//   - Named ranges are coloured like references.
//   - Parentheses: the outermost pair is black; nested pairs take colours by
//     depth (red, purple, green, … — the reference sequence from its second
//     colour on), a pair always sharing one colour.
//
// The extra categories (owner): function names, sheet names in references,
// text strings, numbers, booleans, comparison operators, other operators and
// error values, each with its own colour from the platform theme.
//
// How Univer 1.4.0 does it, and where this module hooks:
//   - sheets-formula-ui's formula editor (the cell editor and the formula bar)
//     tokenises with LexerTreeBuilder, colours references from the theme's
//     `loop-color` sequence (twelve colours, reused per identical token text),
//     numbers and strings from fixed theme colours, and writes the runs with
//     ReplaceTextRunsCommand. The outlines are ref selections styled by
//     genFormulaRefSelectionStyle (eight handles, 5 % fill), drawn by
//     RefSelectionsRenderService.
//   1. Theme (supported extension point): `loop-color` becomes Excel's seven
//      colours, so even with no hook the reference colours are Excel's.
//   2. ReplaceTextRunsCommand.handler is wrapped (a copy of the parameters is
//      passed on, never the original mutated) for the two editor documents:
//      the runs are rebuilt from Univer's own lexer with the rules above.
//   3. RefSelectionsRenderService.prototype.resetSelectionsByModelData is
//      wrapped: each outline whose id is the sequence index of a planned
//      reference (Univer's own id scheme) and whose range matches it gets that
//      reference's colour, Excel's fill and Excel's four corner handles.
//   Every hook is listed in `checkFormulaColourContract()`; a live lexer check
//   runs when the layer is enabled. With any problem the hooks are not
//   installed and Univer's own colouring stays (with Excel's palette, 1).

import { DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY, DOCS_NORMAL_EDITOR_UNIT_ID_KEY, IUniverInstanceService, ThemeService, UniverInstanceType } from '@univerjs/core'
import { ReplaceTextRunsCommand } from '@univerjs/docs-ui'
import { ERROR_TYPE_SET, IDefinedNamesService, LexerTreeBuilder, deserializeRangeWithSheet } from '@univerjs/engine-formula'
import type { FUniver } from '@univerjs/presets'
import { RefSelectionsRenderService } from '@univerjs/sheets-formula-ui'
import { IEditorBridgeService } from '@univerjs/sheets-ui'

// ---------------------------------------------------------------------------
// Pure part: token → colour (no Univer services, no DOM)
// ---------------------------------------------------------------------------

/** Colours for every category. `references` is Excel's sequence, in order. */
export interface FormulaPalette {
  references: readonly string[]
  plain: string
  function: string
  sheet: string
  string: string
  number: string
  boolean: string
  comparison: string
  operator: string
  error: string
}

export type FormulaTokenKind = 'plain' | 'reference' | 'name' | 'function' | 'sheet' | 'string' | 'number' | 'boolean' | 'comparison' | 'operator' | 'error' | 'paren'

/** A sequence node as Univer's LexerTreeBuilder.sequenceNodesBuilder returns it. */
export type FormulaNode = string | { nodeType: number; token: string; startIndex?: number; endIndex?: number }

// sequenceNodeType of @univerjs/engine-formula 1.4.0
const NODE = { NORMAL: 0, NUMBER: 1, STRING: 2, FUNCTION: 3, REFERENCE: 4, ARRAY: 5, DEFINED_NAME: 6, TABLE: 7 } as const

export interface FormulaContext {
  /** Name of the sheet shown in the grid now (the one outlines are drawn on). */
  currentSheet: string
  /** Name of the sheet of the cell being edited (what an unqualified reference points to). */
  editingSheet: string
  /** Whether a bare name is a defined name of the workbook. */
  isDefinedName?: (name: string) => boolean
}

export interface RangeLike { startRow: number | null; startColumn: number | null; endRow: number | null; endColumn: number | null }

export interface PlannedReference {
  /** Index of the node in the sequence (Univer's ref-selection id). */
  nodeIndex: number
  token: string
  kind: 'reference' | 'name'
  /** The reference's colour, or null when it is not coloured (another sheet). */
  colour: string | null
  /** Position in Excel's sequence (0-based, before wrapping), or null. */
  slot: number | null
  /** Target sheet name and normalised range (references only). */
  sheetName?: string
  range?: RangeLike
}

export interface ColourSpan { start: number; end: number; kind: FormulaTokenKind; colour: string }

export interface FormulaColourPlan {
  /** The formula without its leading `=`. */
  text: string
  /** Consecutive spans covering `text` (offsets into `text`, end exclusive). */
  spans: ColourSpan[]
  references: PlannedReference[]
}

const SHEET_PREFIX = /^(?:\[[^\]]*\])?(?:'(?:[^']|'')+'|[^'!]+)!/
const BOOLEAN = /^(TRUE|FALSE)$/i
const COMPARISON = new Set(['=', '<', '>'])
const OPERATOR = new Set(['+', '-', '*', '/', '^', '&', '%'])
const ERROR_VALUES = new Set<string>([...ERROR_TYPE_SET].map((e) => String(e).toUpperCase()))

const sameName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0

function normalise(r: RangeLike): RangeLike {
  const lo = (a: number | null, b: number | null) => (a == null || b == null ? a ?? b : Math.min(a, b))
  const hi = (a: number | null, b: number | null) => (a == null || b == null ? b ?? a : Math.max(a, b))
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const [sr, er, sc, ec] = [n(r.startRow), n(r.endRow), n(r.startColumn), n(r.endColumn)]
  return { startRow: lo(sr, er), endRow: hi(sr, er), startColumn: lo(sc, ec), endColumn: hi(sc, ec) }
}

/** Colour of a parenthesis pair at nesting depth `depth` (0 = outermost). */
export function parenColour(depth: number, palette: FormulaPalette): string {
  if (depth <= 0 || palette.references.length === 0) return palette.plain
  return palette.references[depth % palette.references.length]!
}

/** Kind of one character of a plain (operator / punctuation) node. */
function charKind(ch: string): FormulaTokenKind {
  if (COMPARISON.has(ch)) return 'comparison'
  if (OPERATOR.has(ch)) return 'operator'
  return 'plain'
}

/** Spans inside an array constant `{1,"a";TRUE,#N/A}`: braces and separators plain. */
function arraySpans(token: string, offset: number, palette: FormulaPalette): ColourSpan[] {
  const out: ColourSpan[] = []
  const re = /"(?:[^"]|"")*"?|#[A-Z0-9/_]+[!?]?|[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?%?|[A-Za-z]+|./gy
  let m: RegExpExecArray | null
  while ((m = re.exec(token))) {
    const t = m[0]
    let kind: FormulaTokenKind = 'plain'
    if (t.startsWith('"')) kind = 'string'
    else if (t.startsWith('#') && ERROR_VALUES.has(t.toUpperCase())) kind = 'error'
    else if (/^[-+]?\d*\.?\d/.test(t)) kind = 'number'
    else if (BOOLEAN.test(t)) kind = 'boolean'
    out.push({ start: offset + m.index, end: offset + m.index + t.length, kind, colour: palette[kind as 'string'] ?? palette.plain })
  }
  return out
}

/**
 * Plan the colours of a formula (`text` without the leading `=`) from Univer's
 * sequence nodes. Returns null when the nodes do not spell out `text` (a lexer
 * that changed): the caller then leaves Univer's own colours.
 */
export function planFormulaColours(text: string, nodes: readonly FormulaNode[], palette: FormulaPalette, ctx: FormulaContext): FormulaColourPlan | null {
  const tokens = nodes.map((n) => (typeof n === 'string' ? n : n?.token))
  if (tokens.some((t) => typeof t !== 'string') || tokens.join('') !== text) return null
  const spans: ColourSpan[] = []
  const references: PlannedReference[] = []
  const colourOfKey = new Map<string, { colour: string; slot: number }>()
  let nextSlot = 0
  let depth = 0
  const push = (start: number, end: number, kind: FormulaTokenKind, colour: string) => {
    if (end > start) spans.push({ start, end, kind, colour })
  }
  const take = (key: string) => {
    let entry = colourOfKey.get(key)
    if (!entry && palette.references.length) {
      entry = { colour: palette.references[nextSlot % palette.references.length]!, slot: nextSlot }
      nextSlot++
      colourOfKey.set(key, entry)
    }
    return entry ?? null
  }
  // The next node that is not whitespace: decides whether a name is a function call.
  const nextToken = (i: number) => {
    for (let k = i + 1; k < tokens.length; k++) if (tokens[k]!.trim()) return tokens[k]!
    return ''
  }

  let offset = 0
  nodes.forEach((node, index) => {
    const token = tokens[index]!
    const start = offset
    const end = offset + token.length
    offset = end
    if (typeof node === 'string') {
      for (let k = 0; k < token.length; k++) {
        const ch = token[k]!
        if (ch === '(') {
          push(start + k, start + k + 1, 'paren', parenColour(depth, palette))
          depth++
        } else if (ch === ')') {
          depth = Math.max(0, depth - 1)
          push(start + k, start + k + 1, 'paren', parenColour(depth, palette))
        } else {
          const kind = charKind(ch)
          push(start + k, start + k + 1, kind, kind === 'plain' ? palette.plain : palette[kind as 'comparison' | 'operator'])
        }
      }
      return
    }
    const bare = token.trim()
    switch (node.nodeType) {
      case NODE.NUMBER:
        return push(start, end, 'number', palette.number)
      case NODE.STRING:
        return push(start, end, 'string', palette.string)
      case NODE.ARRAY:
        spans.push(...arraySpans(token, start, palette))
        return
      case NODE.REFERENCE:
      case NODE.TABLE: {
        const prefix = SHEET_PREFIX.exec(token)?.[0] ?? ''
        if (prefix) push(start, start + prefix.length, 'sheet', palette.sheet)
        if (node.nodeType === NODE.TABLE) {
          const entry = take(`table|${bare.toLowerCase()}`)
          references.push({ nodeIndex: index, token, kind: 'reference', colour: entry?.colour ?? null, slot: entry?.slot ?? null })
          return push(start + prefix.length, end, entry ? 'reference' : 'plain', entry?.colour ?? palette.plain)
        }
        let parsed: { sheetName: string; range: RangeLike } | null = null
        try {
          parsed = deserializeRangeWithSheet(bare) as unknown as { sheetName: string; range: RangeLike }
        } catch {
          parsed = null
        }
        const sheetName = parsed?.sheetName || ctx.editingSheet
        const range = parsed ? normalise(parsed.range) : undefined
        // Excel 2021+: a reference to another worksheet is not coloured.
        const coloured = Boolean(parsed) && sameName(sheetName, ctx.currentSheet)
        const entry = coloured ? take(`ref|${sheetName.toLowerCase()}|${JSON.stringify(range)}`) : null
        references.push({ nodeIndex: index, token, kind: 'reference', colour: entry?.colour ?? null, slot: entry?.slot ?? null, sheetName, range })
        return push(start + prefix.length, end, entry ? 'reference' : 'plain', entry?.colour ?? palette.plain)
      }
      case NODE.FUNCTION:
      case NODE.DEFINED_NAME: {
        const upper = bare.toUpperCase()
        const call = nextToken(index).startsWith('(')
        if (call) return push(start, end, 'function', palette.function)
        if (ERROR_VALUES.has(upper)) return push(start, end, 'error', palette.error)
        if (BOOLEAN.test(bare)) return push(start, end, 'boolean', palette.boolean)
        if (node.nodeType === NODE.DEFINED_NAME || ctx.isDefinedName?.(bare)) {
          const entry = take(`name|${bare.toLowerCase()}`)
          references.push({ nodeIndex: index, token, kind: 'name', colour: entry?.colour ?? null, slot: entry?.slot ?? null })
          return push(start, end, 'name', entry?.colour ?? palette.plain)
        }
        // A function name still being typed, a LET/LAMBDA parameter…: plain, as in Excel.
        return push(start, end, 'plain', palette.plain)
      }
      default:
        return push(start, end, 'plain', palette.plain)
    }
  })
  return { text, spans, references }
}

export interface TextRunLike { st: number; ed: number; ts?: Record<string, unknown> }

/**
 * Text runs for a formula editor document whose data stream is `=` + plan.text.
 * Every other text style Univer gave a character (its font size) is kept.
 */
export function formulaTextRuns(plan: FormulaColourPlan, base: readonly TextRunLike[], palette: FormulaPalette, leading = 1): TextRunLike[] {
  const length = leading + plan.text.length
  const colours: string[] = new Array(length).fill(palette.plain)
  for (const s of plan.spans) for (let i = s.start; i < s.end; i++) colours[leading + i] = s.colour
  const baseTs = (i: number) => {
    for (const r of base) if (r.st <= i && i < r.ed) return r.ts ?? {}
    return {}
  }
  const runs: TextRunLike[] = []
  for (let i = 0; i < length; i++) {
    const ts = { ...baseTs(i), cl: { rgb: colours[i] } }
    const last = runs[runs.length - 1]
    if (last && last.ed === i && JSON.stringify(last.ts) === JSON.stringify(ts)) last.ed = i + 1
    else runs.push({ st: i, ed: i + 1, ts })
  }
  return runs
}

/** `rgba(…, alpha)` of a `#rrggbb` colour. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return hex
  return `rgba(${parseInt(m[1]!, 16)}, ${parseInt(m[2]!, 16)}, ${parseInt(m[3]!, 16)}, ${alpha})`
}

/** Excel's range-finder fill: the outline colour at 10 % (measured 2026: e.g. #326AC7 over white = #EBF0F9). */
export const EXCEL_OUTLINE_FILL_ALPHA = 0.1
/** Excel's handles: a square at each corner of the outline, none on the sides. */
export const EXCEL_OUTLINE_WIDGETS = Object.freeze({ tl: true, tc: false, tr: true, ml: false, mr: false, bl: true, bc: false, br: true })

/** True when an outline's range is the planned reference's (unbounded sides, e.g. A:A, match anything). */
export function sameOutlineRange(planned: RangeLike | undefined, actual: Partial<RangeLike> | undefined): boolean {
  if (!planned || !actual) return false
  const sides = ['startRow', 'startColumn', 'endRow', 'endColumn'] as const
  return sides.every((k) => planned[k] == null || planned[k] === actual[k])
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

type AnyFn = (...args: any[]) => unknown // eslint-disable-line @typescript-eslint/no-explicit-any
const isFn = (v: unknown): v is AnyFn => typeof v === 'function'

/** Static contract: every Univer export and internal this module hooks. Empty means it can be applied. */
export function checkFormulaColourContract(): string[] {
  const problems: string[] = []
  const cmd = ReplaceTextRunsCommand as unknown as { id?: string; handler?: unknown }
  if (cmd?.id !== 'doc.command.replace-text-runs' || !isFn(cmd.handler)) problems.push('ReplaceTextRunsCommand (id doc.command.replace-text-runs, handler)')
  const refRender = (RefSelectionsRenderService as unknown as { prototype?: Record<string, unknown> } | undefined)?.prototype
  if (!refRender || !isFn(refRender.resetSelectionsByModelData) || (refRender.resetSelectionsByModelData as AnyFn).length < 1) problems.push('RefSelectionsRenderService.prototype.resetSelectionsByModelData(selectionsWithStyle)')
  const lexer = (LexerTreeBuilder as unknown as { prototype?: Record<string, unknown> } | undefined)?.prototype
  if (!lexer || !isFn(lexer.sequenceNodesBuilder)) problems.push('LexerTreeBuilder.prototype.sequenceNodesBuilder')
  if (!isFn(deserializeRangeWithSheet)) problems.push('deserializeRangeWithSheet (engine-formula)')
  if (!(ERROR_TYPE_SET instanceof Set) || !ERROR_TYPE_SET.has('#REF!' as never)) problems.push('ERROR_TYPE_SET (engine-formula)')
  if (DOCS_NORMAL_EDITOR_UNIT_ID_KEY !== '__INTERNAL_EDITOR__DOCS_NORMAL' || DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY !== '__INTERNAL_EDITOR__DOCS_FORMULA_BAR') problems.push('DOCS_NORMAL_EDITOR_UNIT_ID_KEY / DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY')
  for (const [name, id] of [['IEditorBridgeService', IEditorBridgeService], ['IDefinedNamesService', IDefinedNamesService], ['ThemeService', ThemeService], ['IUniverInstanceService', IUniverInstanceService]] as const) {
    if (id == null) problems.push(name)
  }
  return problems
}

/** Live contract: the installed lexer still classifies tokens the way the plan expects. */
export function checkLexerSemantics(lexer: { sequenceNodesBuilder: (f: string) => FormulaNode[] | undefined } | null | undefined): string[] {
  if (!lexer || !isFn(lexer.sequenceNodesBuilder)) return ['LexerTreeBuilder (injector)']
  const sample = `SUM(A1,'S'!B2,"x",1)>=TRUE`
  let nodes: FormulaNode[] | undefined
  try {
    nodes = lexer.sequenceNodesBuilder(sample)
  } catch (e) {
    return [`LexerTreeBuilder.sequenceNodesBuilder threw: ${String(e)}`]
  }
  const got = (nodes ?? []).map((n) => (typeof n === 'string' ? n : `${n.nodeType}:${n.token}`)).join(' ')
  const want = `${NODE.FUNCTION}:SUM ( ${NODE.REFERENCE}:A1 , ${NODE.REFERENCE}:'S'!B2 , ${NODE.STRING}:"x" , ${NODE.NUMBER}:1 ) > = ${NODE.FUNCTION}:TRUE`
  return got === want ? [] : [`LexerTreeBuilder.sequenceNodesBuilder token types changed: ${got}`]
}

// ---------------------------------------------------------------------------
// Hooks (installed once, inert while no workbook has the layer enabled)
// ---------------------------------------------------------------------------

type Accessor = { get: <T>(id: unknown) => T }
interface ReplaceParams { unitId?: string; body?: { dataStream?: string; textRuns?: TextRunLike[] }; [k: string]: unknown }

const state = {
  enabled: 0,
  palette: null as FormulaPalette | null,
  /** The plan of the formula last coloured (the outlines are matched against it). */
  lastPlan: null as FormulaColourPlan | null,
  recoloured: 0,
  outlinesStyled: 0,
}
const EDITORS = new Set<string>([DOCS_NORMAL_EDITOR_UNIT_ID_KEY, DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY])

/** Diagnostics for the tests: formulas recoloured and outlines restyled. */
export function formulaColourCounters() {
  return { recoloured: state.recoloured, outlinesStyled: state.outlinesStyled, active: state.enabled > 0 }
}

function contextOf(accessor: Accessor): FormulaContext | null {
  const instances = accessor.get<{ getUnit: (id: string, type?: unknown) => unknown; getCurrentUnitOfType: (t: unknown) => unknown }>(IUniverInstanceService)
  type Book = { getUnitId(): string; getActiveSheet(): { getName(): string; getSheetId(): string } | null; getSheetBySheetId(id: string): { getName(): string } | null | undefined }
  let book: Book | null = null
  let editingSheet = ''
  try {
    const edit = accessor.get<{ getEditCellState: () => { unitId: string; sheetId: string } | null | undefined }>(IEditorBridgeService).getEditCellState()
    if (edit) {
      book = (instances.getUnit(edit.unitId, UniverInstanceType.UNIVER_SHEET) as Book | null) ?? null
      editingSheet = book?.getSheetBySheetId(edit.sheetId)?.getName() ?? ''
    }
  } catch {
    // no editor bridge state: fall back to the current workbook
  }
  book ??= (instances.getCurrentUnitOfType(UniverInstanceType.UNIVER_SHEET) as Book | null) ?? null
  const current = book?.getActiveSheet()
  if (!book || !current) return null
  if (!editingSheet) editingSheet = current.getName()
  let names: { getValueByName: (unitId: string, name: string) => unknown } | null = null
  try {
    names = accessor.get(IDefinedNamesService)
  } catch {
    names = null
  }
  const unitId = book.getUnitId()
  return { currentSheet: current.getName(), editingSheet, isDefinedName: (n) => Boolean(names?.getValueByName(unitId, n)) }
}

function recolour(accessor: Accessor, params: ReplaceParams): ReplaceParams | null {
  const palette = state.palette
  const body = params.body
  const stream = body?.dataStream
  if (!palette || !params.unitId || !EDITORS.has(params.unitId) || typeof stream !== 'string' || !stream.startsWith('=') || !body?.textRuns?.length) return null
  const text = stream.slice(1)
  const lexer = accessor.get<{ sequenceNodesBuilder: (f: string) => FormulaNode[] | undefined }>(LexerTreeBuilder)
  const ctx = contextOf(accessor)
  if (!ctx) return null
  const plan = planFormulaColours(text, lexer.sequenceNodesBuilder(text) ?? [], palette, ctx)
  if (!plan) return null
  state.lastPlan = plan
  state.recoloured++
  return { ...params, body: { ...body, textRuns: formulaTextRuns(plan, body.textRuns, palette) } }
}

interface SelectionWithStyle { range?: Partial<RangeLike>; style?: Record<string, unknown> & { id?: string; stroke?: string } }

function restyleOutlines(list: readonly SelectionWithStyle[]): readonly SelectionWithStyle[] {
  const plan = state.lastPlan
  if (!plan || !Array.isArray(list)) return list
  let changed = false
  const out = list.map((selection) => {
    const id = selection?.style?.id
    if (typeof id !== 'string' || !/^\d+$/.test(id)) return selection
    const ref = plan.references.find((r) => r.nodeIndex === Number(id))
    if (!ref?.colour || ref.kind !== 'reference' || !sameOutlineRange(ref.range, selection.range)) return selection
    changed = true
    state.outlinesStyled++
    return {
      ...selection,
      style: {
        ...selection.style,
        stroke: ref.colour,
        fill: withAlpha(ref.colour, EXCEL_OUTLINE_FILL_ALPHA),
        widgets: { ...EXCEL_OUTLINE_WIDGETS },
      },
    }
  })
  return changed ? out : list
}

let installed = false
function install() {
  if (installed) return
  installed = true
  const cmd = ReplaceTextRunsCommand as unknown as { handler: (accessor: Accessor, params?: ReplaceParams, options?: unknown) => unknown }
  const original = cmd.handler
  cmd.handler = (accessor, params, options) => {
    let next: ReplaceParams | null = null
    if (state.enabled > 0 && params) {
      try {
        next = recolour(accessor, params)
      } catch (e) {
        console.error('[formula-colours] recolouring failed; Univer\'s colours kept', e)
      }
    }
    return original(accessor, next ?? params, options)
  }
  const proto = RefSelectionsRenderService.prototype as unknown as { resetSelectionsByModelData: (list: readonly SelectionWithStyle[]) => void }
  const reset = proto.resetSelectionsByModelData
  proto.resetSelectionsByModelData = function (this: unknown, list: readonly SelectionWithStyle[]) {
    let next = list
    if (state.enabled > 0) {
      try {
        next = restyleOutlines(list)
      } catch (e) {
        console.error('[formula-colours] outline styling failed; Univer\'s kept', e)
      }
    }
    return reset.call(this, next)
  }
}

export interface FormulaColoursStatus {
  /** True when the token colours and outlines follow Excel's rules (hooks installed). */
  applied: boolean
  /** True when Univer's theme carries Excel's reference sequence (also without the hooks). */
  themed: boolean
  /** Set when not applied (English, for an administrator). */
  reason?: string
  problems: string[]
  dispose: () => void
}

/**
 * Colour formulas while they are edited. Call after `createWorkbook` (the
 * lexer must exist). Never throws for a contract problem: it reports
 * `applied: false` with the reason, and Univer's own colouring stays.
 */
export function enableFormulaColours(univerAPI: FUniver, palette: FormulaPalette): FormulaColoursStatus {
  const injector = (univerAPI as unknown as { _injector?: Accessor })._injector
  const problems = checkFormulaColourContract()
  if (!injector || !isFn(injector.get)) problems.push('FUniver._injector')
  if (!palette.references.length || palette.references.some((c) => !/^#[0-9a-f]{6}$/i.test(c))) problems.push('palette.references: #rrggbb colours expected')

  // 1. Theme: Excel's sequence for Univer's own reference colouring.
  let themed = false
  let restoreTheme = () => {}
  if (injector && isFn(injector.get)) {
    try {
      const theme = injector.get<{ getCurrentTheme(): Record<string, unknown>; setTheme(t: Record<string, unknown>): void }>(ThemeService)
      const before = theme.getCurrentTheme()
      theme.setTheme({ ...before, 'loop-color': Object.fromEntries(palette.references.map((c, i) => [i + 1, c])) })
      themed = true
      restoreTheme = () => theme.setTheme(before)
    } catch (e) {
      problems.push(`ThemeService.setTheme: ${String(e)}`)
    }
    if (problems.length === 0) {
      try {
        problems.push(...checkLexerSemantics(injector.get(LexerTreeBuilder)))
      } catch (e) {
        problems.push(`LexerTreeBuilder (injector): ${String(e)}`)
      }
    }
  }
  if (problems.length) {
    const reason = `formula colours contract broken: ${problems.join('; ')}`
    console.error(`[formula-colours] Univer's own formula colouring kept: ${reason}`)
    return { applied: false, themed, reason, problems, dispose: restoreTheme }
  }

  install()
  state.palette = palette
  state.enabled++
  let disposed = false
  return {
    applied: true,
    themed,
    problems,
    dispose: () => {
      if (disposed) return
      disposed = true
      state.enabled--
      if (state.enabled === 0) state.lastPlan = null
      restoreTheme()
    },
  }
}
