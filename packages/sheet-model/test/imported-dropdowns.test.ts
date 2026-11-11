// Imported dropdowns on the columns the sync reads (apps/api OPEN_QUESTIONS.md
// "Google import" G32, owner task 2026-11-11 "leave the sync columns alone"):
// a status or assignee column that came from Google or Excel with a dropdown,
// and a rule wide enough to cover the cells where linking adds the hidden
// system columns. The rules are shaped exactly as @naf-sheets/gsheets-import
// writes them (synthesised).

import type { ISheetDataValidationRule } from '@univerjs/core'
import { describe, expect, it } from 'vitest'
import { ensureSystemColumns, readTasks, splitAssigneeText, type AssigneeDirectory, type WorkbookSnapshot } from '../src'
import { blankWorkbook, counterUids, defaultPlan, putRow } from './helpers'

const S = 'sheet-1'
const directory: AssigneeDirectory = { people: [{ id: 11, name: 'سارة العتيبي' }, { id: 12, name: 'Omar Ali' }], externals: [] }
const range = (startRow: number, startColumn: number, endRow: number, endColumn: number) => ({ startRow, startColumn, endRow, endColumn })

function withRules(workbook: WorkbookSnapshot, rules: ISheetDataValidationRule[]): WorkbookSnapshot {
  ;(workbook as { resources?: Array<{ name: string; data: string }> }).resources = [{ name: 'SHEET_DATA_VALIDATION_PLUGIN', data: JSON.stringify({ [S]: rules }) }]
  return workbook
}

describe('imported dropdowns on the synced columns', () => {
  // Status (E) as Google exports it: a chip list; assignees (B): Google's multiple selection,
  // "a, b" as Google writes it, then JSON as Univer writes a pick; a rule over A2:Z50
  // that also covers H:J, where the system columns go.
  const plan = defaultPlan(S, { completedValues: ['منجز'] })
  function build(): WorkbookSnapshot {
    const wb = blankWorkbook()
    putRow(wb, S, 1, { A: 'إعداد الخطة', B: 'سارة العتيبي, Omar Ali', E: 'منجز' })
    putRow(wb, S, 2, { A: 'تصميم الهوية', B: JSON.stringify(['Omar Ali']), E: 'قيد التنفيذ' })
    return withRules(wb, [
      { uid: 'dv-0', type: 'list', formula1: JSON.stringify(['قيد التنفيذ', 'منجز', 'متأخر']), formula2: '#bfe1f6,#d4edbc,#ffcfc9', renderMode: 2, errorStyle: 1, allowBlank: true, ranges: [range(1, 4, 49, 4)] } as ISheetDataValidationRule,
      { uid: 'dv-1', type: 'listMultiple', formula1: JSON.stringify(['سارة العتيبي', 'Omar Ali']), renderMode: 2, errorStyle: 1, allowBlank: true, ranges: [range(1, 1, 49, 1)] } as ISheetDataValidationRule,
      { uid: 'dv-2', type: 'custom', formula1: '=LEN(A2)<200', errorStyle: 1, allowBlank: true, ranges: [range(1, 0, 49, 25)] } as ISheetDataValidationRule,
    ])
  }

  it('linking adds the system columns after the last used column and leaves every rule as it was', () => {
    const wb = build()
    const before = structuredClone((wb as { resources?: unknown }).resources)
    const ensured = ensureSystemColumns(wb.sheets[S] as never, plan, counterUids())
    if (!ensured.ok) throw new Error(ensured.error.message)
    expect(ensured.value.columns).toEqual({ uid: 7, parentUid: 8, level: 9 })
    // The sheet comes back with its cells; the workbook's rules are not part of it and stay untouched.
    expect((wb as { resources?: unknown }).resources).toEqual(before)
  })

  it('reads completion from the status list and both assignee forms of a multiple selection', () => {
    const wb = build()
    const ensured = ensureSystemColumns(wb.sheets[S] as never, plan, counterUids())
    if (!ensured.ok) throw new Error(ensured.error.message)
    wb.sheets[S] = ensured.value.sheet
    const result = readTasks(wb, S, plan, { directory })
    if (!result.ok) throw new Error(result.error.message)
    // A rule over the system columns' cells (dv-2 covers H:J) does not get in the way.
    expect(result.value.issues).toEqual([])
    expect(result.value.tasks.map((t) => [t.title, t.completed, t.assignees.map((a) => (a.kind === 'bc_person' ? a.bcPersonId : null))])).toEqual([
      ['إعداد الخطة', true, [11, 12]],
      ['تصميم الهوية', false, [12]],
    ])
  })

  it("splits Google's multiple-selection text and Univer's JSON list the same way", () => {
    expect(splitAssigneeText('سارة العتيبي, Omar Ali')).toEqual(['سارة العتيبي', 'Omar Ali'])
    expect(splitAssigneeText(JSON.stringify(['سارة العتيبي', 'Omar Ali']))).toEqual(['سارة العتيبي', 'Omar Ali'])
  })
})
