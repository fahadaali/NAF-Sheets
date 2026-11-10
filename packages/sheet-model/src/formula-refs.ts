// Moving a formula to another cell, the way Univer does when it reorders rows
// (sort): relative parts of every A1 reference shift by the offset, absolute
// parts (`$`) stay, and a reference pushed off the grid becomes `#REF!`.
// Univer's own implementation is `LexerTreeBuilder.moveFormulaRefOffset`
// (engine-formula); test/formula-refs.test.ts compares this one with it.
//
// Only the reference tokens are rewritten; every other character of the
// formula is kept as written. A formula this tokenizer cannot read with
// certainty returns `null`, and the caller refuses the whole operation:
// external workbooks and structured references (`[`), open-ended ranges
// (`A2:A`), chained ranges (`A1:A2:A3`), an unterminated string or sheet name.

import { columnIndex, columnLetters } from './a1'

const NAME_CHAR = /[\p{L}\p{N}_.]/u
const NAME_RUN = /^[\p{L}\p{N}_.]+/u
const NUMBER = /^\d+(\.\d+)?([eE][+-]?\d+)?/
const ERROR_LITERAL = /^#[A-Za-z0-9_/]*[!?]?/
// Unquoted sheet name followed by `!`. Anything that could be an operator ends it.
const UNQUOTED_SHEET = /^[^\s'"!(),;:+\-*/^&=<>{}%#[\]@~]+!/

const CELL_RANGE = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?::(\$?)([A-Za-z]{1,3})(\$?)(\d+))?/
const COLUMN_RANGE = /^(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})/
const ROW_RANGE = /^(\$?)(\d+):(\$?)(\d+)/

interface Part {
  absolute: boolean
  value: number // 0-based
}

function shift(part: Part, delta: number): number {
  return part.absolute ? part.value : part.value + delta
}

function col(abs: string, letters: string): Part {
  return { absolute: abs === '$', value: columnIndex(letters) as number }
}

function row(abs: string, digits: string): Part {
  return { absolute: abs === '$', value: Number(digits) - 1 }
}

function writeCell(c: Part, cv: number, r: Part, rv: number): string {
  return `${c.absolute ? '$' : ''}${columnLetters(cv)}${r.absolute ? '$' : ''}${rv + 1}`
}

/** Next char after a reference must not continue a name, open a call or a sheet name. */
function endsCleanly(rest: string): boolean {
  const next = rest[0]
  if (next === undefined) return true
  return !NAME_CHAR.test(next) && next !== '(' && next !== '!' && next !== ':' && next !== '$'
}

type RefMatch = { length: number; text: string } | 'none' | 'unsupported'

/** A reference at the start of `rest`, moved by (dCol, dRow). */
function matchReference(rest: string, dCol: number, dRow: number): RefMatch {
  const cell = CELL_RANGE.exec(rest)
  if (cell) {
    const [whole, ca1 = '', cl1 = '', ra1 = '', rd1 = '', ca2, cl2, ra2, rd2] = cell
    const after = rest.slice(whole.length)
    if (cl2 === undefined && after[0] === ':') return 'unsupported' // A2:A, A1:A2:A3, A1:Sheet!B2
    if (cl2 !== undefined && after[0] === ':') return 'unsupported'
    if (!endsCleanly(after)) return 'none'
    const c1 = col(ca1, cl1)
    const r1 = row(ra1, rd1)
    if (cl2 === undefined || rd2 === undefined) {
      const cv = shift(c1, dCol)
      const rv = shift(r1, dRow)
      if (cv === c1.value && rv === r1.value) return { length: whole.length, text: whole }
      return { length: whole.length, text: cv < 0 || rv < 0 ? '#REF!' : writeCell(c1, cv, r1, rv) }
    }
    const c2 = col(ca2 ?? '', cl2)
    const r2 = row(ra2 ?? '', rd2)
    const v = [shift(c1, dCol), shift(r1, dRow), shift(c2, dCol), shift(r2, dRow)] as const
    if (v[0] === c1.value && v[1] === r1.value && v[2] === c2.value && v[3] === r2.value) return { length: whole.length, text: whole }
    if (v.some((n) => n < 0)) return { length: whole.length, text: '#REF!' }
    return { length: whole.length, text: `${writeCell(c1, v[0], r1, v[1])}:${writeCell(c2, v[2], r2, v[3])}` }
  }
  const cols = COLUMN_RANGE.exec(rest)
  if (cols) {
    const [whole, a1 = '', l1 = '', a2 = '', l2 = ''] = cols
    if (!endsCleanly(rest.slice(whole.length))) return 'none'
    const c1 = col(a1, l1)
    const c2 = col(a2, l2)
    const v1 = shift(c1, dCol)
    const v2 = shift(c2, dCol)
    if (v1 === c1.value && v2 === c2.value) return { length: whole.length, text: whole }
    if (v1 < 0 || v2 < 0) return { length: whole.length, text: '#REF!' }
    return { length: whole.length, text: `${a1}${columnLetters(v1)}:${a2}${columnLetters(v2)}` }
  }
  const rows = ROW_RANGE.exec(rest)
  if (rows) {
    const [whole, a1 = '', d1 = '', a2 = '', d2 = ''] = rows
    if (!endsCleanly(rest.slice(whole.length))) return 'none'
    const r1 = row(a1, d1)
    const r2 = row(a2, d2)
    const v1 = shift(r1, dRow)
    const v2 = shift(r2, dRow)
    if (v1 === r1.value && v2 === r2.value) return { length: whole.length, text: whole }
    if (v1 < 0 || v2 < 0) return { length: whole.length, text: '#REF!' }
    return { length: whole.length, text: `${a1}${v1 + 1}:${a2}${v2 + 1}` }
  }
  return 'none'
}

/**
 * `formula` (starting with `=`) as it reads when its cell moves by `dCol`
 * columns and `dRow` rows. `null` when the formula holds anything this
 * tokenizer does not read with certainty.
 */
export function offsetFormula(formula: string, dCol: number, dRow: number): string | null {
  if (!formula.startsWith('=')) return null
  let i = 1
  let out = '='
  const s = formula
  while (i < s.length) {
    const ch = s[i] as string
    const rest = s.slice(i)
    const prev = s[i - 1] ?? ''
    if (ch === '"') {
      let j = i + 1
      for (;;) {
        if (j >= s.length) return null
        if (s[j] === '"') {
          if (s[j + 1] === '"') {
            j += 2
            continue
          }
          break
        }
        j++
      }
      out += s.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (ch === '[') return null
    if (ch === '#') {
      // A spill operator right after a reference (A2#) or an error literal (#REF!).
      const literal = /[A-Za-z0-9)]/.test(prev) ? '#' : (ERROR_LITERAL.exec(rest)?.[0] ?? '#')
      out += literal
      i += literal.length
      continue
    }
    if (ch === "'") {
      let j = i + 1
      for (;;) {
        if (j >= s.length) return null
        if (s[j] === "'") {
          if (s[j + 1] === "'") {
            j += 2
            continue
          }
          break
        }
        j++
      }
      if (s[j + 1] !== '!') return null
      const prefix = s.slice(i, j + 2)
      const ref = matchReference(s.slice(j + 2), dCol, dRow)
      if (ref === 'unsupported' || ref === 'none') return null
      out += ref.text === '#REF!' ? '#REF!' : prefix + ref.text
      i = j + 2 + ref.length
      continue
    }
    if (NAME_CHAR.test(ch) || ch === '$') {
      if (NAME_CHAR.test(prev) || prev === '$') {
        // Inside a name already being copied: cannot happen, names are copied whole.
        out += ch
        i++
        continue
      }
      const sheet = UNQUOTED_SHEET.exec(rest)
      if (sheet) {
        const ref = matchReference(rest.slice(sheet[0].length), dCol, dRow)
        if (ref === 'unsupported') return null
        if (ref === 'none') {
          // A sheet-scoped defined name (Sheet1!Name): copied as it is.
          const name = NAME_RUN.exec(rest.slice(sheet[0].length))?.[0] ?? ''
          out += sheet[0] + name
          i += sheet[0].length + name.length
          continue
        }
        out += ref.text === '#REF!' ? '#REF!' : sheet[0] + ref.text
        i += sheet[0].length + ref.length
        continue
      }
      const ref = matchReference(rest, dCol, dRow)
      if (ref === 'unsupported') return null
      if (ref !== 'none') {
        out += ref.text
        i += ref.length
        continue
      }
      if (ch === '$') return null
      // Not a reference: a number, a function or defined name, TRUE / FALSE. Copied whole.
      const token = (/\d/.test(ch) ? NUMBER.exec(rest)?.[0] : undefined) ?? NAME_RUN.exec(rest)?.[0] ?? ch
      out += token
      i += token.length
      continue
    }
    out += ch
    i++
  }
  return out
}
