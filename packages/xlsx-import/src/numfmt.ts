// Number formats: built-in ids (ECMA-376 Part 1 §18.8.30) and the file's own
// <numFmts>. Univer 1.4.0 reads Excel-style format codes, so codes are written
// as found; only the built-ins (which the file names by id, without a code)
// need a table.

import type { GsNumberFormat, GsNumberFormatType } from '@naf-sheets/gsheets-import'

/**
 * Built-in codes that are the same in every locale (§18.8.30; the same table
 * as openpyxl's BUILTIN_FORMATS, checked 2026-11-11).
 *
 * 14 and 22 are "the system short date (and time)": Excel shows them in the
 * reader's regional format. The platform shows dates as `YYYY-MM-DD`
 * (spec §12.2), so they are written that way.
 * OPEN: apps/api/OPEN_QUESTIONS.md "Google import" G25.
 */
const BUILTIN: Record<number, string> = {
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  12: '# ?/?',
  13: '# ??/??',
  14: 'yyyy-mm-dd',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'yyyy-mm-dd h:mm',
  37: '#,##0_);(#,##0)',
  38: '#,##0_);[Red](#,##0)',
  39: '#,##0.00_);(#,##0.00)',
  40: '#,##0.00_);[Red](#,##0.00)',
  41: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mmss.0',
  48: '##0.0E+0',
  49: '@',
}

/**
 * Built-in ids whose code depends on the reader's locale (currency symbol,
 * East Asian calendars): 5–8, 42, 44 (currency) and 27–36, 50–81. The file
 * carries no code for them, so they are reported as not transferred.
 */
function localeDependentType(id: number): GsNumberFormatType | null {
  if ((id >= 5 && id <= 8) || id === 42 || id === 44) return 'CURRENCY'
  if ((id >= 27 && id <= 36) || (id >= 50 && id <= 81)) return 'DATE'
  return null
}

/** Strips quoted text, escapes, [colour]/[$…] brackets and fill/padding characters. */
function significant(code: string): string {
  return code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/_./g, '')
    .replace(/\*./g, '')
    .replace(/\[(?!h\]|hh\]|m\]|mm\]|s\]|ss\])[^\]]*\]/gi, '')
}

export function formatType(code: string): GsNumberFormatType {
  const s = significant(code)
  if (/^\s*@\s*$/.test(s)) return 'TEXT'
  const date = /[yd]|e{1,2}|g{1,3}/i.test(s.replace(/E[+-]/g, ''))
  const time = /[hs]|AM\/PM|A\/P|\[(h|m|s)+\]/i.test(s)
  if (date && time) return 'DATE_TIME'
  if (date) return 'DATE'
  if (time) return 'TIME'
  if (/m/i.test(s)) return 'DATE'
  if (s.includes('%')) return 'PERCENT'
  if (/E[+-]/i.test(s)) return 'SCIENTIFIC'
  if (/[$€£¥]|\[\$/.test(code)) return 'CURRENCY'
  return 'NUMBER'
}

/** Whether a format code shows a date or time (so a serial in it is a date). */
export function isDateFormat(code: string | undefined): boolean {
  if (!code) return false
  const t = formatType(code)
  return t === 'DATE' || t === 'TIME' || t === 'DATE_TIME'
}

/**
 * The number format of a cell style: `null` for General (id 0, or a custom
 * code `General`), a format with a pattern, or a type without a pattern for
 * locale-dependent built-ins (the converter reports those).
 */
export function numberFormatFor(id: number, custom: ReadonlyMap<number, string>): GsNumberFormat | null {
  const code = custom.get(id)
  if (code !== undefined) {
    if (code.trim() === '' || /^general$/i.test(code.trim())) return null
    return { type: formatType(code), pattern: code }
  }
  if (id === 0) return null
  const builtin = BUILTIN[id]
  if (builtin) return { type: formatType(builtin), pattern: builtin }
  const type = localeDependentType(id)
  return type ? { type } : null
}
