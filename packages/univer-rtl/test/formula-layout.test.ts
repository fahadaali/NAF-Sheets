// Formula mode of the text layer (src/formula-layout.ts, rtl-text.ts step 7;
// owner decision 2026-11-11): a formula reads left to right, token by token,
// with every token that can hold Arabic a bidi isolate. Token boundaries come
// from Univer's real lexer (LexerTreeBuilder of the installed
// @univerjs/engine-formula). The painted result in the cell editor and the
// formula bar is checked in the browser by test/rtl-interactions.mjs.
import { LexerTreeBuilder } from '@univerjs/engine-formula'
import { describe, expect, it } from 'vitest'
import {
  caretEdge, checkFormulaLayoutContract, checkFormulaLayoutLexer, formulaIsolates, formulaTokens, isFormulaText, lineLevels, resolveParagraph,
  tokenIsolates, visualBoxes, visualOrder, visualString,
} from '../src/index'
import type { FormulaTokenizer } from '../src/index'

const lexer = new LexerTreeBuilder()
const tokenize: FormulaTokenizer = (f) => lexer.sequenceNodesBuilder(f)
const rev = (s: string) => Array.from(s).reverse().join('')

/** Visual order (left to right) of a formula in formula mode, and in plain UAX #9 with an LTR paragraph (the behaviour before). */
const after = (f: string) => visualString(f, 'ltr', 'ltr', formulaIsolates(f, tokenize))
const before = (f: string) => visualString(f, 'ltr')
/** Visual index of every logical character (unit widths). */
const positions = (f: string, isolates = formulaIsolates(f, tokenize)) => {
  const p = resolveParagraph(f, 'ltr', 'ltr', isolates)
  const order = visualOrder(lineLevels(p, 0, f.length))
  const out = new Array<number>(f.length)
  order.forEach((logical, visual) => (out[logical] = visual))
  return out
}

describe('virtual isolates in resolveParagraph (bidi.ts)', () => {
  // The oracle: the same text with real FSI … PDI controls, which UAX #9 defines.
  const withControls = (text: string, ranges: Array<[number, number]>) => {
    let out = ''
    let at = 0
    for (const [a, b] of ranges) {
      out += text.slice(at, a) + '⁨' + text.slice(a, b) + '⁩'
      at = b
    }
    return out + text.slice(at)
  }
  const strip = (s: string) => s.replace(/[⁨⁩]/g, '')

  it.each([
    ['a"אב",\'גד\'!b', [[2, 4], [7, 9]]],
    ['IF(x,"ملخص",\'نعم\'!A1)', [[6, 10], [13, 16]]],
    ['"abc عربي 12",x', [[1, 12]]],
    ['ملخص نعم', [[0, 4], [5, 8]]],
    ['x="رقم 5 من 7"', [[3, 13]]],
  ] as Array<[string, Array<[number, number]>]>)('%j resolves as if wrapped in FSI … PDI', (text, ranges) => {
    for (const dir of ['ltr', 'rtl', 'auto'] as const) {
      expect(visualString(text, dir, 'ltr', ranges)).toBe(strip(visualString(withControls(text, ranges), dir)))
    }
  })

  // Levels are exact. The visual order can differ only where a dropped control
  // sat between two characters of a deeper odd level (two adjacent right-to-left
  // isolates, or one next to outside right-to-left text): the zero-width
  // control would split their run. Formula mode never produces that (every
  // right-to-left run of a formula is inside an isolate, and two isolates are
  // always separated by a quote or a separator), as the formula cases below show.
  it('gives the levels real controls give, on random mixed strings and ranges', () => {
    const alphabet = ['a', 'B', '1', '2', ' ', ',', '"', "'", '!', '(', ')', '-', 'ب', 'ت', 'ث', 'א', '٣', '.']
    let seed = 7
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n)
    for (let k = 0; k < 400; k++) {
      const len = 1 + rand(14)
      const text = Array.from({ length: len }, () => alphabet[rand(alphabet.length)]).join('')
      const ranges: Array<[number, number]> = []
      let at = 0
      while (at < len && ranges.length < 3) {
        const a = at + rand(len - at)
        const b = a + 1 + rand(len - a)
        if (b > len) break
        ranges.push([a, b])
        at = b
      }
      const dir = (['ltr', 'rtl', 'auto'] as const)[rand(3)]!
      const real = withControls(text, ranges)
      const q = resolveParagraph(real, dir)
      const kept = Array.from(real, (ch, i) => i).filter((i) => !/[\u2068\u2069]/.test(real[i]!))
      expect(resolveParagraph(text, dir, 'ltr', ranges).levels, JSON.stringify({ text, ranges, dir })).toEqual(kept.map((i) => q.levels[i]))
    }
  })

  it('without isolates behaves exactly as before', () => {
    const t = 'نشر المقال على LinkedIn Ads'
    expect(resolveParagraph(t, 'rtl', 'ltr', [])).toEqual(resolveParagraph(t, 'rtl'))
  })
})

describe('formula isolates from the lexer', () => {
  it('isolates the content of strings and quoted sheet names, never their quotes', () => {
    const f = '=IF(A1>0,"ملخص",\'نعم\'!A1)'
    expect(formulaIsolates(f, tokenize).map(([a, b]) => f.slice(a, b))).toEqual(['ملخص', 'نعم'])
  })

  it('isolates bare Arabic names (defined names, unquoted sheet names, a function being typed)', () => {
    const f = '=SUM(مبيعات,ورقة!A1)+مبي'
    expect(formulaIsolates(f, tokenize).map(([a, b]) => f.slice(a, b))).toEqual(['مبيعات', 'ورقة', 'مبي'])
  })

  it('isolates an unterminated string or sheet name up to the end', () => {
    expect(formulaIsolates('="ملخ', tokenize)).toEqual([[2, 5]])
    expect(formulaIsolates("='نعم", tokenize)).toEqual([[2, 5]])
    expect(formulaIsolates("='نعم'!A", tokenize)).toEqual([[2, 5]])
  })

  it('splits a lexer token that holds two strings, and keeps "" inside a string', () => {
    const f = '="ملخص" "نعم"'
    expect(formulaIsolates(f, tokenize).map(([a, b]) => f.slice(a, b))).toEqual(['ملخص', 'نعم'])
    // The lexer drops one quote of "" (its tokens do not spell the text): the whole body is cut as one token.
    expect(formulaTokens('"a""ب"', tokenize)).toEqual(['"a""ب"'])
    expect(formulaIsolates('="a""ب"', tokenize).map(([a, b]) => '="a""ب"'.slice(a, b))).toEqual(['a""ب'])
  })

  it('ignores the paragraph mark, and a text that is not a formula', () => {
    expect(formulaIsolates('="ب"\r', tokenize)).toEqual([[2, 3]])
    expect(formulaIsolates('نص "ب"', tokenize)).toEqual([])
    expect(isFormulaText('=A1')).toBe(true)
    expect(isFormulaText('  =A1')).toBe(true)
    expect(isFormulaText('A=1')).toBe(false)
  })

  it('tokenIsolates leaves Latin names and numbers alone', () => {
    expect(tokenIsolates('SUM')).toEqual([])
    expect(tokenIsolates("'Sheet 1'!A1")).toEqual([[1, 8]])
    expect(tokenIsolates('Table1[عمود]')).toEqual([[7, 11]])
  })

  it('works with no lexer at all (one token)', () => {
    const f = '=IF(A1>0,"ملخص",\'نعم\'!A1)'
    expect(formulaIsolates(f, null)).toEqual(formulaIsolates(f, tokenize))
  })
})

describe('visual order of formulas: before (plain UAX #9) and after (formula mode)', () => {
  it.each([
    // [formula, before, after]
    ['=IF(A1>0,"ملخص",\'نعم\'!A1)', `=IF(A1>0,"${rev('ملخص",\'نعم')}'!A1)`, `=IF(A1>0,"${rev('ملخص')}",'${rev('نعم')}'!A1)`],
    ['="ملخص",\'نعم\'!A1', `="${rev('ملخص",\'نعم')}'!A1`, `="${rev('ملخص')}",'${rev('نعم')}'!A1`],
    ['="أ"&"ب"&"ج"', `="${rev('أ"&"ب"&"ج')}"`, `="أ"&"ب"&"ج"`],
    ['=SUM(مبيعات,تكاليف)', `=SUM(${rev('مبيعات,تكاليف')})`, `=SUM(${rev('مبيعات')},${rev('تكاليف')})`],
    ['=IF(SUM(A4:B5,A4)>=10,"نعم",\'المهام\'!A2)', `=IF(SUM(A4:B5,A4)>=10,"${rev('نعم",\'المهام')}'!A2)`, `=IF(SUM(A4:B5,A4)>=10,"${rev('نعم')}",'${rev('المهام')}'!A2)`],
    ['="إعداد خطة"', `="${rev('إعداد خطة')}"`, `="${rev('إعداد خطة')}"`],
    ['="Q1 خطة"&A1', `="Q1 ${rev('خطة')}"&A1`, `="Q1 ${rev('خطة')}"&A1`],
  ])('%s', (f, was, now) => {
    expect(before(f)).toBe(was)
    expect(after(f)).toBe(now)
  })

  it('an Arabic string with digits reads right to left inside its own place', () => {
    expect(after('="رقم 12",A1')).toBe(`="12 ${rev('رقم')}",A1`)
  })

  it('operators, commas, parentheses, quotes and ! keep their logical left-to-right positions', () => {
    const f = '=IF(A1>0,"ملخص",\'نعم\'!A1)'
    const pos = positions(f)
    for (let i = 0; i < f.length; i++) if (/[=()>,"'!]/.test(f[i]!)) expect(pos[i], `${f[i]} at ${i}`).toBe(i)
  })

  it('stays stable while the formula is typed: no character outside the token being typed moves', () => {
    for (const f of ['=IF(A1>0,"ملخص",\'نعم\'!A1)', '=SUM(مبيعات,\'ورقة 1\'!A1:A3)&"إعداد خطة"', '="أ"&"ب"&"ج"']) {
      const full = positions(f)
      for (let n = 2; n <= f.length; n++) {
        const prefix = f.slice(0, n)
        const isolates = formulaIsolates(prefix, tokenize)
        const typing = isolates.find(([a, b]) => a <= n - 1 && n - 1 < b)
        const pos = positions(prefix, isolates)
        for (let i = 0; i < n; i++) {
          if (typing && i >= typing[0]) continue
          // Before the open token, every character sits where it sits in the finished formula.
          expect(pos[i], `${JSON.stringify(prefix)} char ${i}`).toBe(full[i])
        }
      }
    }
  })
})

describe('caret mapping in formula mode', () => {
  // Unit widths, laid out logically; the boxes follow the formula-mode levels.
  const boxesOf = (f: string) => {
    const p = resolveParagraph(f, 'ltr', 'ltr', formulaIsolates(f, tokenize))
    const levels = lineLevels(p, 0, f.length)
    const lefts = Array.from(f, (_, i) => i * 10)
    return visualBoxes(lefts, lefts.map(() => 10), levels)
  }

  it('the caret moves right to left inside an Arabic token and left to right around it', () => {
    const f = '=IF(A1>0,"ملخص",\'نعم\'!A1)'
    const boxes = boxesOf(f)
    // Offsets 10..14 are the caret stops before each letter of «ملخص» and after it.
    const xs = [10, 11, 12, 13].map((i) => caretEdge(boxes[i]!, true)).concat(caretEdge(boxes[13]!, false))
    for (let k = 1; k < xs.length; k++) expect(xs[k]!).toBeLessThan(xs[k - 1]!)
    // The token occupies exactly its own place, between its quotes.
    expect(Math.min(...xs)).toBe(boxes[9]!.left + 10) // right after the opening quote
    expect(Math.max(...xs)).toBe(boxes[14]!.left) // right before the closing quote
    // Around the token, the caret advances left to right with the offsets.
    const outside = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => caretEdge(boxes[i]!, true))
    for (let k = 1; k < outside.length; k++) expect(outside[k]!).toBeGreaterThan(outside[k - 1]!)
  })

  it('two Arabic tokens keep their typed order on screen', () => {
    const f = '=IF(A1>0,"ملخص",\'نعم\'!A1)'
    const boxes = boxesOf(f)
    const first = Math.max(...[10, 11, 12, 13].map((i) => boxes[i]!.left))
    const second = Math.min(...[17, 18, 19].map((i) => boxes[i]!.left))
    expect(first).toBeLessThan(second)
  })
})

describe('contract', () => {
  it('the installed lexer is the one formula mode was verified against', () => {
    expect(checkFormulaLayoutContract()).toEqual([])
    expect(checkFormulaLayoutLexer(tokenize)).toEqual([])
  })

  it('a missing or changed lexer is reported, not used', () => {
    expect(checkFormulaLayoutLexer(null)).toHaveLength(1)
    expect(checkFormulaLayoutLexer(() => ['IF(A1>0,"ملخص",\'نعم\'!A1)'])[0]).toMatch(/tokens changed/)
    expect(checkFormulaLayoutLexer(() => { throw new Error('x') })[0]).toMatch(/threw/)
  })
})
