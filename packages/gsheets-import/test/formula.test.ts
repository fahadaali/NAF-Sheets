import { describe, expect, it } from 'vitest'
import { extractFunctionCalls, extractFunctionNames, findUnsupportedFunctions, normalizeConditionFormula, UNIVER_SUPPORTED_FUNCTIONS } from '../src/formula'

describe('extractFunctionNames', () => {
  it('finds nested calls in order, upper-cased, once each', () => {
    expect(extractFunctionNames('=IFERROR(vlookup(A2,Sheet2!A:B,2,FALSE),SUM(B1:B3)+sum(C1))')).toEqual(['IFERROR', 'VLOOKUP', 'SUM'])
  })

  it('ignores text in string literals and quoted sheet names', () => {
    expect(extractFunctionNames('=CONCAT("SUM(", \'IMPORTRANGE(x)\'!A1, "x""GOOGLEFINANCE(""")')).toEqual(['CONCAT'])
  })

  it('reads dotted names, Arabic sheet names and spaces before the parenthesis', () => {
    expect(extractFunctionNames("=NORM.DIST('المهام'!B2, 0, 1, TRUE) + SUM ('الملخص'!A1:A3)")).toEqual(['NORM.DIST', 'SUM'])
  })

  it('does not take references or named ranges for calls', () => {
    expect(extractFunctionNames('=Costs*Sheet1!A1+$B$2')).toEqual([])
  })

  it('skips structured references', () => {
    expect(extractFunctionNames('=SUM(Table1[Amount(SAR)])')).toEqual(['SUM'])
  })
})

describe('extractFunctionCalls argument counts', () => {
  it('counts top-level arguments only', () => {
    expect(extractFunctionCalls('=FILTER(A2:B9, A2:A9>5, IF(C2:C9="x",1,0))')).toEqual([
      { name: 'FILTER', args: 3 },
      { name: 'IF', args: 3 },
    ])
  })

  it('treats commas and semicolons inside array literals as part of one argument', () => {
    expect(extractFunctionCalls('=SORT({1,2;3,4}, 2)')).toEqual([{ name: 'SORT', args: 2 }])
  })

  it('counts zero arguments and empty arguments', () => {
    expect(extractFunctionCalls('=TODAY()')).toEqual([{ name: 'TODAY', args: 0 }])
    expect(extractFunctionCalls('=IF(A1,,"x")')).toEqual([{ name: 'IF', args: 3 }])
  })
})

describe('findUnsupportedFunctions', () => {
  it('flags the spec §7.2 examples', () => {
    expect(findUnsupportedFunctions('=IMPORTRANGE("url","A1")')).toEqual(['IMPORTRANGE'])
    expect(findUnsupportedFunctions('=GOOGLEFINANCE("TADAWUL:2222")')).toEqual(['GOOGLEFINANCE'])
    expect(findUnsupportedFunctions('=SPARKLINE(A1:A9)')).toEqual(['SPARKLINE'])
    // Univer implements an IMAGE, but with Excel's arguments: always value-only (spec §7.2).
    expect(UNIVER_SUPPORTED_FUNCTIONS.has('IMAGE')).toBe(true)
    expect(findUnsupportedFunctions('=IMAGE("https://naflaw.sa/logo.png")')).toEqual(['IMAGE'])
  })

  it('flags other Google-only functions and keeps common ones', () => {
    expect(findUnsupportedFunctions('=ARRAYFORMULA(QUERY(A:B,"select A"))')).toEqual(['ARRAYFORMULA', 'QUERY'])
    expect(findUnsupportedFunctions("=SUM('المهام'!H2:H6)+COUNTIF(F2:F6,\"منجز\")+XLOOKUP(1,A:A,B:B)")).toEqual([])
  })

  it('flags FILTER and SORT called with Google-only arguments', () => {
    expect(findUnsupportedFunctions('=FILTER(A2:A9, B2:B9="x")')).toEqual([])
    expect(findUnsupportedFunctions('=FILTER(A2:A9, B2:B9="x", C2:C9>5)')).toEqual(['FILTER'])
    expect(findUnsupportedFunctions('=SORT(A2:B9, 2)')).toEqual([])
    expect(findUnsupportedFunctions('=SORT(A2:B9, 2, FALSE)')).toEqual(['SORT'])
  })

  it('flags a called LET/LAMBDA binding (the scan does not resolve bindings)', () => {
    expect(findUnsupportedFunctions('=LET(f, LAMBDA(x, x*2), f(3))')).toEqual(['F'])
  })

  it('uses the supported set it is given', () => {
    expect(findUnsupportedFunctions('=MYFUNC(1)+SUM(2)', new Set(['MYFUNC', 'SUM']))).toEqual([])
  })
})

describe('normalizeConditionFormula', () => {
  it('accepts = and + prefixes and rejects literals', () => {
    expect(normalizeConditionFormula('=$F2="منجز"')).toBe('=$F2="منجز"')
    expect(normalizeConditionFormula(' +A1>5')).toBe('=A1>5')
    expect(normalizeConditionFormula('منجز')).toBeNull()
  })
})
