// Unit tests for src/bidi.ts, the Unicode Bidirectional Algorithm (UAX #9)
// behind the RTL text layer.
//
// The expected visual strings below were produced by Chromium's own bidi
// implementation (each code point in its own <span> inside a dir= element,
// sorted by on-screen position), on 2026-11-10, and the algorithm was checked
// to agree with it. A random cross-check against Chromium on 1,236 mixed
// strings (Arabic, Latin, digits, separators, brackets, marks, isolates and
// embeddings, in rtl, ltr and auto paragraphs) agreed on all but three, all
// three the zero-width box of a lam-alef ligature in that oracle, not an
// ordering difference. The browser suite (test/rtl-interactions.mjs) checks
// the same rules end to end against the browser on screen.
import { describe, expect, it } from 'vitest'
import { bidiClassOf, lineLevels, paragraphDirection, resolveParagraph, visualOrder, visualString } from '../src/index'

describe('bidiClassOf', () => {
  it.each([
    ['a', 'L'], ['Z', 'L'], ['é', 'L'], ['漢', 'L'],
    ['ا', 'AL'], ['ب', 'AL'], ['؟', 'AL'], ['ـ', 'AL'], ['ﻻ', 'AL'], ['ܐ', 'AL'],
    ['א', 'R'], ['‏', 'R'], ['‎', 'L'], ['؜', 'AL'],
    ['0', 'EN'], ['9', 'EN'], ['۴', 'EN'], ['²', 'EN'],
    ['٣', 'AN'], ['٫', 'AN'], ['؀', 'AN'],
    ['+', 'ES'], ['-', 'ES'], ['−', 'ES'],
    ['#', 'ET'], ['$', 'ET'], ['%', 'ET'], ['°', 'ET'], ['⃁', 'ET'], ['€', 'ET'], ['٪', 'ET'],
    [',', 'CS'], ['.', 'CS'], ['/', 'CS'], [':', 'CS'], ['،', 'CS'], [' ', 'CS'],
    ['َ', 'NSM'], ['́', 'NSM'],
    ['​', 'BN'], ['‍', 'BN'], ['­', 'BN'], ['\u0008', 'BN'],
    ['\r', 'B'], ['\n', 'B'], [' ', 'B'],
    ['\t', 'S'],
    [' ', 'WS'], [' ', 'WS'],
    ['(', 'ON'], ['«', 'ON'], ['!', 'ON'], ['"', 'ON'], ['=', 'ON'], ['@', 'ON'],
    ['‪', 'LRE'], ['‫', 'RLE'], ['‬', 'PDF'], ['‭', 'LRO'], ['‮', 'RLO'],
    ['⁦', 'LRI'], ['⁧', 'RLI'], ['⁨', 'FSI'], ['⁩', 'PDI'],
  ] as const)('%j -> %s', (ch, expected) => {
    expect(bidiClassOf(ch.codePointAt(0)!)).toBe(expected)
  })

  it('classifies characters outside the BMP by code point', () => {
    expect(bidiClassOf(0x1f4c4)).toBe('ON') // emoji
    expect(bidiClassOf(0x10900)).toBe('R') // Phoenician letter
    expect(bidiClassOf(0x1ee00)).toBe('AL') // Arabic mathematical letter
    expect(bidiClassOf(0x1d7ce)).toBe('EN') // mathematical digit
  })
})

describe('paragraphDirection (P2-P3, as dir="auto")', () => {
  it.each([
    ['نشر المقال على LinkedIn', 'rtl'],
    ['LinkedIn نشر المقال', 'ltr'],
    ['2291/ت/1447', 'rtl'],
    ['12,400.00 SAR', 'ltr'],
    ['«مرحبا»', 'rtl'],
    // Isolates are skipped: the first strong character outside them decides.
    ['⁧نص⁩ abc', 'ltr'],
    ['⁦abc⁩ نص', 'rtl'],
    // Explicit marks are strong.
    ['‏abc', 'rtl'],
  ] as const)('%j -> %s', (text, expected) => {
    expect(paragraphDirection(text)).toBe(expected)
  })

  it('is null without a strong character', () => {
    for (const text of ['', '2026-11-10', '10:30', '12,400.00', ' ', '٣٤٥', '⁧abc⁩']) expect(paragraphDirection(text)).toBeNull()
  })
})

describe('visualString (one line, left to right) agrees with the browser', () => {
  it.each([
    ['rtl', 'نشر المقال على LinkedIn Ads', 'LinkedIn Ads ىلع لاقملا رشن'],
    ['rtl', 'متابعة قضية رقم 2291/ت/1447', '1447/ت/2291 مقر ةيضق ةعباتم'],
    ['rtl', 'المبلغ 12,400.00 ريال', 'لاير 12,400.00 غلبملا'],
    // After Arabic letters, digits are Arabic numbers (W2) and '-' does not join them (W4): browsers show 10-11-2026.
    ['rtl', 'موعد 2026-11-10 نهائي', 'يئاهن 10-11-2026 دعوم'],
    ['rtl', 'هل انتهى العمل؟', '؟لمعلا ىهتنا له'],
    ['rtl', 'تم الإرسال.', '.لاسرإلا مت'],
    ['rtl', '(مسودة) خطة', 'ةطخ )ةدوسم('],
    ['rtl', 'نسخة v2 معتمدة', 'ةدمتعم v2 ةخسن'],
    ['rtl', 'الجلسة 10:30', '10:30 ةسلجلا'],
    ['rtl', 'Basecamp API v2', 'Basecamp API v2'],
    ['ltr', 'Basecamp API v2', 'Basecamp API v2'],
    ['ltr', 'Report تقرير الربع end', 'Report عبرلا ريرقت end'],
    ['ltr', "='المهام'!A2", "='ماهملا'!A2"],
    ['rtl', 'نص "quoted" نص', 'صن "quoted" صن'],
    // N0: paired brackets take the direction of their context.
    ['rtl', 'نص (LinkedIn) نص', 'صن )LinkedIn( صن'],
    ['ltr', 'abc (نص) def', 'abc (صن) def'],
    ['rtl', 'خصم -5% فقط', 'طقف %5- مصخ'],
    ['rtl', 'العدد ١٢٣ هنا', 'انه ١٢٣ ددعلا'],
    ['auto', 'v2 معتمدة', 'v2 ةدمتعم'],
    ['auto', '2026-11-10', '2026-11-10'],
  ] as const)('%s %j', (direction, text, expected) => {
    expect(visualString(text, direction)).toBe(expected)
  })

  it.each([
    // Isolates and embeddings; the invisible controls themselves are left out of the comparison.
    ['rtl', 'نص ⁦abc نص⁩ ok', 'ok abc صن صن'],
    ['rtl', 'abc ⁧نص def⁩ xyz', 'abc def صن xyz'],
    ['ltr', 'abc ‫نص def‬ xyz', 'abc def صن xyz'],
    ['rtl', 'a‏b', 'ba'],
  ] as const)('%s %j (explicit controls)', (direction, text, expected) => {
    const visible = Array.from(visualString(text, direction)).filter((ch) => !/[‎‏⁦-⁩‪-‮]/.test(ch)).join('')
    expect(visible).toBe(expected)
  })
})

describe('resolveParagraph', () => {
  it('puts Arabic at level 1 and an embedded Latin phrase at level 2 in an RTL paragraph', () => {
    const text = 'على LinkedIn Ads'
    const { levels, paragraphLevel } = resolveParagraph(text, 'rtl')
    expect(paragraphLevel).toBe(1)
    expect(levels.join('')).toBe('1111222222222222')
  })

  it('auto takes the first strong character and falls back when there is none', () => {
    expect(resolveParagraph('abc نص', 'auto').paragraphLevel).toBe(0)
    expect(resolveParagraph('نص abc', 'auto').paragraphLevel).toBe(1)
    expect(resolveParagraph('2026', 'auto', 'rtl').paragraphLevel).toBe(1)
    expect(resolveParagraph('2026', 'auto', 'ltr').paragraphLevel).toBe(0)
  })

  it('keeps one level per UTF-16 code unit (a surrogate pair shares its code point level)', () => {
    const { levels } = resolveParagraph('نص \u{1F4C4} abc', 'rtl')
    expect(levels).toHaveLength('نص \u{1F4C4} abc'.length)
    expect(levels[3]).toBe(levels[4])
  })

  it('survives more than the maximum embedding depth', () => {
    const deep = '‫'.repeat(130) + 'abc' + '‬'.repeat(130)
    expect(() => resolveParagraph(deep, 'ltr')).not.toThrow()
  })
})

describe('lineLevels (L1)', () => {
  it('returns trailing whitespace and the paragraph separator to the paragraph level', () => {
    const p = resolveParagraph('abc نص   \r', 'rtl')
    const line = lineLevels(p, 0, 'abc نص   \r'.length)
    expect(line.slice(-4)).toEqual([1, 1, 1, 1])
  })

  it('resets whitespace before a tab (segment separator)', () => {
    const text = 'abc  \tdef'
    const line = lineLevels(resolveParagraph(text, 'rtl'), 0, text.length)
    expect(line.slice(3, 6)).toEqual([1, 1, 1])
  })

  it('works on a slice of the paragraph (one wrapped line)', () => {
    const text = 'نص abc def نص'
    const p = resolveParagraph(text, 'rtl')
    // The first line ends after "abc ": its trailing space goes back to level 1.
    expect(lineLevels(p, 0, 7)).toEqual([1, 1, 1, 2, 2, 2, 1])
  })
})

describe('visualOrder (L2)', () => {
  it.each([
    [[], []],
    [[0, 0, 0], [0, 1, 2]],
    [[1, 1, 1], [2, 1, 0]],
    [[0, 1, 1, 0], [0, 2, 1, 3]],
    [[1, 1, 2, 2, 1], [4, 2, 3, 1, 0]],
    [[0, 2, 2], [0, 1, 2]],
    [[2, 2, 1, 1], [3, 2, 0, 1]],
  ] as const)('%j -> %j', (levels, expected) => {
    expect(visualOrder(levels)).toEqual(expected)
  })

  it('is a permutation', () => {
    const levels = [0, 1, 2, 3, 2, 1, 0, 1, 1, 4, 4, 1]
    expect([...visualOrder(levels)].sort((a, b) => a - b)).toEqual(levels.map((_, i) => i))
  })
})
