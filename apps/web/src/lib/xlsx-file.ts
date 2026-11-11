// The file chosen in «رفع ملف Excel» (owner decision 2026-11-11). Checked in
// the browser so an obvious mistake gets an Arabic explanation before any
// upload; the API reads the bytes and is the final judge
// (POST /api/import/xlsx). Pure, unit-tested.

import { XLSX_MAX_FILE_BYTES } from '@naf-sheets/shared'

export type XlsxFileProblem =
  /** Nothing chosen. */
  | 'missing'
  /** Zero bytes. */
  | 'empty'
  /** Over XLSX_MAX_FILE_BYTES. */
  | 'too_large'
  /** A legacy .xls (or .xlsb): Excel has to save it as .xlsx first. */
  | 'legacy'
  /** CSV, ODS, Numbers, PDF…: not an Excel workbook. */
  | 'wrong_type'

export type XlsxFileCheck = { ok: true } | { ok: false; problem: XlsxFileProblem }

export const XLSX_ACCEPT = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export function checkXlsxFile(file: { name: string; size: number } | null | undefined, maxBytes = XLSX_MAX_FILE_BYTES): XlsxFileCheck {
  if (!file) return { ok: false, problem: 'missing' }
  const name = file.name.trim().toLowerCase()
  if (/\.(xls|xlsb|xlt)$/.test(name)) return { ok: false, problem: 'legacy' }
  if (!name.endsWith('.xlsx')) return { ok: false, problem: 'wrong_type' }
  if (file.size === 0) return { ok: false, problem: 'empty' }
  if (file.size > maxBytes) return { ok: false, problem: 'too_large' }
  return { ok: true }
}

/** The file's name without `.xlsx`, as a suggested title. */
export function titleFromFileName(name: string): string {
  return name.replace(/\.xlsx$/i, '').trim()
}

/** Size in megabytes with one decimal (at least 0.1), Latin digits (spec §12.2). */
export function formatMegabytes(bytes: number): string {
  return Math.max(0.1, bytes / (1024 * 1024)).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}
