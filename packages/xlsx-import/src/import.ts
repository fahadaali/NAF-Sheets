// .xlsx → Univer IWorkbookData + import report, through the one converter
// (@naf-sheets/gsheets-import convertSpreadsheet), so the writing to Univer
// and the report stay in one place whatever the source.

import type { DateSystem, IRange } from '@univerjs/core'
import { convertSpreadsheet, location, univerSheetId, type ConvertResult, type ImportOrigin, type ImportReportItem, type ImportVia } from '@naf-sheets/gsheets-import'
import { formulaBlockers } from './formula'
import { readXlsx, type ReadOptions, type XlsxReadResult } from './read'

export interface ImportXlsxOptions extends ReadOptions {
  /** Univer unit id of the new workbook. */
  workbookId: string
  via: Exclude<ImportVia, 'google_api'>
  /** The uploaded file's name (upload only), for the report. */
  fileName?: string | null
  /** Workbook name; default: the file's own title, else empty. */
  title?: string
  /** Function names the formula engine evaluates (default: Univer 1.4.0's). */
  supportedFunctions?: ReadonlySet<string>
}

export interface ImportXlsxResult extends ConvertResult {
  read: Pick<XlsxReadResult, 'origin' | 'defaultFont' | 'dateSystem' | 'title' | 'unpackedBytes'>
}

/** The program report messages and cell notes name. */
export function sourceNameOf(kind: XlsxReadResult['origin']['kind']): string {
  if (kind === 'excel') return 'Excel'
  if (kind === 'google_export') return 'Google Sheets'
  return 'البرنامج الذي أنشأ الملف'
}

export async function importXlsx(bytes: Uint8Array, options: ImportXlsxOptions): Promise<ImportXlsxResult> {
  const read = await readXlsx(bytes, options)
  const title = options.title ?? read.title ?? ''
  ;(read.spreadsheet.properties ??= {}).title = title
  const origin: ImportOrigin = {
    kind: read.origin.kind,
    via: options.via,
    application: read.origin.application,
    fileName: options.fileName ?? null,
    defaultFont: { family: read.defaultFont.family, size: read.defaultFont.size },
    dateSystem: read.dateSystem,
    alignment: 'as_given',
  }
  const converted = convertSpreadsheet(read.spreadsheet, {
    workbookId: options.workbookId,
    origin,
    sourceName: sourceNameOf(read.origin.kind),
    formulaBlockers,
    ...(read.dateSystem === 'date1904' ? { dateSystem: 'date1904' as DateSystem } : {}),
    ...(options.supportedFunctions ? { supportedFunctions: options.supportedFunctions } : {}),
  })
  const extra: ImportReportItem[] = read.items.map(({ sheet, item }) => {
    const range: IRange | null = item.range ? { startRow: item.range.startRow, endRow: item.range.endRow, startColumn: item.range.startCol, endColumn: item.range.endCol } : null
    const out: ImportReportItem = {
      kind: item.kind,
      outcome: item.outcome,
      location: sheet ? location(univerSheetId(sheet.gid), sheet.name, range) : null,
      message: item.message,
    }
    if (item.detail) out.detail = item.detail
    return out
  })
  converted.report.items.push(...extra)
  return {
    ...converted,
    read: { origin: read.origin, defaultFont: read.defaultFont, dateSystem: read.dateSystem, title: read.title, unpackedBytes: read.unpackedBytes },
  }
}
