// Cell values as the Sheets API returns them with
// `valueRenderOption=UNFORMATTED_VALUE` and `dateTimeRenderOption=SERIAL_NUMBER`:
// text, numbers (dates are serial numbers), booleans, or nothing.

import type { IsoDate } from '@naf-sheets/shared'

export type CellValue = string | number | boolean | null | undefined

/** Invisible direction marks (LRM, RLM, ALM, embeddings, isolates, BOM): never part of a value. */
const DIRECTION_MARKS = /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069\uFEFF]/g

/**
 * Trimmed text of a cell; '' for an empty cell. Collapses inner runs of
 * whitespace and drops invisible direction marks, so «الحالة‏» is «الحالة».
 */
export function cellText(value: CellValue): string {
  if (value === null || value === undefined) return ''
  return String(value).replace(DIRECTION_MARKS, '').replace(/\s+/g, ' ').trim()
}

/**
 * A text value to write with `valueInputOption=USER_ENTERED`, kept as text:
 * the leading apostrophe stops Sheets from reading «15%», «2026-11-17» or
 * «=…» as a number, a date or a formula. Sheets stores the text without it.
 */
export function textCell(text: string): string {
  return `'${text}`
}

/** Arabic-Indic and Eastern Arabic-Indic digits to Latin. */
export function latinDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
}

const DAY_MS = 86_400_000
/** Google Sheets counts days from 1899-12-30 (serial 0); there is no 1904 system. */
const EPOCH = Date.UTC(1899, 11, 30)
const MAX_SERIAL = 2958465 // 9999-12-31

function realDate(y: number, m: number, d: number): IsoDate | null {
  const back = new Date(Date.UTC(y, m - 1, d))
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null
  return back.toISOString().slice(0, 10)
}

export function serialToIso(serial: number): IsoDate | null {
  if (!Number.isFinite(serial)) return null
  const day = Math.floor(serial)
  if (day < 1 || day > MAX_SERIAL) return null
  return new Date(EPOCH + day * DAY_MS).toISOString().slice(0, 10)
}

export function isoToSerial(iso: IsoDate): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return null
  const date = realDate(Number(m[1]), Number(m[2]), Number(m[3]))
  if (date === null) return null
  return Math.round((Date.parse(date) - EPOCH) / DAY_MS)
}

export type DateRead = { ok: true; value: IsoDate | null } | { ok: false }

/**
 * The years a due date may fall in (owner, 2026-11-17). A small number typed
 * in «الموعد» (30) is a serial Google reads as 1900-01-29: outside this range
 * a date is unreadable, and its row is held with an alert.
 */
export const FIRST_DATE: IsoDate = '2000-01-01'
export const LAST_DATE: IsoDate = '2100-12-31'

/**
 * A due-date cell: empty → null; a serial number; or text `YYYY/MM/DD`,
 * `YYYY-MM-DD` (any digits), between FIRST_DATE and LAST_DATE. Anything else
 * is unreadable.
 */
export function readDate(value: CellValue): DateRead {
  let iso: IsoDate | null
  if (typeof value === 'number') {
    iso = serialToIso(value)
  } else {
    const text = latinDigits(cellText(value))
    if (text === '') return { ok: true, value: null }
    const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(text)
    iso = m ? realDate(Number(m[1]), Number(m[2]), Number(m[3])) : null
  }
  return iso === null || iso < FIRST_DATE || iso > LAST_DATE ? { ok: false } : { ok: true, value: iso }
}
