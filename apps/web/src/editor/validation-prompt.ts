// The help text of a validation rule, shown when its cell is selected.
//
// Google Sheets shows a rule's help text (API `inputMessage`) and Excel its
// input message (`prompt`, `promptTitle`) when the cell is selected. Univer
// 1.4.0 stores both in the rule (`prompt`, `promptTitle`, `showInputMessage`)
// but never shows them: nothing in sheets-data-validation-ui reads `prompt`
// (checked in node_modules on 2026-11-11). The import keeps them
// (apps/api OPEN_QUESTIONS.md "Google import" G32); this shows them with
// Univer's own cell alert (sheets-ui CellAlertManagerService, the popup its
// "invalid value" hover uses), so the RTL layer places it like that one.

import type { Injector } from '@univerjs/core'
import type { FUniver } from '@univerjs/presets'
import { CellAlertManagerService, CellAlertType } from '@univerjs/sheets-ui'

const ALERT_KEY = 'naf-validation-prompt'
/** Shown when the rule has a message but no title. */
export const PROMPT_TITLE = 'تلميح'

interface RuleLike {
  prompt?: string
  promptTitle?: string
  showInputMessage?: boolean
}

/** The alert's title and text for a rule, or null when it has nothing to show. */
export function promptOf(rule: RuleLike | null | undefined): { title: string; message: string } | null {
  const message = rule?.prompt?.trim()
  if (!message || rule?.showInputMessage === false) return null
  return { title: rule?.promptTitle?.trim() || PROMPT_TITLE, message }
}

type RangeWithValidation = { getDataValidation?: () => { rule?: RuleLike } | null }

export function enableValidationPrompts(univerAPI: FUniver, injector: Injector, unitId: string): () => void {
  let alerts: CellAlertManagerService
  try {
    alerts = injector.get(CellAlertManagerService)
  } catch (error) {
    console.error('[editor] validation help text not shown: no CellAlertManagerService', error)
    return () => {}
  }
  let shown: string | null = null
  const hide = () => {
    if (shown === null) return
    shown = null
    alerts.removeAlert(ALERT_KEY)
  }
  const subscription = univerAPI.addEvent(univerAPI.Event.SelectionChanged, (event) => {
    try {
      if (event.workbook.getId() !== unitId) return
      const selection = event.selections[0]
      if (!selection) return hide()
      const row = selection.startRow
      const col = selection.startColumn
      const subUnitId = event.worksheet.getSheetId()
      const range = event.worksheet.getRange(row, col) as unknown as RangeWithValidation
      const text = promptOf(range.getDataValidation?.()?.rule)
      if (!text) return hide()
      const key = `${subUnitId}!${row}:${col}`
      if (shown === key) return
      shown = key
      alerts.showAlert({ type: CellAlertType.INFO, title: text.title, message: text.message, location: { unitId, subUnitId, row, col }, width: 220, height: 74, key: ALERT_KEY })
    } catch (error) {
      console.error('[editor] could not show the validation help text', error)
    }
  })
  return () => {
    subscription.dispose()
    hide()
  }
}
