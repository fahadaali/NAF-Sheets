// .xlsx → Univer IWorkbookData + import report, through the one converter
// (@naf-sheets/gsheets-import convertSpreadsheet), so the writing to Univer
// and the report stay in one place whatever the source.

import type { DateSystem, IRange } from '@univerjs/core'
import { convertSpreadsheet, location, MESSAGES, univerSheetId, type ConvertResult, type ImportOrigin, type ImportReportItem, type ImportVia } from '@naf-sheets/gsheets-import'
import { formulaBlockers } from './formula'
import { applyGoogleRendering, sheetsWithDropdowns, type GoogleRendering } from './google-rendering'
import { importPictures, type PictureImportCounts, type PictureStore } from './import-images'
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
  /**
   * A Google export only: reads Google's own rendering of the sheets that hold
   * dropdowns (chip colours, display style; see google-rendering.ts). Called
   * with their names after the file is read; null or a missing sheet means it
   * could not be read, which the report says. Not called for other origins.
   */
  googleRendering?: (sheetsWithDropdowns: string[]) => Promise<GoogleRendering | null>
  /**
   * Stores one picture of the file and answers its URL (the API: R2). Without
   * it, pictures are reported as not transferred (./import-images.ts).
   */
  storePicture?: PictureStore
}

export interface ImportXlsxResult extends ConvertResult {
  read: Pick<XlsxReadResult, 'origin' | 'defaultFont' | 'dateSystem' | 'title' | 'unpackedBytes'>
  /** Pictures imported (over the grid, in cells) and reported. */
  pictures: PictureImportCounts
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
  // Dropdown colours and display style: not in Google's export (G32).
  const dropdownNotes: ImportReportItem[] = []
  if (read.origin.kind === 'google_export') {
    const names = sheetsWithDropdowns(read.spreadsheet)
    if (names.length > 0) {
      if (!options.googleRendering) {
        dropdownNotes.push({ kind: 'data_validation', outcome: 'not_transferred', location: null, message: MESSAGES.dvColorsUnknown() })
      } else {
        const rendering = await options.googleRendering(names).catch(() => null)
        const missing = rendering ? applyGoogleRendering(read.spreadsheet, rendering) : names
        if (missing.length > 0) dropdownNotes.push({ kind: 'data_validation', outcome: 'not_transferred', location: null, message: MESSAGES.dvColorsUnreadable(), detail: missing.join('، ') })
      }
    }
  }
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
  converted.report.items.push(...extra, ...dropdownNotes)
  const pictures = await importPictures(read, converted, options.storePicture)
  return {
    ...converted,
    pictures,
    read: { origin: read.origin, defaultFont: read.defaultFont, dateSystem: read.dateSystem, title: read.title, unpackedBytes: read.unpackedBytes },
  }
}
