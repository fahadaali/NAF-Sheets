// Display formatting (spec §12.2): Latin digits, Gregorian dates as
// YYYY-MM-DD, 24-hour time. Callers wrap the result in <bdi> so the Arabic
// text around it cannot reorder it.

/**
 * `YYYY-MM-DD HH:mm` in `timeZone` (default: the browser's).
 * Returns null for a value that is not a valid date.
 * OPEN: browser time zone or fixed Asia/Riyadh? (OPEN_QUESTIONS.md #8)
 */
export function formatDateTime(iso: string, timeZone?: string): string | null {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  // en-GB with numberingSystem latn: digits are always 0-9, hours 00-23.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

/** Share 0..1 as a whole percent with Latin digits ("45%"), or null when there is none. */
export function formatPercent(share: number | null): string | null {
  if (share === null || !Number.isFinite(share)) return null
  const clamped = Math.min(1, Math.max(0, share))
  return `${Math.round(clamped * 100)}%`
}

/** Whole number with Latin digits, no grouping surprises from the Arabic locale. */
export function formatCount(n: number): string {
  return new Intl.NumberFormat('en-US', { numberingSystem: 'latn', maximumFractionDigits: 0 }).format(n)
}
