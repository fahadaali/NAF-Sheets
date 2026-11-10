// Calendar dates in cells (spec §12.2: Gregorian `YYYY-MM-DD`, Latin digits).
//
// A date cell holds either a serial number (what Univer stores when a person
// types a date, shown through a number format) or the text `YYYY-MM-DD`.
// Serial numbers follow the workbook's `dateSystem` exactly as Univer 1.4.0
// counts them (core `DateSystem`; checked against the engine's DATE() in
// test/univer-load.test.ts):
//   date1900 (default): serial 1 = 1900-01-01; serial 60 is Excel's fictitious
//                       1900-02-29 and is no real date; from 61 on,
//                       serial = days since 1899-12-30.
//   date1904:           serial 0 = 1904-01-01.
// A time of day (the fraction) is ignored.

import type { IsoDate } from '@naf-sheets/shared'
import { DATE_SYSTEM } from './univer'

const DAY_MS = 86_400_000
const EPOCH_1900_LATE = Date.UTC(1899, 11, 30) // for serials >= 61
const EPOCH_1900_EARLY = Date.UTC(1899, 11, 31) // for serials 1..59
const EPOCH_1904 = Date.UTC(1904, 0, 1)
const MAX_SERIAL_1900 = 2958465 // 9999-12-31

/** Arabic-Indic and Eastern Arabic-Indic digits to Latin (same mapping as the import wizard). */
export function latinDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
}

function isoFromUtc(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10)
}

function is1904(dateSystem: unknown): boolean {
  return dateSystem === DATE_SYSTEM.D1904
}

/** Serial number → `YYYY-MM-DD`, or null when the number is no date in that system. */
export function serialToIso(serial: number, dateSystem?: unknown): IsoDate | null {
  if (!Number.isFinite(serial)) return null
  const day = Math.floor(serial)
  if (is1904(dateSystem)) {
    if (day < 0 || day > MAX_SERIAL_1900 - 1462) return null
    return isoFromUtc(EPOCH_1904 + day * DAY_MS)
  }
  if (day < 1 || day === 60 || day > MAX_SERIAL_1900) return null
  return isoFromUtc((day < 60 ? EPOCH_1900_EARLY : EPOCH_1900_LATE) + day * DAY_MS)
}

/** `YYYY-MM-DD` → its calendar parts, or null when it is not a real date. */
function isoParts(iso: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) return null
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  const back = new Date(Date.UTC(y, m - 1, d))
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null
  return { y, m, d }
}

/** `YYYY-MM-DD` → serial number in the workbook's date system, or null when it has none. */
export function isoToSerial(iso: IsoDate, dateSystem?: unknown): number | null {
  const parts = isoParts(iso)
  if (parts === null) return null
  const ms = Date.UTC(parts.y, parts.m - 1, parts.d)
  if (is1904(dateSystem)) {
    const serial = Math.round((ms - EPOCH_1904) / DAY_MS)
    return serial >= 0 ? serial : null
  }
  const late = Math.round((ms - EPOCH_1900_LATE) / DAY_MS)
  if (late >= 61) return late
  const early = Math.round((ms - EPOCH_1900_EARLY) / DAY_MS)
  return early >= 1 && early < 60 ? early : null
}

export type DateRead = { kind: 'empty' } | { kind: 'date'; date: IsoDate } | { kind: 'invalid'; text: string }

/**
 * What a date cell means. Accepted: a serial number, or the text
 * `YYYY-MM-DD` (Arabic-Indic digits are read as Latin). Anything else is
 * `invalid`: a date such as `1/2/2026` is ambiguous, and a wrong guess would be
 * sent to Basecamp.
 */
export function readDateValue(value: unknown, dateSystem?: unknown): DateRead {
  if (value === undefined || value === null) return { kind: 'empty' }
  if (typeof value === 'number') {
    const iso = serialToIso(value, dateSystem)
    return iso === null ? { kind: 'invalid', text: String(value) } : { kind: 'date', date: iso }
  }
  if (typeof value === 'boolean') return { kind: 'invalid', text: String(value) }
  const text = latinDigits(String(value)).trim()
  if (text === '') return { kind: 'empty' }
  return isoParts(text) === null ? { kind: 'invalid', text: String(value) } : { kind: 'date', date: text }
}

/** Number format written with a date the cell had no format for (spec §12.2 `YYYY-MM-DD`). */
export const ISO_DATE_PATTERN = 'yyyy-mm-dd'
