import { describe, expect, it } from 'vitest'
import { isoToSerial, readDateValue, serialToIso } from '../src'

describe('date serials (Univer 1900 and 1904 systems)', () => {
  it('converts both ways in the 1900 system', () => {
    expect(serialToIso(1)).toBe('1900-01-01')
    expect(serialToIso(59)).toBe('1900-02-28')
    expect(serialToIso(61)).toBe('1900-03-01')
    expect(serialToIso(45658)).toBe('2025-01-01')
    expect(serialToIso(46336)).toBe('2026-11-10')
    expect(serialToIso(46336.75)).toBe('2026-11-10') // a time of day is ignored
    expect(isoToSerial('2026-11-10')).toBe(46336)
    expect(isoToSerial('1900-01-01')).toBe(1)
    expect(isoToSerial('1900-02-28')).toBe(59)
    expect(isoToSerial('1900-03-01')).toBe(61)
  })

  it('has no date for serial 60 (the fictitious 1900-02-29), 0 or negatives', () => {
    expect(serialToIso(60)).toBeNull()
    expect(serialToIso(0)).toBeNull()
    expect(serialToIso(-3)).toBeNull()
    expect(isoToSerial('1899-12-31')).toBeNull()
  })

  it('converts in the 1904 system', () => {
    expect(serialToIso(0, 'date1904')).toBe('1904-01-01')
    expect(isoToSerial('2026-11-10', 'date1904')).toBe(46336 - 1462)
    expect(serialToIso(46336 - 1462, 'date1904')).toBe('2026-11-10')
  })

  it('round-trips every day of a year', () => {
    for (let s = 46023; s < 46023 + 366; s++) expect(isoToSerial(serialToIso(s) as string)).toBe(s)
  })
})

describe('readDateValue', () => {
  it('reads serials and YYYY-MM-DD text, Arabic-Indic digits as Latin', () => {
    expect(readDateValue(46336)).toEqual({ kind: 'date', date: '2026-11-10' })
    expect(readDateValue('2026-11-10')).toEqual({ kind: 'date', date: '2026-11-10' })
    expect(readDateValue(' ٢٠٢٦-١١-١٠ ')).toEqual({ kind: 'date', date: '2026-11-10' })
    expect(readDateValue(null)).toEqual({ kind: 'empty' })
    expect(readDateValue('  ')).toEqual({ kind: 'empty' })
  })

  it('refuses anything ambiguous or impossible instead of guessing', () => {
    expect(readDateValue('1/2/2026').kind).toBe('invalid')
    expect(readDateValue('2026-2-30').kind).toBe('invalid')
    expect(readDateValue('2026-02-30').kind).toBe('invalid')
    expect(readDateValue('غداً').kind).toBe('invalid')
    expect(readDateValue(true).kind).toBe('invalid')
    expect(readDateValue(60).kind).toBe('invalid')
  })
})
