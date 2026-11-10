// Unit tests for the pure helpers of src/rtl-text.ts: visual boxes of a line,
// the right-to-left surface shift, caret edges, selection spans, grapheme
// advances inside joined Arabic words, paragraph direction and the data
// stream mapping. The browser suite (test/rtl-interactions.mjs) checks the
// same behaviour on screen against the browser's own layout.
import { describe, expect, it } from 'vitest'
import { bidiTextOfStream, caretEdge, documentParagraphDirection, graphemeAdvances, graphemes, selectionSpans, surfaceShift, visualBoxes, visualLineEnd } from '../src/index'

// Contiguous logical layout: widths laid left to right from 0.
const layout = (widths: number[]) => {
  const lefts: number[] = []
  let x = 0
  for (const w of widths) {
    lefts.push(x)
    x += w
  }
  return lefts
}
const lefts = (boxes: Array<{ left: number }>) => boxes.map((b) => b.left)

describe('visualBoxes', () => {
  it('keeps a left-to-right line as it is', () => {
    const w = [10, 20, 30]
    expect(lefts(visualBoxes(layout(w), w, [0, 0, 0]))).toEqual([0, 10, 30])
  })

  it('reverses a right-to-left line within its own extent', () => {
    const w = [10, 20, 30]
    const boxes = visualBoxes(layout(w), w, [1, 1, 1])
    expect(lefts(boxes)).toEqual([50, 30, 0])
    expect(boxes.every((b) => b.odd)).toBe(true)
  })

  it('keeps an embedded left-to-right run in order inside a right-to-left line', () => {
    // «على LinkedIn Ads»: Arabic word, space, then an LTR run of three items.
    const w = [20, 4, 30, 4, 15]
    const boxes = visualBoxes(layout(w), w, [1, 1, 2, 2, 2])
    // Visual order from the left: the LTR run (in order), then the space, then the Arabic word.
    expect(lefts(boxes)).toEqual([53, 49, 0, 30, 34])
    expect(boxes.map((b) => b.odd)).toEqual([true, true, false, false, false])
  })

  it('carries a gap between glyphs with them', () => {
    // A 5px gap between the two glyphs (e.g. justification) stays a 5px gap, mirrored.
    const boxes = visualBoxes([0, 15], [10, 10], [1, 1])
    expect(lefts(boxes)).toEqual([15, 0])
  })

  it('moves the whole segment by `shift`', () => {
    const w = [10, 20]
    expect(lefts(visualBoxes(layout(w), w, [1, 1], 100))).toEqual([120, 100])
  })

  it('preserves the set of occupied intervals (a permutation of boxes)', () => {
    const w = [3, 7, 11, 5, 9, 2]
    const boxes = visualBoxes(layout(w), w, [1, 2, 2, 3, 1, 0])
    const intervals = boxes.map((b) => [b.left, b.left + b.width]).sort((a, b) => a[0]! - b[0]!)
    for (let i = 1; i < intervals.length; i++) expect(intervals[i]![0]).toBeCloseTo(intervals[i - 1]![1]!)
    expect(intervals[0]![0]).toBe(0)
  })
})

describe('surfaceShift (start side of a right-to-left surface)', () => {
  it('moves text aligned to the logical start to the right edge', () => {
    expect(surfaceShift(0, 100, 256)).toBe(156)
  })
  it('leaves centred text centred', () => {
    expect(surfaceShift(78, 178, 256)).toBe(0)
  })
  it('moves end-aligned text to the left edge', () => {
    expect(surfaceShift(156, 256, 256)).toBe(-156)
  })
  it('leaves a line wider than the surface, or a surface of unknown width, alone', () => {
    expect(surfaceShift(0, 300, 256)).toBe(0)
    expect(surfaceShift(0, 100, Number.POSITIVE_INFINITY)).toBe(0)
    expect(surfaceShift(0, 100, 0)).toBe(0)
  })
})

describe('caretEdge', () => {
  const ltr = { left: 10, width: 8, odd: false }
  const rtl = { left: 10, width: 8, odd: true }
  it('before a left-to-right glyph is its left edge, after it its right edge', () => {
    expect(caretEdge(ltr, true)).toBe(10)
    expect(caretEdge(ltr, false)).toBe(18)
  })
  it('before a right-to-left glyph is its right edge, after it its left edge', () => {
    expect(caretEdge(rtl, true)).toBe(18)
    expect(caretEdge(rtl, false)).toBe(10)
  })
})

describe('selectionSpans', () => {
  const w = [20, 4, 30, 4, 15]
  const boxes = visualBoxes(layout(w), w, [1, 1, 2, 2, 2])
  it('merges visually adjacent boxes into one span', () => {
    expect(selectionSpans(boxes, 0, 1)).toEqual([[49, 73]])
  })
  it('splits a logical range that is visually discontiguous', () => {
    // The space and the first item of the LTR run: right and left parts of the line.
    expect(selectionSpans(boxes, 1, 2)).toEqual([[0, 30], [49, 53]])
  })
  it('ignores zero-width boxes and out-of-range indices', () => {
    const z = [{ left: 5, width: 0, odd: false }, { left: 5, width: 5, odd: false }]
    expect(selectionSpans(z, -3, 9)).toEqual([[5, 10]])
    expect(selectionSpans(z, 0, 0)).toEqual([])
  })
})

describe('graphemeAdvances', () => {
  const prefix = (widths: number[]) => (k: number) => widths.slice(0, k).reduce((s, w) => s + w, 0)
  it('takes differences of the in-context prefix widths', () => {
    expect(graphemeAdvances(3, prefix([4, 6, 5]), 15)).toEqual([4, 6, 5])
  })
  it('scales to the glyph width Univer laid out', () => {
    expect(graphemeAdvances(2, prefix([5, 5]), 20)).toEqual([10, 10])
  })
  it('always sums to the total and is never negative', () => {
    // A prefix that measures wider than the next one (contextual forms).
    const widths = [0, 3.6, 12.5, 11.9, 24.8, 36, 34.5, 43.5]
    const out = graphemeAdvances(7, (k) => widths[k]!, 43.5)
    expect(out.reduce((s, w) => s + w, 0)).toBeCloseTo(43.5)
    expect(out.every((w) => w > 0)).toBe(true)
  })
  it('shares a ligature advance equally (no two caret stops coincide)', () => {
    // lam-alef: the alef adds nothing to the prefix width.
    const out = graphemeAdvances(3, (k) => [0, 9, 9, 15]![k]!, 15)
    expect(out).toEqual([4.5, 4.5, 6])
  })
  it('a leading zero advance joins the grapheme after it', () => {
    expect(graphemeAdvances(2, (k) => [0, 0, 8]![k]!, 8)).toEqual([4, 4])
  })
})

describe('documentParagraphDirection', () => {
  it.each([
    ['إعداد خطة الاتصال', 'rtl'],
    ['Basecamp API v2', 'ltr'],
    ['نشر المقال على LinkedIn', 'rtl'],
    // A formula reads left to right, even with an Arabic sheet name first.
    ["='المهام'!A2", 'ltr'],
    ['  =SUM(A1:B2)', 'ltr'],
    // No strong character: the surface (right-to-left in NAF Sheets).
    ['2026-11-10', 'rtl'],
    ['', 'rtl'],
  ] as const)('%j -> %s', (text, expected) => {
    expect(documentParagraphDirection(text)).toBe(expected)
  })
  it('honours an explicit paragraph direction (TextDirection 1 LTR, 2 RTL)', () => {
    expect(documentParagraphDirection('نص', 1)).toBe('ltr')
    expect(documentParagraphDirection('abc', 2)).toBe('rtl')
  })
  it('uses the fallback for neutral text', () => {
    expect(documentParagraphDirection('12', null, 'ltr')).toBe('ltr')
  })
})

describe('bidiTextOfStream', () => {
  it('turns Univer structure tokens into ZWSP, one for one; tab, CR and LF stay', () => {
    const stream = 'a\u001fb\u001ec\u001cd\t\r\n\b'
    const out = bidiTextOfStream(stream)
    expect(out).toHaveLength(stream.length)
    expect(out).toBe('a​b​c​d\t\r\n​')
  })
})

describe('graphemes', () => {
  it('keeps an Arabic letter with its diacritics as one grapheme', () => {
    expect(graphemes('مَرْحَبًا')).toEqual(['مَ', 'رْ', 'حَ', 'بً', 'ا'])
  })
  it('splits plain Arabic into letters', () => {
    expect(graphemes('خطة')).toEqual(['خ', 'ط', 'ة'])
  })
})

describe('visualLineEnd (Cmd+Left/Right with the Mac key map)', () => {
  // «على LinkedIn» in an RTL line: offsets 0-3 Arabic on the right, 4-12 Latin on the left.
  const stops = [
    { offset: 0, x: 100 }, { offset: 1, x: 94 }, { offset: 3, x: 80 }, { offset: 4, x: 76 },
    { offset: 4, x: 0 }, { offset: 8, x: 30 }, { offset: 12, x: 76 },
  ]
  it('goes to the visual left end, whatever the line direction', () => {
    expect(visualLineEnd(stops, true, [0, 12], 0)?.x).toBe(0)
  })
  it('goes to the visual right end', () => {
    expect(visualLineEnd(stops, false, [0, 12], 8)).toEqual({ offset: 0, x: 100 })
  })
  it('at one spot shared by two offsets, prefers the line\'s logical start or end', () => {
    const tie = [{ offset: 5, x: 10 }, { offset: 9, x: 10 }, { offset: 2, x: 50 }]
    expect(visualLineEnd(tie, true, [0, 9], 5)?.offset).toBe(9)
  })
  it('otherwise prefers the offset nearest the caret', () => {
    const tie = [{ offset: 5, x: 10 }, { offset: 7, x: 10.2 }]
    expect(visualLineEnd(tie, true, [0, 20], 8)?.offset).toBe(7)
  })
  it('returns null without stops', () => {
    expect(visualLineEnd([], true, [0], 0)).toBeNull()
  })
})
