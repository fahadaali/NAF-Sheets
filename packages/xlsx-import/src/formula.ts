// Formulas as an .xlsx stores them, turned into what the Google model holds
// (`=` + the formula as the user wrote it), per origin.
//
// * Shared formulas (`<f t="shared" ref=… si=…>`): only the first cell holds
//   the text; the others refer to it by `si`. Each cell gets the master's text
//   with relative references moved by its offset. Excel writes them, and so
//   does Google's export (verified on a real export: «5. Control Switch»
//   `B5:B24`).
// * Future-function prefixes: `_xlfn.` (functions newer than Excel 2007),
//   `_xlfn._xlws.` (SORT, FILTER) and `_xlpm.` (LET/LAMBDA parameters) are
//   storage prefixes, removed. `_xludf.` marks a function Excel does not know;
//   it is kept, so the converter lists it and keeps the cached value.
// * Google's export (verified on real files): a Google-only function is
//   written as `IFERROR(__xludf.DUMMYFUNCTION("<original formula>"), <value>)`
//   and every other cell of its spilled result as
//   `IFERROR(__xludf.DUMMYFUNCTION("""COMPUTED_VALUE"""), <value>)`. The
//   original formula is restored (so the converter reports QUERY, not
//   DUMMYFUNCTION) and the spilled cells become produced cells, exactly what
//   the Sheets API returns for them.
// * What Univer cannot evaluate though no function is unknown — structured
//   table references (`Table1[Amount]`), links to other workbooks (`[1]Sheet!A1`)
//   and spill references (`A1#`) — is returned by `formulaBlockers`, so the
//   converter keeps the cached value.

const MAX_COLUMN = 16_384
const MAX_ROW = 1_048_576

/** Column letters → 1-based index; 0 when not a column within XFD. */
function columnIndex(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n <= MAX_COLUMN ? n : 0
}

function columnLetters(index: number): string {
  let n = index
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** Splits a formula into code and literal parts ("strings", 'sheet names', [structured refs]). */
function segments(formula: string): Array<{ code: boolean; text: string }> {
  const out: Array<{ code: boolean; text: string }> = []
  let i = 0
  let start = 0
  const push = (end: number, code: boolean) => {
    if (end > start) out.push({ code, text: formula.slice(start, end) })
    start = end
  }
  while (i < formula.length) {
    const ch = formula[i]
    if (ch === '"' || ch === "'") {
      push(i, true)
      let j = i + 1
      while (j < formula.length) {
        if (formula[j] === ch) {
          if (formula[j + 1] === ch) {
            j += 2
            continue
          }
          break
        }
        j++
      }
      i = Math.min(j + 1, formula.length)
      push(i, false)
      continue
    }
    if (ch === '[') {
      push(i, true)
      let depth = 0
      let j = i
      while (j < formula.length) {
        if (formula[j] === '[') depth++
        else if (formula[j] === ']') {
          depth--
          if (depth === 0) break
        }
        j++
      }
      i = Math.min(j + 1, formula.length)
      push(i, false)
      continue
    }
    i++
  }
  push(formula.length, true)
  return out
}

const CELL_REF = /(?<![A-Za-z0-9_.$\]])(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![A-Za-z0-9_(.!#])/g
const ROW_RANGE = /(?<![A-Za-z0-9_.$\]])(\$?)(\d{1,7}):(\$?)(\d{1,7})(?![\d.A-Za-z(])/g
const COL_RANGE = /(?<![A-Za-z0-9_.$\]])(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9_(.!])/g

/**
 * The master formula of a shared group as seen from a cell `dr` rows and `dc`
 * columns away: relative references move, absolute ones (`$`) stay; a
 * reference moved off the sheet becomes `#REF!` (as in Excel).
 */
export function shiftFormula(formula: string, dr: number, dc: number): string {
  if (dr === 0 && dc === 0) return formula
  return segments(formula)
    .map((seg) => {
      if (!seg.code) return seg.text
      let text = seg.text.replace(COL_RANGE, (m, d1: string, c1: string, d2: string, c2: string) => {
        const a = columnIndex(c1)
        const b = columnIndex(c2)
        if (!a || !b) return m
        const na = d1 ? a : a + dc
        const nb = d2 ? b : b + dc
        if (na < 1 || nb < 1 || na > MAX_COLUMN || nb > MAX_COLUMN) return '#REF!'
        return `${d1}${columnLetters(na)}:${d2}${columnLetters(nb)}`
      })
      text = text.replace(ROW_RANGE, (_m, d1: string, r1: string, d2: string, r2: string) => {
        const na = d1 ? Number(r1) : Number(r1) + dr
        const nb = d2 ? Number(r2) : Number(r2) + dr
        if (na < 1 || nb < 1 || na > MAX_ROW || nb > MAX_ROW) return '#REF!'
        return `${d1}${na}:${d2}${nb}`
      })
      text = text.replace(CELL_REF, (m, dCol: string, letters: string, dRow: string, digits: string) => {
        const col = columnIndex(letters)
        if (!col) return m
        const row = Number(digits)
        if (row < 1 || row > MAX_ROW) return m
        const nc = dCol ? col : col + dc
        const nr = dRow ? row : row + dr
        if (nc < 1 || nr < 1 || nc > MAX_COLUMN || nr > MAX_ROW) return '#REF!'
        return `${dCol}${columnLetters(nc)}${dRow}${nr}`
      })
      return text
    })
    .join('')
}

/** Removes the storage-only prefixes `_xlfn.`, `_xlfn._xlws.` and `_xlpm.` outside literals. */
export function stripFuturePrefixes(formula: string): string {
  if (!/_xl(fn|pm)\./i.test(formula)) return formula
  return segments(formula)
    .map((seg) => (seg.code ? seg.text.replace(/_xlfn\._xlws\./gi, '').replace(/_xlfn\./gi, '').replace(/_xlpm\./gi, '') : seg.text))
    .join('')
}

export type GoogleDummy = { kind: 'computed' } | { kind: 'formula'; formula: string }

const DUMMY_HEAD = /^\s*(?:IFERROR\(\s*)?__xludf\.DUMMYFUNCTION\(\s*"/i

/**
 * Google's export wrapper, or null when `formula` is not one. `formula` is
 * without the leading `=`; the returned formula starts with `=`.
 */
export function unwrapGoogleDummy(formula: string): GoogleDummy | null {
  const head = DUMMY_HEAD.exec(formula)
  if (!head) return null
  const wrapped = /^\s*IFERROR\(/i.test(formula)
  let i = head[0].length
  let inner = ''
  for (;;) {
    if (i >= formula.length) return null
    const ch = formula[i] as string
    if (ch === '"') {
      if (formula[i + 1] === '"') {
        inner += '"'
        i += 2
        continue
      }
      i++
      break
    }
    inner += ch
    i++
  }
  const rest = formula.slice(i).trim()
  // `)` closes DUMMYFUNCTION; then, inside IFERROR, `,<fallback>)` must follow.
  if (!rest.startsWith(')')) return null
  if (wrapped && !/^\)\s*,[\s\S]*\)\s*$/.test(rest)) return null
  if (!wrapped && rest !== ')') return null
  // Google writes the marker as a string literal inside the string: """COMPUTED_VALUE""".
  if (inner === '"COMPUTED_VALUE"' || inner === 'COMPUTED_VALUE') return { kind: 'computed' }
  const text = inner.trim()
  if (text === '') return null
  return { kind: 'formula', formula: text.startsWith('=') ? text : `=${text}` }
}

const STRUCTURED_REF = /(?:^|[^A-Za-z0-9_.])([A-Za-z_\\][A-Za-z0-9_.\\]*)?\[/
const EXTERNAL_REF = /(?:^|[^A-Za-z0-9_\]])\[\d+\]/
const SPILL_REF = /\$?[A-Za-z]{1,3}\$?\d{1,7}#/

/**
 * Reasons, beyond unknown functions, that a formula cannot be evaluated by
 * Univer as the file did. Labels go into the report next to function names.
 */
export function formulaBlockers(formula: string): string[] {
  const out: string[] = []
  // Literals hide brackets, so test the code parts with the brackets kept:
  // a structured or external reference is a bracket segment directly after code.
  const segs = segments(formula)
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k] as { code: boolean; text: string }
    if (seg.code || !seg.text.startsWith('[')) continue
    const before = k > 0 ? (segs[k - 1] as { text: string }).text : ''
    if (/^\[\d+\]/.test(seg.text) && EXTERNAL_REF.test(`${before.slice(-1)}${seg.text}`)) {
      if (!out.includes('[ملف خارجي]')) out.push('[ملف خارجي]')
    } else if (STRUCTURED_REF.test(`${before}[`)) {
      const name = /([A-Za-z_\\][A-Za-z0-9_.\\]*)$/.exec(before)?.[1]
      const label = name ? `${name}[…]` : '[…]'
      if (!out.includes(label)) out.push(label)
    }
  }
  const code = segs.filter((s) => s.code).map((s) => s.text).join(' ')
  if (SPILL_REF.test(code) && !out.includes('#')) out.push('#')
  return out
}
