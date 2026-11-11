// Pure pieces: formulas (shared, prefixes, Google's wrapper, blockers),
// colours (theme, tint, indexed), number formats, sizes, origin detection.

import { describe, expect, it } from 'vitest'
import { applyTint, columnPixels, detectOrigin, formatType, formulaBlockers, numberFormatFor, rowPixels, shiftFormula, stripFuturePrefixes, unwrapGoogleDummy } from '../src'

describe('shared formulas', () => {
  it('moves relative references by the offset and keeps absolute ones', () => {
    expect(shiftFormula('D2*1.15', 1, 0)).toBe('D3*1.15')
    expect(shiftFormula('$A$1+B$2+$C3+D4', 2, 1)).toBe('$A$1+C$2+$C5+E6')
    expect(shiftFormula('SUM(A1:B2)', 3, 2)).toBe('SUM(C4:D5)')
    expect(shiftFormula("'My Sheet'!A1+Sheet2!B$1", 1, 1)).toBe("'My Sheet'!B2+Sheet2!C$1")
    expect(shiftFormula('SUM(A:A)+SUM(1:1)', 1, 1)).toBe('SUM(B:B)+SUM(2:2)')
  })

  it('leaves strings, function names and structured references alone', () => {
    expect(shiftFormula('IF(A1="B2",LOG10(A1),ATAN2(1,2))', 1, 0)).toBe('IF(A2="B2",LOG10(A2),ATAN2(1,2))')
    expect(shiftFormula('SUM(Table1[A1])+A1', 1, 0)).toBe('SUM(Table1[A1])+A2')
  })

  it('turns a reference moved off the sheet into #REF!', () => {
    expect(shiftFormula('A1', -1, 0)).toBe('#REF!')
    expect(shiftFormula('A1', 0, -1)).toBe('#REF!')
  })

  it('is the identity at the master cell (real Google export: «5. Control Switch» B5)', () => {
    const f = 'IF($A$2, "Replace this comment with your complex slow formula",)'
    expect(shiftFormula(f, 0, 0)).toBe(f)
    expect(shiftFormula(f, 5, 0)).toBe(f)
  })
})

describe('function prefixes', () => {
  it('removes storage prefixes but keeps _xludf. (unknown to Excel)', () => {
    expect(stripFuturePrefixes('_xlfn.XLOOKUP(1,A:A,B:B)+_xlfn._xlws.SORT(C1:C3)')).toBe('XLOOKUP(1,A:A,B:B)+SORT(C1:C3)')
    expect(stripFuturePrefixes('_xlfn.LET(_xlpm.x,1,_xlpm.x+1)')).toBe('LET(x,1,x+1)')
    expect(stripFuturePrefixes('"_xlfn.TEXT"&_xludf.MINE(1)')).toBe('"_xlfn.TEXT"&_xludf.MINE(1)')
  })
})

describe("Google's DUMMYFUNCTION wrapper (as in the real export «4. Dynamic Chart»)", () => {
  it('restores the original formula', () => {
    expect(unwrapGoogleDummy('IFERROR(__xludf.DUMMYFUNCTION("QUERY(A1:F6,""where F = TRUE"",1)"),"Customer")')).toEqual({
      kind: 'formula',
      formula: '=QUERY(A1:F6,"where F = TRUE",1)',
    })
    expect(unwrapGoogleDummy('__xludf.DUMMYFUNCTION("GOOGLEFINANCE(""NASDAQ:GOOG"")")')).toEqual({ kind: 'formula', formula: '=GOOGLEFINANCE("NASDAQ:GOOG")' })
  })

  it('recognises the cells of its spilled result', () => {
    expect(unwrapGoogleDummy('IFERROR(__xludf.DUMMYFUNCTION("""COMPUTED_VALUE"""),40651.0)')).toEqual({ kind: 'computed' })
  })

  it('leaves anything else as it is', () => {
    expect(unwrapGoogleDummy('IFERROR(A1,0)')).toBeNull()
    expect(unwrapGoogleDummy('IFERROR(__xludf.DUMMYFUNCTION("X()"),1)+1')).toBeNull()
  })
})

describe('formula blockers', () => {
  it('names structured references, links to other workbooks and spill references', () => {
    expect(formulaBlockers('SUM(Table1[المبلغ])')).toEqual(['Table1[…]'])
    expect(formulaBlockers('[1]Sheet1!$A$1+1')).toEqual(['[ملف خارجي]'])
    expect(formulaBlockers('SUM(A1#)')).toEqual(['#'])
    expect(formulaBlockers('SUM(A1:A3)&"[x]"')).toEqual([])
    expect(formulaBlockers('{1,2}')).toEqual([])
  })
})

describe('colours', () => {
  it('applies Excel tints in HLS (values Excel shows for the 2023 Office theme)', () => {
    expect(applyTint('#e97132', 0.79998168889431442)).toBe('#fbe3d6')
    expect(applyTint('#156082', -0.249977111117893)).toBe('#104862')
    expect(applyTint('#000000', 0.5)).toBe('#808080')
    expect(applyTint('#ffffff', -0.5)).toBe('#808080')
    expect(applyTint('#123456', 0)).toBe('#123456')
  })
})

describe('number formats', () => {
  it('maps built-in ids that have no <numFmt> entry', () => {
    expect(numberFormatFor(0, new Map())).toBeNull()
    expect(numberFormatFor(14, new Map())).toEqual({ type: 'DATE', pattern: 'yyyy-mm-dd' })
    expect(numberFormatFor(10, new Map())).toEqual({ type: 'PERCENT', pattern: '0.00%' })
    expect(numberFormatFor(22, new Map())).toEqual({ type: 'DATE_TIME', pattern: 'yyyy-mm-dd h:mm' })
    expect(numberFormatFor(49, new Map())).toEqual({ type: 'TEXT', pattern: '@' })
    // Locale-dependent: no code in the file → reported by the converter.
    expect(numberFormatFor(7, new Map())).toEqual({ type: 'CURRENCY' })
    expect(numberFormatFor(164, new Map([[164, 'General']]))).toBeNull()
  })

  it('classifies codes', () => {
    expect(formatType('m/d/yyyy')).toBe('DATE')
    expect(formatType('[$-F400]h:mm:ss AM/PM')).toBe('TIME')
    expect(formatType('"$"#,##0')).toBe('CURRENCY')
    expect(formatType('#,##0.00\\ "ر.س"')).toBe('NUMBER')
    expect(formatType('0.00E+00')).toBe('SCIENTIFIC')
    expect(formatType('[Red]#,##0')).toBe('NUMBER')
  })
})

describe('sizes', () => {
  it('Google export widths: (pixels + 1) / 8, checked on 13 real columns against Google’s htmlview', () => {
    const real: Array<[number, number]> = [
      [12.63, 100], [67.13, 536], [3.5, 27], [10.5, 83], [24.63, 196], [6.5, 51], [23.25, 185],
      [4.75, 37], [16.5, 131], [3.38, 26], [5.13, 40], [3.63, 28], [3.88, 30],
    ]
    for (const [chars, px] of real) expect(columnPixels(chars, 'google_export')).toBe(px)
  })

  it('Excel widths: ECMA-376 formula with a 7 px maximum digit width', () => {
    expect(columnPixels(9.140625, 'excel_like')).toBe(64)
    expect(columnPixels(30.7109375, 'excel_like')).toBe(215)
    expect(columnPixels(15.7109375, 'excel_like')).toBe(110)
  })

  it('row heights: points at 96 dpi', () => {
    expect(rowPixels(15.75)).toBe(21)
    expect(rowPixels(15)).toBe(20)
    expect(rowPixels(63)).toBe(84)
  })
})

describe('origin detection', () => {
  const none = { application: null, hasDocProps: false, workbookNamespaces: [], themeName: null, hasPersonsPart: false, googleDummyFunction: false }
  const mac = ['http://schemas.microsoft.com/office/mac/excel/2008/main', 'urn:schemas-microsoft-com:mac:vml']
  it('Excel names itself in docProps/app.xml', () => {
    expect(detectOrigin({ ...none, application: 'Microsoft Excel', hasDocProps: true }).kind).toBe('excel')
    expect(detectOrigin({ ...none, application: 'Microsoft Macintosh Excel', hasDocProps: true }).kind).toBe('excel')
  })
  it('other writers that name themselves are "other", even when they claim compatibility', () => {
    expect(detectOrigin({ ...none, application: 'Microsoft Excel Compatible / Openpyxl 3.1.5', hasDocProps: true })).toMatchObject({ kind: 'other', application: 'Microsoft Excel Compatible / Openpyxl 3.1.5' })
    expect(detectOrigin({ ...none, application: 'LibreOffice/24.2.7.2$Linux_X86_64', hasDocProps: true, googleDummyFunction: true }).kind).toBe('other')
  })
  it('Google: no docProps plus its namespaces / theme / persons part', () => {
    expect(detectOrigin({ ...none, workbookNamespaces: mac, hasPersonsPart: true }).kind).toBe('google_export')
    expect(detectOrigin({ ...none, themeName: 'Sheets' }).kind).toBe('google_export')
    expect(detectOrigin({ ...none, googleDummyFunction: true, hasDocProps: true }).kind).toBe('google_export')
  })
  it('a bare package with no signal is "other"', () => {
    expect(detectOrigin(none)).toMatchObject({ kind: 'other', application: null })
  })
})
