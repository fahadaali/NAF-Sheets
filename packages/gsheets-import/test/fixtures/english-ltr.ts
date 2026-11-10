// SYNTHETIC FIXTURE — hand-written, NOT exported from a real Google Sheets
// file. Follows the documented `spreadsheets.get` (includeGridData=true)
// response; typed against src/google-types.ts. Phase 2 acceptance (spec §15)
// still requires a real NAF file.
//
// A small left-to-right sheet with English headers, a title row above the
// header row, subtasks marked by leading spaces, and a TRUE/FALSE status.

import type { GsCellData, GsSpreadsheet } from '../../src/google-types'

const s = (value: string): GsCellData => ({ userEnteredValue: { stringValue: value }, effectiveValue: { stringValue: value }, formattedValue: value })
const b = (value: boolean): GsCellData => ({ userEnteredValue: { boolValue: value }, effectiveValue: { boolValue: value }, formattedValue: value ? 'TRUE' : 'FALSE' })

export const englishLtr: GsSpreadsheet = {
  spreadsheetId: '1EnGlIsHlTrSyNtHeTiC',
  properties: { title: 'Launch plan', locale: 'en_US', timeZone: 'Asia/Riyadh' },
  sheets: [
    {
      properties: {
        sheetId: 42,
        title: 'Plan',
        index: 0,
        sheetType: 'GRID',
        gridProperties: { rowCount: 20, columnCount: 5 },
      },
      data: [
        {
          rowData: [
            { values: [s('Q4 launch plan')] },
            { values: [s('Task'), s('Owner'), s('Due date'), s('Done'), s('Budget notes')] },
            { values: [s('Press release'), s('Sara'), { userEnteredValue: { numberValue: 46296 }, effectiveValue: { numberValue: 46296 }, formattedValue: '2026-10-01', userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } } }, b(false)] },
            { values: [s('  Draft'), s('Sara'), {}, b(true)] },
            { values: [s('  Legal review'), s('Khalid'), {}, b(false)] },
            { values: [s('Website banner'), s('Reem'), {}, b(false)] },
            { values: [s('  Copy'), s('Reem'), {}, b(true)] },
          ],
          rowMetadata: Array.from({ length: 20 }, () => ({ pixelSize: 21 })),
          columnMetadata: Array.from({ length: 5 }, () => ({ pixelSize: 100 })),
        },
      ],
    },
  ],
}
