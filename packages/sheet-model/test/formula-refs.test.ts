// offsetFormula against Univer 1.4.0's own LexerTreeBuilder.moveFormulaRefOffset
// (engine-formula), which Univer's sort uses for formulas in reordered rows.

import { LexerTreeBuilder } from '@univerjs/engine-formula'
import { describe, expect, it } from 'vitest'
import { offsetFormula } from '../src'

describe('offsetFormula', () => {
  it('shifts relative parts and keeps absolute ones', () => {
    expect(offsetFormula('=A1+B2', 0, 2)).toBe('=A3+B4')
    expect(offsetFormula('=SUM($A$1:B2)', 0, 2)).toBe('=SUM($A$1:B4)')
    expect(offsetFormula('=SUM(A$2:$B3)', 0, 2)).toBe('=SUM(A$2:$B5)')
    expect(offsetFormula('=$A1*A$1', 1, 1)).toBe('=$A2*B$1')
    expect(offsetFormula('=1:1', 0, 2)).toBe('=3:3')
    expect(offsetFormula('=A:A', 0, 5)).toBe('=A:A')
    expect(offsetFormula('=SUM(A:B)', 2, 0)).toBe('=SUM(C:D)')
  })

  it('keeps everything that is not a reference as written', () => {
    expect(offsetFormula('="A1"&B1', 0, 2)).toBe('="A1"&B3')
    expect(offsetFormula('=IF(E5="منجز",1,0)', 0, 2)).toBe('=IF(E7="منجز",1,0)')
    expect(offsetFormula('=LOG10(A1)', 0, 2)).toBe('=LOG10(A3)')
    expect(offsetFormula('=Name1+A1', 0, 2)).toBe('=Name1+A3')
    expect(offsetFormula('= A1 + 1', 0, 2)).toBe('= A3 + 1')
    expect(offsetFormula('={1,2;3,4}', 0, 2)).toBe('={1,2;3,4}')
    expect(offsetFormula('=R1C1', 0, 2)).toBe('=R1C1')
    expect(offsetFormula('=TRUE()+2E10', 0, 2)).toBe('=TRUE()+2E10')
    expect(offsetFormula('=#REF!+A1', 0, 2)).toBe('=#REF!+A3')
    expect(offsetFormula('=IFERROR(A1,#N/A)', 0, 1)).toBe('=IFERROR(A2,#N/A)')
    expect(offsetFormula('=A2#', 0, 2)).toBe('=A4#')
    expect(offsetFormula('=TODAY()-D2', 0, 3)).toBe('=TODAY()-D5')
  })

  it('shifts sheet-qualified references, quoted or not, and keeps sheet-scoped names', () => {
    expect(offsetFormula("='المهام'!A5*2", 0, 2)).toBe("='المهام'!A7*2")
    expect(offsetFormula("='It''s'!B2", 0, 2)).toBe("='It''s'!B4")
    expect(offsetFormula('=المهام!A5', 0, -1)).toBe('=المهام!A4')
    expect(offsetFormula('=Sheet1!A1:B2', 0, 1)).toBe('=Sheet1!A2:B3')
    expect(offsetFormula('=Sheet1!Total+A1', 0, 1)).toBe('=Sheet1!Total+A2')
  })

  it('turns a reference pushed off the grid into #REF!', () => {
    expect(offsetFormula('=A1+B2', 0, -1)).toBe('=#REF!+B1')
    expect(offsetFormula('=Sheet1!A1', 0, -1)).toBe('=#REF!')
    expect(offsetFormula('=SUM(A1:A3)', 0, -1)).toBe('=SUM(#REF!)')
  })

  it('refuses what it cannot read with certainty', () => {
    expect(offsetFormula('=[Book1]Sheet1!A1', 0, 1)).toBeNull()
    expect(offsetFormula('=SUM(A2:A)', 0, 1)).toBeNull()
    expect(offsetFormula('=A1:A2:A3', 0, 1)).toBeNull()
    expect(offsetFormula('="open', 0, 1)).toBeNull()
    expect(offsetFormula("='open!A1", 0, 1)).toBeNull()
    expect(offsetFormula('=Table1[Col]', 0, 1)).toBeNull()
    expect(offsetFormula('A1', 0, 1)).toBeNull()
  })

  // Univer rewrites whitespace around operators and drops quotes around simple
  // sheet names; compare without those.
  const normalise = (f: string): string => f.replace(/\s+/g, '').replace(/'([\p{L}\p{N}_]+)'!/gu, '$1!')
  const corpus = [
    '=A1+B2',
    '=SUM($A$1:B2)',
    '=SUM(A$2:$B3)',
    '=$A1*A$1',
    '=A:A',
    '=1:1',
    '=SUM(A:B)',
    '="A1"&B1',
    '=IF(E5="منجز",1,0)',
    '=LOG10(A1)',
    '=Name1+A1',
    '=TODAY()-D2',
    '=COUNTIF(\'المهام\'!E2:E20,"منجز")',
    "='It''s'!B2",
    '=VLOOKUP(A2,$H$2:$J$100,3,FALSE)',
    '=IF(AND(D5<>"",D5<TODAY()),"متأخر","")',
    '=A2#',
    '=SUMPRODUCT((B2:B9="سارة")*(E2:E9=TRUE))',
    '=#REF!+A1',
  ]
  const offsets: Array<[number, number]> = [
    [0, 2],
    [0, -1],
    [3, 0],
    [-1, 4],
  ]

  it.each(corpus)('matches Univer for %s', (formula) => {
    const lexer = new LexerTreeBuilder()
    for (const [dc, dr] of offsets) {
      const ours = offsetFormula(formula, dc, dr)
      expect(ours).not.toBeNull()
      expect(normalise(ours as string)).toBe(normalise(lexer.moveFormulaRefOffset(formula, dc, dr)))
    }
  })
})
