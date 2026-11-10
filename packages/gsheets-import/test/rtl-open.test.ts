// Documents the CURRENT, undecided behaviour of left/right on RTL sheets
// (OPEN_QUESTIONS.md §1): pass-through. When the owner decides, change
// src/rtl-open.ts and these expectations together.

import { describe, expect, it } from 'vitest'
import { convertSpreadsheet, mapHorizontalAlignment, mapLeftRightSides } from '../src'
import { H_ALIGN } from '../src/univer-constants'
import { cellOf, oneSheet, str, styleOf } from './helpers/build'

describe('mapHorizontalAlignment (OPEN §1: pass-through)', () => {
  it('writes Google LEFT/CENTER/RIGHT unchanged on RTL sheets', () => {
    expect(mapHorizontalAlignment('LEFT', true)).toBe(H_ALIGN.LEFT)
    expect(mapHorizontalAlignment('CENTER', true)).toBe(H_ALIGN.CENTER)
    expect(mapHorizontalAlignment('RIGHT', true)).toBe(H_ALIGN.RIGHT)
  })

  it('writes them unchanged on LTR sheets too', () => {
    expect(mapHorizontalAlignment('LEFT', false)).toBe(H_ALIGN.LEFT)
    expect(mapHorizontalAlignment('RIGHT', false)).toBe(H_ALIGN.RIGHT)
  })

  it('leaves unspecified alignment unset', () => {
    expect(mapHorizontalAlignment(undefined, true)).toBeUndefined()
    expect(mapHorizontalAlignment('HORIZONTAL_ALIGN_UNSPECIFIED', true)).toBeUndefined()
  })

  it('so a Google LEFT on an RTL sheet is model LEFT, which our mirrored grid draws at the start (visual right)', () => {
    const { workbook } = convertSpreadsheet(oneSheet([[str('نص', { userEnteredFormat: { horizontalAlignment: 'LEFT' } })]], {}, { rightToLeft: true }))
    expect(styleOf(workbook, cellOf(workbook, 'sheet-0', 0, 0))?.ht).toBe(H_ALIGN.LEFT)
  })
})

describe('mapLeftRightSides (OPEN §1: pass-through)', () => {
  it('keeps left as l and right as r on RTL and LTR sheets', () => {
    expect(mapLeftRightSides('L', 'R', true)).toEqual({ l: 'L', r: 'R' })
    expect(mapLeftRightSides('L', 'R', false)).toEqual({ l: 'L', r: 'R' })
  })

  it('applies to borders and padding of an RTL sheet', () => {
    const { workbook } = convertSpreadsheet(
      oneSheet([[str('x', { userEnteredFormat: { borders: { left: { style: 'SOLID' } }, padding: { left: 7, right: 1 } } })]], {}, { rightToLeft: true }),
    )
    const style = styleOf(workbook, cellOf(workbook, 'sheet-0', 0, 0))
    expect(style?.bd).toEqual({ l: { s: 1, cl: { rgb: '#000000' } } })
    expect(style?.pd).toEqual({ l: 7, r: 1 })
  })
})
