// Formula-mode layout for the text layer (owner decision 2026-11-11,
// «طبق من اليسار الى اليمين»): while a formula is in the cell editor or the
// formula bar, it reads left to right, token by token, in the order it was
// typed, as in Excel and Google Sheets on a right-to-left sheet.
//
// Plain UAX #9 is not enough: with a left-to-right paragraph, two Arabic
// tokens with only neutrals between them (`"ملخص",'نعم'!A1`) form one
// right-to-left run and trade places. So every token that can hold Arabic is
// a bidi isolate (as if wrapped in FSI … PDI): its text reads in its own
// direction inside its own place, and the operators, commas, parentheses,
// quotes and `!` around it stay where they were typed.
//
// Token boundaries come from Univer's own formula lexer
// (LexerTreeBuilder.sequenceNodesBuilder, the one formula-colours.ts uses);
// this module only cuts each lexer token into its quoted content and its
// bare names. It is pure: the lexer is passed in.
//
// What is isolated, inside each lexer token:
//   - the content of a string literal "…" (without the quotes; "" stays inside),
//   - the content of a quoted sheet name '…' (without the quotes; '' stays inside),
//   - a bare name (a defined name, an unquoted sheet name, a function name
//     being typed) that contains a right-to-left character.
// An unterminated string or sheet name ("ملخ, 'نعم) is isolated up to the end
// of its token, so the layout does not move when the closing quote is typed.
// If the lexer's tokens do not spell out the formula (a lexer that changed, or
// one of its known gaps, such as "" inside a string), the whole formula is cut
// as one token: the same rules, so typing never makes the layout jump.

import type { FormulaNode } from './formula-colours'

/** A formula lexer: `sequenceNodesBuilder` of Univer's LexerTreeBuilder, or a stand-in in tests. */
export type FormulaTokenizer = (formulaWithoutEquals: string) => readonly FormulaNode[] | null | undefined

// Characters that end a bare name. Quotes start a quoted part.
const SEPARATOR = /[\s(),;:!{}[\]+\-*/^&=<>%"']/
const RIGHT_TO_LEFT = /[֐-ࣿיִ-﷿ﹰ-﻿]|[\uD802-\uD803\uD83A-\uD83B]/

/** True when `text` is a formula: it starts with `=` (spaces before it allowed, as the paragraph rule does). */
export function isFormulaText(text: string): boolean {
  return /^\s*=/.test(text)
}

/** Isolate ranges [start, end) inside one token, offsets relative to the token. */
export function tokenIsolates(token: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let i = 0
  while (i < token.length) {
    const ch = token[i]!
    if (ch === '"' || ch === "'") {
      let j = i + 1
      while (j < token.length) {
        if (token[j] === ch) {
          if (token[j + 1] === ch) {
            j += 2 // an escaped quote ("" or '') stays inside
            continue
          }
          break
        }
        j++
      }
      if (j > i + 1) out.push([i + 1, j])
      i = j + 1
    } else if (SEPARATOR.test(ch)) {
      i++
    } else {
      let j = i + 1
      while (j < token.length && !SEPARATOR.test(token[j]!)) j++
      if (RIGHT_TO_LEFT.test(token.slice(i, j))) out.push([i, j])
      i = j
    }
  }
  return out
}

/** Token texts of a formula body from the lexer, or the whole body as one token when they do not spell it out. */
export function formulaTokens(body: string, tokenize: FormulaTokenizer | null): string[] {
  if (!body) return []
  if (tokenize) {
    try {
      const tokens = (tokenize(body) ?? []).map((n) => (typeof n === 'string' ? n : n?.token))
      if (tokens.length && tokens.every((t) => typeof t === 'string') && tokens.join('') === body) return tokens as string[]
    } catch {
      // a lexer that throws on a half-typed formula: the whole body below
    }
  }
  return [body]
}

/**
 * Isolate ranges [start, end) of a formula paragraph `text` (offsets into
 * `text`, which may end with the paragraph's `\r`). `text` must be a formula
 * (see isFormulaText); `continuation` marks a later paragraph of a formula
 * document, which has no `=` of its own and is cut as one token.
 */
export function formulaIsolates(text: string, tokenize: FormulaTokenizer | null, continuation = false): Array<[number, number]> {
  const end = text.replace(/[\r\n]+$/, '').length
  let start = 0
  let tokens: string[]
  if (continuation) tokens = [text.slice(0, end)]
  else {
    const eq = text.indexOf('=')
    if (eq < 0 || text.slice(0, eq).trim()) return []
    start = eq + 1
    tokens = formulaTokens(text.slice(start, end), tokenize)
  }
  const out: Array<[number, number]> = []
  let offset = start
  for (const token of tokens) {
    for (const [a, b] of tokenIsolates(token)) out.push([offset + a, offset + b])
    offset += token.length
  }
  return out
}

/** Live check of the lexer for formula mode: tokens of a sample with Arabic must spell it out and keep its boundaries. Empty means usable. */
export function checkFormulaLayoutLexer(tokenize: FormulaTokenizer | null | undefined): string[] {
  if (!tokenize) return ['LexerTreeBuilder.sequenceNodesBuilder (injector)']
  const sample = `IF(A1>0,"ملخص",'نعم'!A1)`
  let tokens: string[]
  try {
    tokens = (tokenize(sample) ?? []).map((n) => (typeof n === 'string' ? n : n?.token)) as string[]
  } catch (e) {
    return [`LexerTreeBuilder.sequenceNodesBuilder threw: ${String(e)}`]
  }
  const want = ['IF', '(', 'A1', '>', '0', ',', '"ملخص"', ',', "'نعم'!A1", ')']
  return JSON.stringify(tokens) === JSON.stringify(want) ? [] : [`LexerTreeBuilder.sequenceNodesBuilder tokens changed: ${JSON.stringify(tokens)}`]
}
