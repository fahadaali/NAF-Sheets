// Function scan of a Google Sheets formula, and the check against the
// functions Univer's formula engine implements (spec §7.2 "المعادلات غير المدعومة").
//
// The converter does not evaluate formulas. It finds every call (`NAME(`)
// outside string literals, quoted sheet names and structured references, with
// its argument count. A formula is kept only when every call is one Univer
// evaluates the way Google does; otherwise the cell keeps its last computed
// value (convert.ts).

import { UNIVER_IMPLEMENTED_FUNCTIONS } from './univer-functions.generated'

/** Every function Univer 1.4.0's formula engine implements (engine-formula ALL_IMPLEMENTED_FUNCTIONS_SET). */
export const UNIVER_SUPPORTED_FUNCTIONS: ReadonlySet<string> = new Set(UNIVER_IMPLEMENTED_FUNCTIONS)

/**
 * Converted to values even though Univer has a function of the same name.
 *
 * IMAGE: spec §7.2 names it as unsupported. Univer 1.4.0 implements Excel's
 * `IMAGE(source, [alt_text], [sizing], [height], [width])`
 * (engine-formula lookup/image), Google's is `IMAGE(url, [mode], [height], [width])`
 * (support.google.com/docs/answer/3093333). OPEN: OPEN_QUESTIONS.md §3.
 */
export const ALWAYS_VALUE_ONLY_FUNCTIONS: ReadonlySet<string> = new Set(['IMAGE'])

/**
 * Same name, different arguments: a call with more arguments than this is
 * converted to its value, because Univer would read the extra ones differently.
 *   FILTER — Google FILTER(range, condition1, [condition2, …]) (answer/3093197);
 *            Univer FILTER(array, include, [if_empty]) (engine-formula lookup/filter).
 *   SORT   — Google SORT(range, sort_column, is_ascending, …) with TRUE/FALSE
 *            (answer/3093150); Univer SORT(array, [sort_index], [sort_order], [by_col])
 *            accepts only 1 or -1 as sort_order (FALSE gives #VALUE!).
 * OPEN: OPEN_QUESTIONS.md §3.
 */
export const GOOGLE_ARGUMENT_LIMITS: ReadonlyMap<string, number> = new Map([
  ['FILTER', 2],
  ['SORT', 2],
])

export interface FunctionCall {
  /** Upper case. */
  name: string
  /** Number of top-level arguments; 0 for `NAME()`. */
  args: number
}

const IDENT_START = /[\p{L}_\\]/u
const IDENT_PART = /[\p{L}\p{N}_.\\]/u

interface Frame {
  call: FunctionCall | null
  separators: number
  hasContent: boolean
  brace: boolean
}

/**
 * Every call in `formula`, in order of its opening parenthesis. Skips "string
 * literals" ("" escapes), 'quoted sheet names' ('' escapes) and [structured
 * references]; commas inside {array literals} are not argument separators.
 */
export function extractFunctionCalls(formula: string): FunctionCall[] {
  const calls: FunctionCall[] = []
  const stack: Frame[] = []
  const n = formula.length
  const touch = () => {
    const top = stack[stack.length - 1]
    if (top) top.hasContent = true
  }
  let i = 0
  while (i < n) {
    const ch = formula[i] as string
    if (ch === '"' || ch === "'") {
      touch()
      i = skipQuoted(formula, i, ch)
      continue
    }
    if (ch === '[') {
      touch()
      const close = formula.indexOf(']', i + 1)
      i = close === -1 ? n : close + 1
      continue
    }
    if (IDENT_START.test(ch)) {
      touch()
      let j = i + 1
      while (j < n && IDENT_PART.test(formula[j] as string)) j++
      let k = j
      while (k < n && /\s/.test(formula[k] as string)) k++
      if (formula[k] === '(') {
        const call = { name: formula.slice(i, j).toUpperCase(), args: 0 }
        calls.push(call)
        stack.push({ call, separators: 0, hasContent: false, brace: false })
        i = k + 1
        continue
      }
      i = j
      continue
    }
    if (ch === '(' || ch === '{') {
      touch()
      stack.push({ call: null, separators: 0, hasContent: false, brace: ch === '{' })
    } else if (ch === ')' || ch === '}') {
      const frame = stack.pop()
      if (frame?.call) frame.call.args = frame.hasContent || frame.separators > 0 ? frame.separators + 1 : 0
    } else if (ch === ',' || ch === ';') {
      const top = stack[stack.length - 1]
      if (top && !top.brace) top.separators++
    } else if (!/\s/.test(ch)) {
      touch()
    }
    i++
  }
  // Unclosed calls (malformed formula): count what was seen.
  for (const frame of stack) if (frame.call) frame.call.args = frame.hasContent || frame.separators > 0 ? frame.separators + 1 : 0
  return calls
}

function skipQuoted(text: string, start: number, quote: string): number {
  let i = start + 1
  while (i < text.length) {
    if (text[i] === quote) {
      if (text[i + 1] === quote) {
        i += 2
        continue
      }
      return i + 1
    }
    i++
  }
  return text.length
}

/** Names called as functions in `formula`, upper-cased, in order of first use. */
export function extractFunctionNames(formula: string): string[] {
  return [...new Set(extractFunctionCalls(formula).map((c) => c.name))]
}

/**
 * Functions that stop `formula` from being kept: names outside `supported`,
 * {@link ALWAYS_VALUE_ONLY_FUNCTIONS}, and calls beyond {@link GOOGLE_ARGUMENT_LIMITS}.
 *
 * A name bound by LET or LAMBDA and then called (`f(1)`) is reported too:
 * the scan does not resolve bindings, and keeping the value is the safe side.
 */
export function findUnsupportedFunctions(formula: string, supported: ReadonlySet<string> = UNIVER_SUPPORTED_FUNCTIONS): string[] {
  const out = new Set<string>()
  for (const call of extractFunctionCalls(formula)) {
    const limit = GOOGLE_ARGUMENT_LIMITS.get(call.name)
    if (ALWAYS_VALUE_ONLY_FUNCTIONS.has(call.name) || !supported.has(call.name) || (limit !== undefined && call.args > limit)) out.add(call.name)
  }
  return [...out]
}

/** Normalises a condition formula from the API: Google accepts a leading `+` as well as `=`. */
export function normalizeConditionFormula(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.startsWith('=')) return trimmed
  if (trimmed.startsWith('+')) return `=${trimmed.slice(1)}`
  return null
}
