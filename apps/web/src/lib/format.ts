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
