// Probes of Univer 1.4.0's list validation that the dropdown import relies on
// (apps/api OPEN_QUESTIONS.md "Google import" G32). Each expectation is a
// behaviour read in node_modules/@univerjs/sheets-data-validation and then
// confirmed here on the real engine; a Univer bump that changes one fails
// this file, and the import rule built on it must be re-checked.

import { DataValidationStatus, type IWorkbookData } from '@univerjs/core'
import { DataValidationListCacheService, SheetDataValidationModel, SheetsDataValidationValidatorService } from '@univerjs/sheets-data-validation'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadHeadless, type HeadlessUniver } from './helpers/headless-univer'

const rule = (uid: string, col: number, extra: Record<string, unknown>) => ({
  uid,
  type: 'list',
  ranges: [{ startRow: 1, endRow: 3, startColumn: col, endColumn: col }],
  allowBlank: true,
  errorStyle: 1,
  renderMode: 2,
  ...extra,
})

const data: IWorkbookData = {
  id: 'wb',
  name: 'wb',
  appVersion: '1.4.0',
  locale: 'enUS' as never,
  styles: {},
  sheetOrder: ['s1', 's2'],
  sheets: {
    s1: {
      id: 's1',
      name: 'Main',
      rowCount: 20,
      columnCount: 20,
      cellData: {
        0: { 0: { v: 'Fruits' } },
        1: { 0: { v: 'b' }, 1: { v: 'b' }, 2: { v: 'Apple' }, 3: { v: 'Apple' }, 4: { v: 'x' }, 5: { v: 'Pear' }, 6: { v: 'a, b' }, 7: { v: 'zz' }, 8: { v: 'Apple' }, 9: { v: 'b' }, 10: { v: 'Pear' }, 11: { v: 'Fruits' }, 12: { v: 'Apple' } },
        2: { 10: { v: 'Plum' }, 11: { v: 'Letters' }, 12: { v: 'b' } },
      },
    },
    s2: {
      id: 's2',
      name: 'Lists Sheet',
      rowCount: 20,
      columnCount: 5,
      cellData: { 0: { 0: { v: 'Apple' }, 1: { v: 'a' } }, 1: { 0: { v: 'Pear' }, 1: { v: 'b' } }, 2: { 1: { v: 'c' } } },
    },
  },
  resources: [
    {
      name: 'SHEET_DEFINED_NAME_PLUGIN',
      data: JSON.stringify({
        n1: { id: 'n1', name: 'Fruits', formulaOrRefString: "'Lists Sheet'!$A$1:$A$2", localSheetId: 'AllDefaultWorkbook' },
        n2: { id: 'n2', name: 'Letters', formulaOrRefString: "'Lists Sheet'!$B$1:$B$3", localSheetId: 'AllDefaultWorkbook' },
      }),
    },
    {
      name: 'SHEET_DATA_VALIDATION_PLUGIN',
      data: JSON.stringify({
        s1: [
          rule('json', 1, { formula1: JSON.stringify(['a', 'b']), formula2: '#ff0000,#00ff00' }),
          rule('cross', 2, { formula1: "='Lists Sheet'!$A$1:$A$2" }),
          rule('named', 3, { formula1: '=Fruits' }),
          rule('indirect', 4, { formula1: '=INDIRECT("Fruits")' }),
          rule('indirectCell', 5, { formula1: '=INDIRECT($A$1)' }),
          { ...rule('multi', 6, { formula1: "='Lists Sheet'!$B$1:$B$3" }), type: 'listMultiple' },
          rule('wholeCol', 7, { formula1: "='Lists Sheet'!$B:$B" }),
          rule('offset', 8, { formula1: "=OFFSET('Lists Sheet'!$A$1,0,0,COUNTA('Lists Sheet'!$A:$A),1)" }),
          rule('comma', 9, { formula1: 'a,b' }),
          rule('indirectStr', 10, { formula1: '=INDIRECT("\'Lists Sheet\'!A1:A2")' }),
          { ...rule('dep', 12, { formula1: '=INDIRECT($L2)' }), ranges: [{ startRow: 1, endRow: 2, startColumn: 12, endColumn: 12 }] },
        ],
      }),
    },
  ],
}

describe('Univer 1.4.0 list validation, as the dropdown import uses it', () => {
  let u: HeadlessUniver
  const status = (row: number, col: number) => u.get<SheetsDataValidationValidatorService>(SheetsDataValidationValidatorService).validatorCell('wb', 's1', row, col)
  const cached = (uid: string) => {
    const model = u.get<SheetDataValidationModel>(SheetDataValidationModel)
    const r = model.getRuleById('wb', 's1', uid)
    if (!r) throw new Error(`no rule ${uid}`)
    return u.get<DataValidationListCacheService>(DataValidationListCacheService).getOrCompute('wb', 's1', r)
  }
  beforeAll(async () => {
    u = loadHeadless(data)
    await new Promise((r) => setTimeout(r, 1500))
  })
  afterAll(() => u.dispose())

  it('reads item colours from formula2, by position', async () => {
    expect(cached('json').list).toEqual(['a', 'b'])
    expect(cached('json').colorMap).toEqual({ a: '#ff0000', b: '#00ff00' })
    expect(await status(1, 1)).toBe(DataValidationStatus.VALID)
  })

  it('evaluates other sheets, defined names, INDIRECT (literal or from a cell), OFFSET, whole columns and comma lists', async () => {
    expect(cached('cross').list).toEqual(['Apple', 'Pear'])
    expect(cached('named').list).toEqual(['Apple', 'Pear'])
    expect(cached('indirect').list).toEqual(['Apple', 'Pear'])
    expect(cached('indirectCell').list).toEqual(['Apple', 'Pear'])
    expect(cached('indirectStr').list).toEqual(['Apple', 'Pear'])
    expect(cached('offset').list).toEqual(['Apple', 'Pear'])
    expect(cached('wholeCol').list).toEqual(['a', 'b', 'c'])
    expect(cached('comma').list).toEqual(['a', 'b'])
    expect(await status(1, 2)).toBe(DataValidationStatus.VALID)
    expect(await status(1, 3)).toBe(DataValidationStatus.VALID)
    expect(await status(1, 4)).toBe(DataValidationStatus.INVALID) // "x"
    expect(await status(1, 5)).toBe(DataValidationStatus.VALID)
    expect(await status(1, 7)).toBe(DataValidationStatus.INVALID) // "zz"
    expect(await status(1, 8)).toBe(DataValidationStatus.VALID)
    expect(await status(2, 10)).toBe(DataValidationStatus.INVALID) // "Plum"
  })

  it("accepts Google's multiple selection text (\"a, b\") in a listMultiple rule", async () => {
    expect(await status(1, 6)).toBe(DataValidationStatus.VALID)
  })

  it('does NOT move a list formula per cell: every cell of a rule gets the first cell\'s dependent list', async () => {
    // L2 = Fruits (M2 Apple valid); L3 = Letters, M3 "b" is in Letters but checked against Fruits.
    expect(await status(1, 12)).toBe(DataValidationStatus.VALID)
    expect(await status(2, 12)).toBe(DataValidationStatus.INVALID)
  })
})
