import { describe, expect, it } from 'vitest'
import { a1Range, absoluteA1Range, cellsToRanges, columnLetters, gridRangeToRange, quoteSheetName, sheetRef } from '../src/a1'

describe('A1 notation', () => {
  it('names columns like the spreadsheet', () => {
    expect([0, 25, 26, 51, 52, 701, 702].map(columnLetters)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA'])
  })

  it('writes single cells and ranges', () => {
    expect(a1Range({ startRow: 3, startColumn: 1, endRow: 3, endColumn: 1 })).toBe('B4')
    expect(a1Range({ startRow: 3, startColumn: 1, endRow: 9, endColumn: 2 })).toBe('B4:C10')
    expect(absoluteA1Range({ startRow: 1, startColumn: 7, endRow: 5, endColumn: 7 })).toBe('$H$2:$H$6')
  })

  it('always quotes sheet names and doubles quotes inside them', () => {
    expect(quoteSheetName('المهام')).toBe("'المهام'")
    expect(quoteSheetName("خطة 'أ'")).toBe("'خطة ''أ'''")
    expect(sheetRef('المهام', { startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 })).toBe("'المهام'!A1")
  })
})

describe('GridRange → IRange', () => {
  const size = { rowCount: 100, columnCount: 26 }

  it('turns half-open Google ranges into inclusive Univer ranges', () => {
    // Google: Sheet1!A3:B4 == startRowIndex 2, endRowIndex 4, startColumnIndex 0, endColumnIndex 2.
    expect(gridRangeToRange({ startRowIndex: 2, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 2 }, size)).toEqual({
      startRow: 2,
      endRow: 3,
      startColumn: 0,
      endColumn: 1,
    })
  })

  it('bounds unbounded sides by the sheet size', () => {
    // Sheet1!A:B
    expect(gridRangeToRange({ startColumnIndex: 0, endColumnIndex: 2 }, size)).toEqual({ startRow: 0, endRow: 99, startColumn: 0, endColumn: 1 })
    // Sheet1 (whole sheet)
    expect(gridRangeToRange({ sheetId: 1 }, size)).toEqual({ startRow: 0, endRow: 99, startColumn: 0, endColumn: 25 })
  })

  it('returns null for an empty range', () => {
    expect(gridRangeToRange({ startRowIndex: 3, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 1 }, size)).toBeNull()
    expect(gridRangeToRange(undefined, size)).toBeNull()
  })
})

describe('cellsToRanges', () => {
  it('merges a column of cells into one range', () => {
    expect(cellsToRanges([[1, 5], [2, 5], [3, 5], [4, 5], [5, 5]])).toEqual([{ startRow: 1, endRow: 5, startColumn: 5, endColumn: 5 }])
  })

  it('merges a rectangle and keeps separate blocks apart', () => {
    const cells: Array<[number, number]> = [
      [0, 0], [0, 1], [1, 0], [1, 1], // A1:B2
      [4, 0], // A5
      [0, 3], // D1
    ]
    expect(cellsToRanges(cells)).toEqual([
      { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 },
      { startRow: 0, endRow: 0, startColumn: 3, endColumn: 3 },
      { startRow: 4, endRow: 4, startColumn: 0, endColumn: 0 },
    ])
  })

  it('does not merge runs across a gap row', () => {
    expect(cellsToRanges([[0, 0], [2, 0]])).toEqual([
      { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
      { startRow: 2, endRow: 2, startColumn: 0, endColumn: 0 },
    ])
  })
})
