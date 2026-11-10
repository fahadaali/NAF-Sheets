// Mappings whose meaning on a right-to-left sheet is NOT decided.
//
// Our grid is mirrored by @naf-sheets/univer-rtl and alignment there is
// logical (CLAUDE.md, owner decision 2026-11-10): model LEFT renders at the
// start of the cell, which is the visual right on an RTL sheet. Google's API
// reference describes LEFT as "explicitly aligned to the left of the cell"
// and does not say whether that is physical or logical on a sheet with
// `rightToLeft: true`. Borders and padding have the same `left`/`right`
// question.
//
// Until it is decided, every function here is a PASS-THROUGH: it writes
// Google's value unchanged into the Univer model, on RTL and LTR sheets
// alike. On our mirrored RTL grid a Google LEFT therefore renders at the
// start (visual right). The `sheetIsRtl` argument exists so the decision can
// be made here without touching the callers.
//
// OPEN: OPEN_QUESTIONS.md §1. test/rtl-open.test.ts pins the current behaviour.

import type { HorizontalAlign } from '@univerjs/core'
import type { GsHorizontalAlign } from './google-types'
import { H_ALIGN } from './univer-constants'

/**
 * Google `HorizontalAlign` → Univer `HorizontalAlign` (`IStyleData.ht`).
 * Current behaviour: pass-through, `sheetIsRtl` ignored.
 */
export function mapHorizontalAlignment(googleValue: GsHorizontalAlign | undefined, sheetIsRtl: boolean): HorizontalAlign | undefined {
  void sheetIsRtl // OPEN: OPEN_QUESTIONS.md §1 — undecided, deliberately unused.
  switch (googleValue) {
    case 'LEFT':
      return H_ALIGN.LEFT
    case 'CENTER':
      return H_ALIGN.CENTER
    case 'RIGHT':
      return H_ALIGN.RIGHT
    default:
      return undefined
  }
}

/**
 * Google `left`/`right` (borders, padding) → Univer `l`/`r`.
 * Current behaviour: pass-through, `sheetIsRtl` ignored.
 */
export function mapLeftRightSides<T>(left: T | undefined, right: T | undefined, sheetIsRtl: boolean): { l: T | undefined; r: T | undefined } {
  void sheetIsRtl // OPEN: OPEN_QUESTIONS.md §1 — undecided, deliberately unused.
  return { l: left, r: right }
}
