// Unit tests for the pure helpers of src/rtl-grid.ts. They hold the geometry
// and direction rules the mirror relies on; the browser suite
// (test/rtl-interactions.mjs) checks the same rules end to end on screen.
import { HorizontalAlign } from '@univerjs/core'
import type { RectPopupDirection } from '@univerjs/ui'
import { describe, expect, it } from 'vitest'
import { firstStrongDirection, MIRRORED_POPUP_ROOM, mirroredVerticalDirection, mirrorPopupDirection, mirrorRect, swapHorizontalAlign, textBoxLeft } from '../src/index'

describe('firstStrongDirection', () => {
  it.each([
    ['مراجعة البيان الصحفي', 'rtl'],
    ['Basecamp', 'ltr'],
    // Mixed strings: the first strong character decides, as with dir="auto".
    ['نشر المقال على LinkedIn', 'rtl'],
    ['LinkedIn نشر المقال', 'ltr'],
    ['v2 معتمدة', 'ltr'],
    ['قضية رقم 2291/ت/1447', 'rtl'],
    // Leading digits and punctuation are skipped until a strong character.
    ['2291/ت/1447', 'rtl'],
    ['12,400.00 SAR', 'ltr'],
    ['«مرحبا»', 'rtl'],
    ['(report.pdf)', 'ltr'],
    // Other scripts of each direction.
    ['שלום', 'rtl'],
    ['Ελληνικά', 'ltr'],
    ['Кириллица', 'ltr'],
    ['Ångström', 'ltr'],
    // Arabic presentation forms (A and B).
    ['ﭐ', 'rtl'],
    ['ﻻ', 'rtl'],
    // Not strong (Unicode bidi): Arabic-Indic digits (AN/EN) and combining marks (NSM),
    // so they are skipped exactly like dir="auto" skips them.
    ['١٢٣ abc', 'ltr'],
    ['۱۲۳ abc', 'ltr'],
    ['ًabc', 'ltr'],
    // Letters of other scripts are strong LTR.
    ['漢字 نص', 'ltr'],
  ] as const)('%s -> %s', (text, expected) => {
    expect(firstStrongDirection(text)).toBe(expected)
  })

  it('follows the sheet (rtl) when there is no strong character', () => {
    for (const text of ['', '2026-11-10', '10:30', '12,400.00', '   ', '%', '-']) expect(firstStrongDirection(text)).toBe('rtl')
  })

  it('reads by code point, so a character outside the BMP does not split', () => {
    expect(firstStrongDirection('\u{1F4C4} report')).toBe('ltr')
    expect(firstStrongDirection('\u{1F4C4} تقرير')).toBe('rtl')
  })
})

describe('textBoxLeft', () => {
  // A 40-wide text drawn at x = 100.
  it.each([
    ['left', 'ltr', 100],
    ['left', 'rtl', 100],
    ['right', 'ltr', 60],
    ['right', 'rtl', 60],
    ['center', 'ltr', 80],
    ['center', 'rtl', 80],
    ['start', 'ltr', 100],
    ['start', 'rtl', 60],
    ['start', 'inherit', 100],
    ['end', 'ltr', 60],
    ['end', 'rtl', 100],
    ['end', 'inherit', 60],
  ] as const)('align %s, direction %s -> %d', (align, direction, expected) => {
    expect(textBoxLeft(100, 40, align, direction)).toBe(expected)
  })

  it('a zero-width text starts at x whatever the alignment', () => {
    for (const align of ['left', 'right', 'center', 'start', 'end'] as const) expect(textBoxLeft(7, 0, align, 'rtl')).toBe(7)
  })
})

describe('mirrorRect', () => {
  const frame = { left: 100, right: 500 } // axis at x = 300

  it('mirrors left and right across the vertical axis of the frame; top and bottom stay', () => {
    expect(mirrorRect({ left: 120, right: 180, top: 10, bottom: 30 }, frame)).toEqual({ left: 420, right: 480, top: 10, bottom: 30 })
  })

  it('keeps the width and keeps left <= right', () => {
    const r = mirrorRect({ left: 150, right: 260, top: 0, bottom: 1 }, frame)
    expect(r.right - r.left).toBe(110)
    expect(r.left).toBeLessThanOrEqual(r.right)
  })

  it('maps a rectangle centred on the axis onto itself', () => {
    expect(mirrorRect({ left: 280, right: 320, top: 5, bottom: 9 }, frame)).toEqual({ left: 280, right: 320, top: 5, bottom: 9 })
  })

  it('is its own inverse', () => {
    const r = { left: 101.5, right: 133.25, top: 4, bottom: 8 }
    expect(mirrorRect(mirrorRect(r, frame), frame)).toEqual(r)
  })

  it('carries extra properties through and does not mutate its input', () => {
    const input = { left: 0, right: 10, top: 0, bottom: 10, width: 10, height: 10, id: 'anchor' }
    const copy = { ...input }
    const out = mirrorRect(input, { left: 0, right: 100 })
    expect(out).toEqual({ ...input, left: 90, right: 100 })
    expect(input).toEqual(copy)
  })
})

describe('mirrorPopupDirection', () => {
  // Every direction Univer 1.4.0 accepts (RectPopupDirection).
  const ALL = [
    'left', 'left-center', 'left-bottom', 'left-top',
    'right', 'right-center', 'right-bottom', 'right-top',
    'top', 'top-center', 'top-left', 'top-right',
    'bottom', 'bottom-center', 'bottom-left', 'bottom-right',
    'vertical', 'vertical-left', 'vertical-right', 'vertical-center',
    'horizontal', 'horizontal-top', 'horizontal-bottom', 'horizontal-center',
  ] as const satisfies readonly RectPopupDirection[]

  it.each([
    // Plain vertical directions align with the anchor's left edge: mirrored, the right edge.
    [undefined, 'vertical-right'],
    ['vertical', 'vertical-right'],
    ['top', 'top-right'],
    ['bottom', 'bottom-right'],
    // Plain horizontal opens to the right of the anchor: mirrored, to its left.
    ['horizontal', 'left'],
    ['horizontal-top', 'left-top'],
    ['horizontal-bottom', 'left-bottom'],
    ['horizontal-center', 'left-center'],
    // Explicit sides swap.
    ['left', 'right'],
    ['right', 'left'],
    ['left-top', 'right-top'],
    ['right-bottom', 'left-bottom'],
    ['top-left', 'top-right'],
    ['bottom-right', 'bottom-left'],
    ['vertical-left', 'vertical-right'],
    ['vertical-right', 'vertical-left'],
    // Centred directions have no side.
    ['top-center', 'top-center'],
    ['bottom-center', 'bottom-center'],
    ['vertical-center', 'vertical-center'],
  ] as const)('%s -> %s', (input, expected) => {
    expect(mirrorPopupDirection(input)).toBe(expected)
  })

  it('always returns a direction Univer accepts', () => {
    const valid = new Set<string>(ALL)
    for (const d of [undefined, ...ALL]) expect(valid.has(mirrorPopupDirection(d)), String(d)).toBe(true)
  })

  it('mirroring twice lands on the same placement', () => {
    // Plain vertical/top/bottom mean "aligned left"; horizontal means "to the right".
    const canonical = (d: string) => ({ vertical: 'vertical-left', top: 'top-left', bottom: 'bottom-left', horizontal: 'right' })[d] ?? d.replace(/^horizontal-/, 'right-')
    for (const d of ALL) expect(canonical(mirrorPopupDirection(mirrorPopupDirection(d))), d).toBe(canonical(d))
  })
})

describe('mirroredVerticalDirection', () => {
  it('opens below, right-aligned, when the popup fits there (stock "vertical" opens below unless it does not fit)', () => {
    expect(mirroredVerticalDirection(MIRRORED_POPUP_ROOM)).toBe('bottom-right')
    expect(mirroredVerticalDirection(600)).toBe('bottom-right')
  })

  it("lets Univer take the roomier side when it does not fit below, or when the anchor is unknown", () => {
    expect(mirroredVerticalDirection(MIRRORED_POPUP_ROOM - 1)).toBe('vertical-right')
    expect(mirroredVerticalDirection(0)).toBe('vertical-right')
    expect(mirroredVerticalDirection(null)).toBe('vertical-right')
  })

  it("leaves room for Univer's tallest cell popup, the data-validation list (about 300 px with the 16 px gap)", () => {
    expect(MIRRORED_POPUP_ROOM).toBeGreaterThanOrEqual(300 + 16)
  })
})

describe('swapHorizontalAlign', () => {
  it('swaps LEFT and RIGHT', () => {
    expect(swapHorizontalAlign(HorizontalAlign.LEFT)).toBe(HorizontalAlign.RIGHT)
    expect(swapHorizontalAlign(HorizontalAlign.RIGHT)).toBe(HorizontalAlign.LEFT)
  })

  it('leaves direction-free values alone', () => {
    for (const v of [HorizontalAlign.UNSPECIFIED, HorizontalAlign.CENTER, HorizontalAlign.JUSTIFIED, HorizontalAlign.BOTH, HorizontalAlign.DISTRIBUTED]) {
      expect(swapHorizontalAlign(v)).toBe(v)
    }
  })

  it('leaves non-alignment values alone (toolbar value$ may carry undefined)', () => {
    expect(swapHorizontalAlign(undefined)).toBeUndefined()
    expect(swapHorizontalAlign(null)).toBeNull()
  })

  it('is its own inverse', () => {
    for (const v of Object.values(HorizontalAlign).filter((x): x is HorizontalAlign => typeof x === 'number')) {
      expect(swapHorizontalAlign(swapHorizontalAlign(v))).toBe(v)
    }
  })

  it('uses the numeric values the stored styles hold (LEFT 1, RIGHT 3)', () => {
    // The interaction suite reads the stored `ht` as 1 / 3; keep the helper tied to them.
    expect([HorizontalAlign.LEFT, HorizontalAlign.RIGHT]).toEqual([1, 3])
    expect(swapHorizontalAlign(1 as HorizontalAlign)).toBe(3)
  })
})
