// Token → colour mapping of src/formula-colours.ts, with Univer's real lexer
// (LexerTreeBuilder of the installed @univerjs/engine-formula), plus its
// static contract. The painted result in the cell editor, the formula bar and
// the grid outlines is checked in the browser by test/rtl-interactions.mjs.
import { LexerTreeBuilder } from '@univerjs/engine-formula'
import { describe, expect, it } from 'vitest'
import {
  EXCEL_OUTLINE_WIDGETS, checkFormulaColourContract, checkLexerSemantics, formulaTextRuns, parenColour, planFormulaColours, sameOutlineRange, withAlpha,
} from '../src/index'
import type { FormulaContext, FormulaPalette } from '../src/index'

// Excel's sequence (apps/web/OPEN_QUESTIONS.md F1–F4). Here only as test data:
// the application reads it from apps/web/src/styles/theme.css.
const EXCEL = ['#326AC7', '#C0353E', '#8157B7', '#007C20', '#B03E84', '#B64900', '#267392']
const palette: FormulaPalette = {
  references: EXCEL,
  plain: '#plain',
  function: '#function',
  sheet: '#sheet',
  string: '#string',
  number: '#number',
  boolean: '#boolean',
  comparison: '#comparison',
  operator: '#operator',
  error: '#error',
}
const lexer = new LexerTreeBuilder()
const ctx: FormulaContext = { currentSheet: 'ملخص', editingSheet: 'ملخص', isDefinedName: (n) => n.toLowerCase() === 'rate' }

/** `[text, colour]` pairs of a formula (without `=`), merged per colour run. */
function colours(formula: string, context: FormulaContext = ctx) {
  const plan = planFormulaColours(formula, lexer.sequenceNodesBuilder(formula) ?? [], palette, context)
  if (!plan) throw new Error('no plan')
  const out: Array<[string, string]> = []
  for (const s of plan.spans) {
    const text = formula.slice(s.start, s.end)
    const last = out[out.length - 1]
    if (last && last[1] === s.colour) last[0] += text
    else out.push([text, s.colour])
  }
  return { out, plan, of: (text: string) => out.find(([t]) => t === text)?.[1] }
}

describe('Excel reference colours', () => {
  it('follow Excel\'s fixed sequence, left to right by first appearance, and wrap after seven', () => {
    const refs = ['A1', 'B1', 'C1', 'D1', 'E1', 'F1', 'G1', 'H1', 'I1']
    const { plan } = colours(refs.join('+'))
    expect(plan.references.map((r) => r.colour)).toEqual([...EXCEL, EXCEL[0], EXCEL[1]])
    expect(plan.references.map((r) => r.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('a repeated reference keeps the colour of its first mention and takes no new colour', () => {
    const { plan } = colours('A1+B2*A1-B2+C3')
    expect(plan.references.map((r) => [r.token, r.colour])).toEqual([
      ['A1', EXCEL[0]], ['B2', EXCEL[1]], ['A1', EXCEL[0]], ['B2', EXCEL[1]], ['C3', EXCEL[2]],
    ])
  })

  it('the same range written differently ($A$1, A1, B2:A1 / A1:B2) is the same reference', () => {
    const { plan } = colours('A1+$A$1+A$1+SUM(A1:B2,B2:A1)')
    const c = plan.references.map((r) => r.colour)
    expect(c).toEqual([EXCEL[0], EXCEL[0], EXCEL[0], EXCEL[1], EXCEL[1]])
  })

  it('an explicit reference to the sheet shown is coloured, the sheet name in its own colour', () => {
    const { out } = colours("SUM('ملخص'!A1,A1)")
    expect(out).toEqual([
      ['SUM', '#function'], ['(', '#plain'], ["'ملخص'!", '#sheet'], ['A1', EXCEL[0]], [',', '#plain'], ['A1', EXCEL[0]], [')', '#plain'],
    ])
  })

  it('a reference to another sheet is not coloured (Excel 2021+) and takes no colour of the sequence', () => {
    const { out, plan } = colours("'المهام'!A2+B1")
    expect(out).toEqual([["'المهام'!", '#sheet'], ['A2', '#plain'], ['+', '#operator'], ['B1', EXCEL[0]]])
    expect(plan.references[0]).toMatchObject({ colour: null, slot: null, sheetName: 'المهام' })
  })

  it('while the user shows another sheet, its references are coloured and unqualified ones are not', () => {
    const { plan } = colours("'المهام'!A2+B1", { currentSheet: 'المهام', editingSheet: 'ملخص' })
    expect(plan.references.map((r) => r.colour)).toEqual([EXCEL[0], null])
  })

  it('whole columns and rows are references like any other', () => {
    const { plan, of } = colours('SUM(A:A,1:1)')
    expect(plan.references.map((r) => r.colour)).toEqual([EXCEL[0], EXCEL[1]])
    expect(of('A:A')).toBe(EXCEL[0])
    expect(plan.references[0]!.range).toEqual({ startRow: null, endRow: null, startColumn: 0, endColumn: 0 })
  })

  it('a named range takes the next colour of the sequence, like a reference', () => {
    const { of } = colours('A1*rate+B1')
    expect([of('A1'), of('rate'), of('B1')]).toEqual([EXCEL[0], EXCEL[1], EXCEL[2]])
  })
})

describe('parentheses', () => {
  it('the outermost pair is plain (black); nested pairs follow the sequence from its second colour', () => {
    expect([0, 1, 2, 3, 6, 7, 8].map((d) => parenColour(d, palette))).toEqual(['#plain', EXCEL[1], EXCEL[2], EXCEL[3], EXCEL[6], EXCEL[0], EXCEL[1]])
  })

  it('both parentheses of a pair share one colour', () => {
    const formula = 'IF(AND(A1>(1),B1),1,0)'
    const { plan } = colours(formula)
    const parens = plan.spans.filter((s) => s.kind === 'paren').map((s) => [formula[s.start], s.colour])
    expect(parens).toEqual([['(', '#plain'], ['(', EXCEL[1]], ['(', EXCEL[2]], [')', EXCEL[2]], [')', EXCEL[1]], [')', '#plain']])
  })
})

describe('extra categories (owner, 2026-11-11)', () => {
  it('function, string, number, boolean, comparison, operator and error each get their own colour', () => {
    const { of } = colours('IF(A1>=10,"نعم",FALSE)&B1<>#REF!+-3%')
    expect(of('IF')).toBe('#function')
    expect(of('>=')).toBe('#comparison')
    expect(of('10')).toBe('#number')
    expect(of('"نعم"')).toBe('#string')
    expect(of('FALSE')).toBe('#boolean')
    expect(of('&')).toBe('#operator')
    expect(of('<>')).toBe('#comparison')
    expect(of('#REF!')).toBe('#error')
  })

  it('TRUE() and FALSE() called as functions are functions', () => {
    expect(colours('TRUE()').of('TRUE')).toBe('#function')
  })

  it('an unknown name still being typed stays plain, as in Excel', () => {
    expect(colours('SU').out).toEqual([['SU', '#plain']])
  })

  it('array constants: numbers, strings, booleans and errors inside, braces and separators plain', () => {
    const { out } = colours('{1,"a";TRUE,#N/A}')
    expect(out).toEqual([['{', '#plain'], ['1', '#number'], [',', '#plain'], ['"a"', '#string'], [';', '#plain'], ['TRUE', '#boolean'], [',', '#plain'], ['#N/A', '#error'], ['}', '#plain']])
  })

  it('every character is covered exactly once', () => {
    const formula = "IFERROR(VLOOKUP(A2,'المهام'!A:B,2,FALSE),\"—\")"
    const { plan } = colours(formula)
    let at = 0
    for (const s of plan.spans) {
      expect(s.start).toBe(at)
      at = s.end
    }
    expect(at).toBe(formula.length)
  })

  it('nodes that do not spell out the text (a changed lexer) give no plan', () => {
    expect(planFormulaColours('A1+B1', ['A1', '+'], palette, ctx)).toBeNull()
  })
})

describe('text runs for the editor document', () => {
  it('keep Univer\'s other text style, colour the leading = plain, and merge equal neighbours', () => {
    const formula = 'SUM(A1)'
    const plan = colours(formula).plan
    const base = [{ st: 0, ed: 1, ts: { fs: 11 } }, { st: 1, ed: 8, ts: { fs: 11, cl: { rgb: '#000000' } } }]
    const runs = formulaTextRuns(plan, base, palette)
    expect(runs).toEqual([
      { st: 0, ed: 1, ts: { fs: 11, cl: { rgb: '#plain' } } },
      { st: 1, ed: 4, ts: { fs: 11, cl: { rgb: '#function' } } },
      { st: 4, ed: 5, ts: { fs: 11, cl: { rgb: '#plain' } } },
      { st: 5, ed: 7, ts: { fs: 11, cl: { rgb: EXCEL[0] } } },
      { st: 7, ed: 8, ts: { fs: 11, cl: { rgb: '#plain' } } },
    ])
  })
})

describe('outlines', () => {
  it('Excel\'s fill is the colour at 10 % (#326AC7 over white is #EBF0F9)', () => {
    expect(withAlpha('#326AC7', 0.1)).toBe('rgba(50, 106, 199, 0.1)')
    const over = (c: number) => Math.round(255 - 0.1 * (255 - c))
    expect([50, 106, 199].map(over).map((v) => v.toString(16)).join('')).toBe('ebf0f9')
  })

  it('handles only at the four corners', () => {
    expect(Object.entries(EXCEL_OUTLINE_WIDGETS).filter(([, on]) => on).map(([k]) => k)).toEqual(['tl', 'tr', 'bl', 'br'])
  })

  it('an outline matches the planned range; an unbounded side matches whatever Univer extended it to', () => {
    expect(sameOutlineRange({ startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 }, { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 })).toBe(true)
    expect(sameOutlineRange({ startRow: null, endRow: null, startColumn: 0, endColumn: 0 }, { startRow: 0, endRow: 999, startColumn: 0, endColumn: 0 })).toBe(true)
    expect(sameOutlineRange({ startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 }, { startRow: 0, endRow: 0, startColumn: 1, endColumn: 1 })).toBe(false)
  })
})

describe('contract (installed Univer)', () => {
  it('every hooked export and internal is present', () => {
    expect(checkFormulaColourContract()).toEqual([])
  })

  it('the installed lexer classifies tokens as the plan expects', () => {
    expect(checkLexerSemantics(lexer as never)).toEqual([])
  })

  it('a lexer that classifies differently is reported', () => {
    const changed = { sequenceNodesBuilder: (f: string) => [f] }
    expect(checkLexerSemantics(changed)[0]).toMatch(/token types changed/)
  })
})
