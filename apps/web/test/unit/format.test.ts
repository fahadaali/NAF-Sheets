import { describe, expect, it } from 'vitest'
import { formatCount, formatDateTime, formatPercent } from '../../src/lib/format'

const LATIN_ONLY = /^[0-9 :%,-]+$/

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

describe('formatPercent', () => {
  it('rounds a 0..1 share to a whole percent', () => {
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(0.456)).toBe('46%')
    expect(formatPercent(1)).toBe('100%')
  })

  it('clamps out-of-range values and has no value for null or NaN', () => {
    expect(formatPercent(1.2)).toBe('100%')
    expect(formatPercent(-0.1)).toBe('0%')
    expect(formatPercent(null)).toBeNull()
    expect(formatPercent(Number.NaN)).toBeNull()
  })
})

describe('formatCount', () => {
  it('uses Latin digits', () => {
    expect(formatCount(7)).toBe('7')
    expect(formatCount(12400)).toBe('12,400')
    expect(formatCount(12400)).toMatch(LATIN_ONLY)
  })
})
