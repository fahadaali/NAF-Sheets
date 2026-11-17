import { describe, expect, it } from 'vitest'
import { formatDateTime } from '../../src/lib/format'

const LATIN_ONLY = /^[0-9 :-]+$/

describe('formatDateTime', () => {
  it('writes YYYY-MM-DD HH:mm, 24-hour, Latin digits, in the given zone', () => {
    expect(formatDateTime('2026-11-10T14:05:00Z', 'Asia/Riyadh')).toBe('2026-11-10 17:05')
    expect(formatDateTime('2026-11-10T21:30:00Z', 'Asia/Riyadh')).toBe('2026-11-11 00:30')
    expect(formatDateTime('2026-01-02T03:04:00+03:00', 'Asia/Riyadh')).toBe('2026-01-02 03:04')
    expect(formatDateTime('2026-11-10T14:05:00Z', 'Asia/Riyadh')).toMatch(LATIN_ONLY)
  })

  it('returns null for an invalid date', () => {
    expect(formatDateTime('not a date')).toBeNull()
    expect(formatDateTime('')).toBeNull()
  })
})
