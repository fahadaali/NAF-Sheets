import { describe, expect, it } from 'vitest'
import {
  applyInbound,
  decorateTaskRows,
  indentTaskRow,
  outdentTaskRow,
  readTasks,
  UNSYNCED_NOTE,
  type DecorationOptions,
  type WorkbookSnapshot,
} from '../src'
import { cell, defaultPlan, linkedWorkbook, putRow, uidTitles } from './helpers'

const S = 'sheet-1'
// Theme values come from the caller; these stand in for them.
const decoration: DecorationOptions = { unsyncedStyle: { bg: { rgb: 'theme-unsynced' } }, subtaskIndent: 18 }

function levels(workbook: WorkbookSnapshot) {
  const r = readTasks(workbook, S, defaultPlan(S))
  if (!r.ok) throw new Error(r.error.message)
  return r.value.tasks.map((t) => [t.uid, t.level, t.parentUid, t.position])
}

function notes(workbook: WorkbookSnapshot): Record<string, Record<string, { id: string; note: string }>> {
  const data = workbook.resources?.find((r) => r.name === 'SHEET_NOTE_PLUGIN')?.data
  return data ? ((JSON.parse(data) as Record<string, never>)[S] ?? {}) : {}
}

describe('indentTaskRow / outdentTaskRow (§8)', () => {
  it('Tab makes the row a subtask of the to-do above, marks it, and Shift+Tab undoes all of it', () => {
    const { workbook } = linkedWorkbook(['حملة', 'تصميم', 'تقرير'])
    putRow(workbook, S, 2, { A: { v: 'تصميم', s: { pd: { t: 1 } } }, G: 'نص محلي' })
    const indented = indentTaskRow(workbook, S, defaultPlan(S), 'u-2', decoration)
    if (!indented.ok) throw new Error(indented.error.message)
    const wb = indented.value.workbook
    expect(levels(wb)).toEqual([
      ['u-1', 0, null, 1],
      ['u-2', 1, 'u-1', 1],
      ['u-3', 0, null, 2],
    ])
    // Start indentation of the title: Univer's `pd.l`, the start side on the mirrored grid.
    expect(cell(wb, S, 2, 'A')?.s).toEqual({ pd: { t: 1, l: 18 } })
    // Starts-on, attachments and notes do not sync for a subtask: marked, with the note.
    for (const column of ['C', 'F', 'G']) expect(cell(wb, S, 2, column)?.s).toEqual({ bg: { rgb: 'theme-unsynced' } })
    expect(Object.values(notes(wb)['2'] ?? {}).map((n) => n.note)).toEqual([UNSYNCED_NOTE, UNSYNCED_NOTE, UNSYNCED_NOTE])
    // Due date syncs for a subtask: not marked.
    expect(cell(wb, S, 2, 'D')).toBeUndefined()
    expect(indented.value.changedCells.map((c) => c.column)).toEqual([0, 2, 5, 6, 8, 9])

    const outdented = outdentTaskRow(wb, S, defaultPlan(S), 'u-2', decoration)
    if (!outdented.ok) throw new Error(outdented.error.message)
    expect(outdented.value.workbook.sheets[S]?.cellData).toEqual(workbook.sheets[S]?.cellData)
    expect(notes(outdented.value.workbook)).toEqual({})
  })

  it('refuses a third level with the engine\'s Arabic message', () => {
    const { workbook } = linkedWorkbook(['حملة', 'تصميم', 'تقرير'], { levels: [{ row: 2, level: 1, parentRow: 1 }] })
    const third = indentTaskRow(workbook, S, defaultPlan(S), 'u-2')
    expect(!third.ok && third.error.code).toBe('third_level_not_allowed')
    expect(!third.ok && third.error.message).toMatch(/مستوى واحد فقط/)
    const parent = indentTaskRow(workbook, S, defaultPlan(S), 'u-1')
    expect(!parent.ok && parent.error.code).toBe('parent_has_subtasks')
    const first = indentTaskRow(linkedWorkbook(['أ']).workbook, S, defaultPlan(S), 'u-1')
    expect(!first.ok && first.error.code).toBe('no_parent_above')
    const last = indentTaskRow(workbook, S, defaultPlan(S), 'u-3')
    expect(last.ok).toBe(true)
    const missing = outdentTaskRow(workbook, S, defaultPlan(S), 'nope')
    expect(!missing.ok && missing.error.code).toBe('row_not_found')
  })

  it('Shift+Tab on a middle subtask moves it below its former siblings, rows and all', () => {
    const { workbook } = linkedWorkbook(['حملة', 'أ', 'ب', 'ج', 'تقرير'], {
      levels: [
        { row: 2, level: 1, parentRow: 1 },
        { row: 3, level: 1, parentRow: 1 },
        { row: 4, level: 1, parentRow: 1 },
      ],
    })
    putRow(workbook, S, 3, { D: { v: 46336, t: 2 } })
    const result = outdentTaskRow(workbook, S, defaultPlan(S), 'u-3', decoration)
    if (!result.ok) throw new Error(result.error.message)
    expect(uidTitles(result.value.workbook)).toEqual([
      ['u-1', 'حملة'],
      ['u-2', 'أ'],
      ['u-4', 'ج'],
      ['u-3', 'ب'],
      ['u-5', 'تقرير'],
    ])
    expect(levels(result.value.workbook)).toEqual([
      ['u-1', 0, null, 1],
      ['u-2', 1, 'u-1', 1],
      ['u-4', 1, 'u-1', 2],
      ['u-3', 0, null, 2],
      ['u-5', 0, null, 3],
    ])
    expect(cell(result.value.workbook, S, 4, 'D')?.v).toBe(46336)
  })
})

describe('unsynced subtask cells (§8 note)', () => {
  it('marks the subtasks of a linked sheet, and never replaces a person\'s note', () => {
    const { workbook } = linkedWorkbook(['حملة', 'تصميم'], { levels: [{ row: 2, level: 1, parentRow: 1 }] })
    workbook.resources = [{ name: 'SHEET_NOTE_PLUGIN', data: JSON.stringify({ [S]: { 2: { 6: { id: 'mine', row: 2, col: 6, width: 160, height: 72, note: 'ملاحظتي' } } } }) }]
    const result = decorateTaskRows(workbook, S, defaultPlan(S), decoration)
    if (!result.ok) throw new Error(result.error.message)
    const n = notes(result.value.workbook)
    expect(n['2']?.['6']?.note).toBe('ملاحظتي')
    expect(n['2']?.['2']?.id).toBe('naf-unsynced-u-2-starts_on')
    expect(result.value.issues.map((i) => [i.code, i.column])).toEqual([['note_occupied', 6]])
    // The to-do row is not marked.
    expect(cell(result.value.workbook, S, 1, 'C')).toBeUndefined()
    // Applying again changes nothing.
    const again = decorateTaskRows(result.value.workbook, S, defaultPlan(S), decoration)
    expect(again.ok && again.value.changedCells).toEqual([])
  })

  it('marks a subtask created from Basecamp, and the marks travel with its row', () => {
    const { workbook } = linkedWorkbook(['حملة', 'تقرير'])
    const task = {
      uid: 'n-1',
      sheetId: 'p-sheet-1',
      parentUid: 'u-1',
      level: 1 as const,
      position: 1,
      title: 'فرعية',
      assignees: [],
      dueOn: null,
      startsOn: null,
      completed: false,
      notesHtml: null,
      freeColumnsForDescription: {},
      attachments: [],
      assignMode: 'auto' as const,
      localChangedAt: null,
      bcId: 7,
      deletedRemotely: false,
    }
    const result = applyInbound(workbook, S, defaultPlan(S), [{ type: 'create_row', task, remote: {} as never }], { deletedStyle: {}, ...decoration })
    if (!result.ok) throw new Error(result.error.message)
    const wb = result.value.workbook
    expect(uidTitles(wb)).toEqual([
      ['u-1', 'حملة'],
      ['n-1', 'فرعية'],
      ['u-2', 'تقرير'],
    ])
    expect(cell(wb, S, 2, 'A')?.s).toEqual({ pd: { l: 18 } })
    expect(cell(wb, S, 2, 'G')?.s).toEqual({ bg: { rgb: 'theme-unsynced' } })
    expect(notes(wb)['2']?.['6']?.id).toBe('naf-unsynced-n-1-notes')
    // Moving the to-do family later keeps marks and notes on the subtask's cells.
    const moved = applyInbound(wb, S, defaultPlan(S), [{ type: 'update_row', uid: 'u-1', fields: { position: 2 } }], { deletedStyle: {}, ...decoration })
    if (!moved.ok) throw new Error(moved.error.message)
    expect(uidTitles(moved.value.workbook)).toEqual([
      ['u-2', 'تقرير'],
      ['u-1', 'حملة'],
      ['n-1', 'فرعية'],
    ])
    expect(cell(moved.value.workbook, S, 3, 'G')?.s).toEqual({ bg: { rgb: 'theme-unsynced' } })
    expect(notes(moved.value.workbook)['3']?.['6']?.id).toBe('naf-unsynced-n-1-notes')
  })
})
