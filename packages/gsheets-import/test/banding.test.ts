import { describe, expect, it } from 'vitest'
import { bandedFills } from '../src/banding'
import { ColorResolver } from '../src/color'
import { convertSpreadsheet } from '../src'
import { cellOf, oneSheet, str, styleOf } from './helpers/build'

const H = { red: 1 } // #ff0000
const A = { green: 1 } // #00ff00
const B = { blue: 1 } // #0000ff
const F = { red: 1, green: 1 } // #ffff00
const colors = new ColorResolver(undefined)
const range = { startRow: 0, endRow: 4, startColumn: 0, endColumn: 1 }

describe('banded ranges → static fills', () => {
  it('alternates first/second band after the header, and ends with the footer', () => {
    const fills = bandedFills(range, { headerColor: H, firstBandColor: A, secondBandColor: B, footerColor: F }, undefined, colors)
    if (fills === 'unresolved') throw new Error('unexpected')
    expect([0, 1, 2, 3, 4].map((r) => fills.get(`${r}:0`))).toEqual(['#ff0000', '#00ff00', '#0000ff', '#00ff00', '#ffff00'])
  })

  it('alternates from the first row without a header', () => {
    const fills = bandedFills(range, { firstBandColorStyle: { rgbColor: A }, secondBandColorStyle: { rgbColor: B } }, undefined, colors)
    if (fills === 'unresolved') throw new Error('unexpected')
    expect([0, 1, 2].map((r) => fills.get(`${r}:1`))).toEqual(['#00ff00', '#0000ff', '#00ff00'])
  })

  it('applies the documented row/column priority', () => {
    // Columns: header colour on column 0, bands on column 1. Rows: bands only.
    const fills = bandedFills(range, { firstBandColor: A, secondBandColor: B }, { headerColor: H, firstBandColor: F, secondBandColor: F }, colors)
    if (fills === 'unresolved') throw new Error('unexpected')
    // Column header beats the row's first band.
    expect(fills.get('0:0')).toBe('#ff0000')
    // Row first band beats column first band.
    expect(fills.get('0:1')).toBe('#00ff00')
    // Column first band beats row second band.
    expect(fills.get('1:1')).toBe('#ffff00')
  })

  it('reports a band whose theme colour cannot be resolved', () => {
    expect(bandedFills(range, { firstBandColorStyle: { themeColor: 'ACCENT2' }, secondBandColor: B }, undefined, new ColorResolver(undefined))).toBe('unresolved')
  })

  it('fills cells without their own background and reports the conversion', () => {
    const { workbook, report } = convertSpreadsheet(
      oneSheet([[str('أ', { userEnteredFormat: { backgroundColor: F } })], [str('ب')], []], {
        bandedRanges: [{ bandedRangeId: 1, range: { sheetId: 0, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 1 }, rowProperties: { firstBandColor: A, secondBandColor: B } }],
      }),
    )
    expect(styleOf(workbook, cellOf(workbook, 'sheet-0', 0, 0))?.bg).toEqual({ rgb: '#ffff00' }) // own fill wins (OPEN §5)
    expect(styleOf(workbook, cellOf(workbook, 'sheet-0', 1, 0))?.bg).toEqual({ rgb: '#0000ff' })
    expect(styleOf(workbook, cellOf(workbook, 'sheet-0', 2, 0))?.bg).toEqual({ rgb: '#00ff00' }) // a cell with no data gets a style-only cell
    expect(report.items).toEqual([expect.objectContaining({ kind: 'banded_range', outcome: 'converted', location: expect.objectContaining({ ref: "'ورقة1'!A1:A3" }) })])
  })
})
