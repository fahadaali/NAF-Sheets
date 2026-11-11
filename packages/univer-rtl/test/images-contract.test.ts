// Pictures on the mirrored grid (apps/api OPEN_QUESTIONS.md "Images" I15):
// the one popup whose side Univer already picks for a right-to-left UI (the
// image menu) keeps it; every other popup is mirrored as before. The Univer
// source this relies on is checked here, so an upgrade that changes it fails.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { keepsRtlDirection, mirrorPopupDirection, RTL_AWARE_POPUPS } from '../src/rtl-grid'

const source = (pkg: string) => readFileSync(fileURLToPath(new URL(`../../../node_modules/@univerjs/${pkg}/lib/es/index.js`, import.meta.url)), 'utf8')

describe('image popup on the mirrored grid', () => {
  it('keeps the side Univer chose for a right-to-left UI, and mirrors every other popup', () => {
    expect(keepsRtlDirection({ componentKey: 'COMPONENT_IMAGE_POPUP_MENU' }, 'left')).toBe(true)
    // Univer in a left-to-right UI asks 'horizontal': mirrored as any popup.
    expect(keepsRtlDirection({ componentKey: 'COMPONENT_IMAGE_POPUP_MENU' }, 'horizontal')).toBe(false)
    expect(mirrorPopupDirection('horizontal')).toBe('left')
    expect(keepsRtlDirection({ componentKey: 'SHEET_NOTE_COMPONENT' }, 'left')).toBe(false)
    expect(keepsRtlDirection({}, 'left')).toBe(false)
  })

  it('Univer 1.4.0 still picks that side itself (sheets-drawing-ui DrawingPopupMenuController)', () => {
    const drawingUi = source('drawing-ui')
    const sheetsDrawingUi = source('sheets-drawing-ui')
    for (const [key, side] of RTL_AWARE_POPUPS) {
      expect(drawingUi).toContain(`const ${key} = "${key}";`)
      expect(sheetsDrawingUi).toMatch(new RegExp(`componentKey: ${key},[\\s\\S]{0,120}direction: this\\._localeService\\.getDirection\\(\\) === "rtl" \\? "${side}" : "horizontal"`))
    }
  })
})
