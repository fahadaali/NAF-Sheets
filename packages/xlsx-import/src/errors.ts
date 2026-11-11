// Failures of reading an .xlsx package. The API turns each code into an HTTP
// status and an Arabic message (apps/api/src/xlsx-import/errors.ts); this
// package never shows text to a person. `detail` is for logs and tests only
// and never carries cell content.

export type XlsxErrorCode =
  /** Not a zip / not an OOXML spreadsheet (an HTML page, a CSV, a PDF…). */
  | 'not_xlsx'
  /** An OLE compound file: a legacy .xls or a password-protected workbook. */
  | 'legacy_or_encrypted'
  /** The zip or one of its XML parts is malformed, or a DTD was present. */
  | 'corrupt'
  /** Above a limit: entries, unpacked bytes, one part, or cells (zip bombs land here). */
  | 'too_large'
  /** A spreadsheet without a single worksheet (chart sheets only, or none). */
  | 'no_sheets'

export class XlsxImportError extends Error {
  readonly code: XlsxErrorCode
  readonly detail: string

  constructor(code: XlsxErrorCode, detail = '') {
    super(`${code}${detail ? `: ${detail}` : ''}`)
    this.name = 'XlsxImportError'
    this.code = code
    this.detail = detail
  }
}

export interface XlsxLimits {
  /** Bytes of the .xlsx file itself. */
  maxFileBytes: number
  /** Entries in the zip's central directory. */
  maxEntries: number
  /** Unpacked bytes of one part (counted while inflating, not taken from the header). */
  maxPartBytes: number
  /** Unpacked bytes of every part read, together. */
  maxTotalBytes: number
  /** Cells (`<c>` elements with a value, formula or style) across all sheets. */
  maxCells: number
}

/**
 * OPEN: apps/api/OPEN_QUESTIONS.md "Google import" G22 — calibrate against
 * the real NAF file and the Worker's 128 MB. The cell cap equals the Google
 * path's declared-grid cap (G5); the byte caps keep one import well under the
 * Worker's memory with the converted snapshot alongside.
 */
export const DEFAULT_XLSX_LIMITS: XlsxLimits = {
  maxFileBytes: 15 * 1024 * 1024,
  maxEntries: 2_000,
  maxPartBytes: 48 * 1024 * 1024,
  maxTotalBytes: 96 * 1024 * 1024,
  maxCells: 500_000,
}
