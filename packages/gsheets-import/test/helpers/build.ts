// Small builders for hand-made `spreadsheets.get` responses in unit tests.
// They produce the documented shape (src/google-types.ts) and nothing else.

import type { ICellData, IWorkbookData } from '@univerjs/core'
import type { GsCellData, GsExtendedValue, GsSheet, GsSheetProperties, GsSpreadsheet } from '../../src/google-types'

export const str = (v: string, extra: Partial<GsCellData> = {}): GsCellData => ({
  userEnteredValue: { stringValue: v },
  effectiveValue: { stringValue: v },
  formattedValue: v,
  ...extra,
})

export const num = (v: number, extra: Partial<GsCellData> = {}): GsCellData => ({
  userEnteredValue: { numberValue: v },
  effectiveValue: { numberValue: v },
  formattedValue: String(v),
  ...extra,
})

export const formula = (f: string, effective?: GsExtendedValue, formatted?: string, extra: Partial<GsCellData> = {}): GsCellData => ({
  userEnteredValue: { formulaValue: f },
  ...(effective ? { effectiveValue: effective } : {}),
  ...(formatted !== undefined ? { formattedValue: formatted } : {}),
  ...extra,
})

/** A cell produced by an array formula or pivot table: effective value only. */
export const produced = (effective: GsExtendedValue, formatted: string): GsCellData => ({ effectiveValue: effective, formattedValue: formatted })

export function spreadsheet(sheets: GsSheet[], extra: Partial<GsSpreadsheet> = {}): GsSpreadsheet {
  return { spreadsheetId: 'test-id', properties: { title: 'اختبار' }, sheets, ...extra }
}

export function gridSheet(rows: GsCellData[][], extra: Partial<GsSheet> = {}, props: Partial<GsSheetProperties> = {}): GsSheet {
  return {
    properties: { sheetId: 0, title: 'ورقة1', index: 0, sheetType: 'GRID', gridProperties: { rowCount: 50, columnCount: 10 }, rightToLeft: true, ...props },
    data: [{ rowData: rows.map((values) => ({ values })) }],
    ...extra,
  }
}

export function oneSheet(rows: GsCellData[][], extra: Partial<GsSheet> = {}, props: Partial<GsSheetProperties> = {}): GsSpreadsheet {
  return spreadsheet([gridSheet(rows, extra, props)])
}

export function cellOf(workbook: IWorkbookData, sheetId: string, row: number, col: number): ICellData | undefined {
  return workbook.sheets[sheetId]?.cellData?.[row]?.[col]
}

export function resourceOf<T>(workbook: IWorkbookData, name: string): T | undefined {
  const entry = workbook.resources?.find((r) => r.name === name)
  return entry ? (JSON.parse(entry.data) as T) : undefined
}

export function styleOf(workbook: IWorkbookData, cell: ICellData | undefined) {
  return typeof cell?.s === 'string' ? workbook.styles[cell.s] : undefined
}
