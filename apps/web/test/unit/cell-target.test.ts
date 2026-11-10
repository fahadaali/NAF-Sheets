import { describe, expect, it } from 'vitest'
import { columnIndex, columnLetters, isCellRange, parseA1Range, rangeToA1 } from '../../src/lib/cell-target'

describe('columnLetters / columnIndex', () => {
  it('converts both ways, past Z and ZZ', () => {
    const pairs: Array<[number, string]> = [
      [0, 'A'],
      [25, 'Z'],
      [26, 'AA'],
      [51, 'AZ'],
      [701, 'ZZ'],
      [702, 'AAA'],
      [18_277, 'ZZZ'],
    ]
    for (const [index, letters] of pairs) {
      expect(columnLetters(index)).toBe(letters)
      expect(columnIndex(letters)).toBe(index)
    }
  })

  it('refuses lower case, digits and more than three letters', () => {
    for (const bad of ['a', 'A1', '', 'AAAA', 'ب']) expect(columnIndex(bad), bad).toBeNull()
  })
})

describe('rangeToA1 / parseA1Range', () => {
  it('writes a single cell without a colon and a block with one', () => {
    expect(rangeToA1({ startRow: 3, startColumn: 1, endRow: 3, endColumn: 1 })).toBe('B4')
    expect(rangeToA1({ startRow: 3, startColumn: 1, endRow: 9, endColumn: 2 })).toBe('B4:C10')
  })

  it('round-trips', () => {
    for (const a1 of ['A1', 'B4:C10', 'AA100:AB200', 'ZZZ9999999']) {
      const range = parseA1Range(a1)
      expect(range, a1).not.toBeNull()
      expect(rangeToA1(range!)).toBe(a1)
    }
  })

  it('normalises a reversed pair', () => {
    expect(parseA1Range('C10:B4')).toEqual({ startRow: 3, startColumn: 1, endRow: 9, endColumn: 2 })
  })

  it('refuses sheet names, absolute refs, lower case, row 0, whole columns and junk', () => {
    for (const bad of ["'المهام'!B4", '$B$4', 'b4', 'A0', 'B', '4', 'B4:C', 'A1:B2:C3', 'A12345678', '', ' B4']) {
      expect(parseA1Range(bad), bad).toBeNull()
    }
  })
})

describe('isCellRange', () => {
  it('accepts a 0-based inclusive range, with extra Univer fields', () => {
    expect(isCellRange({ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 })).toBe(true)
    expect(isCellRange({ startRow: 1, startColumn: 2, endRow: 3, endColumn: 4, rangeType: 0 })).toBe(true)
  })

  it('refuses inverted, negative, fractional or missing corners', () => {
    expect(isCellRange({ startRow: 2, startColumn: 0, endRow: 1, endColumn: 0 })).toBe(false)
    expect(isCellRange({ startRow: -1, startColumn: 0, endRow: 1, endColumn: 0 })).toBe(false)
    expect(isCellRange({ startRow: 0.5, startColumn: 0, endRow: 1, endColumn: 0 })).toBe(false)
    expect(isCellRange({ startRow: 0, startColumn: 0, endRow: 1 })).toBe(false)
    expect(isCellRange(null)).toBe(false)
    expect(isCellRange('A1')).toBe(false)
  })
})
