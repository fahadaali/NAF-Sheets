import { ERROR_MESSAGES } from '@naf-sheets/sync-engine'
import { describe, expect, it } from 'vitest'
import { snapshotReader } from '../../src/sync/cells'
import { sheetLayout } from '../../src/sync/layout'
import { familyRows, newRowIdentity, planRemoval, planRowMove, progressByTodo, readTaskRows } from '../../src/sync/rows'
import { t } from '../../src/strings'
import { COL, META, sheetOf, syncedWorkbook } from './sync-fixtures'

// Rows (0-based): 1 A, 2 A.1, 3 A.2, 4 B, 5 C, 6 C.1
const workbook = () =>
  syncedWorkbook([
    { title: 'A' },
    { title: 'A.1', level: 1 },
    { title: 'A.2', level: 1 },
    { title: 'B' },
    { title: 'C' },
    { title: 'C.1', level: 1 },
  ])
const setup = () => {
  const reader = snapshotReader(sheetOf(workbook()))
  const layout = sheetLayout(reader, META)!
  return { reader, layout, rows: readTaskRows(reader, layout) }
}

describe('sheet layout of a synced sheet', () => {
  it('finds the header, the system columns and the mapped fields from the header texts', () => {
    const { layout } = setup()
    expect(layout.header).toBe(0)
    expect(layout.system).toEqual({ uid: COL.uid, parentUid: COL.parent, level: COL.level })
    expect(layout.fields).toEqual({ title: 0, assignees: 1, starts_on: 2, due_on: 3, completed: 4, attachments: 5, notes: 6 })
    expect(layout.plan?.columns.map((c) => c.columnKey)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G'])
    expect(layout.plan?.sheetId).toBe(META.id)
  })

  it('a local sheet has no layout; a synced sheet without system columns has system null', () => {
    const reader = snapshotReader(sheetOf(workbook()))
    expect(sheetLayout(reader, { ...META, syncMode: 'local' })).toBeNull()
    const bare = snapshotReader({ cellData: { 0: { 0: { v: 'المهمة' } }, 1: { 0: { v: 'x' } } } })
    expect(sheetLayout(bare, META)?.system).toBeNull()
  })
})

describe('task rows', () => {
  it('reads uid, level and parent from the system columns, in sheet order', () => {
    const { rows } = setup()
    expect(rows.map((r) => [r.row, r.uid, r.level, r.parentUid])).toEqual([
      [1, 'u-1', 0, null],
      [2, 'u-2', 1, 'u-1'],
      [3, 'u-3', 1, 'u-1'],
      [4, 'u-4', 0, null],
      [5, 'u-5', 0, null],
      [6, 'u-6', 1, 'u-5'],
    ])
    expect(familyRows(rows, 'u-1').map((r) => r.row)).toEqual([1, 2, 3])
    expect(familyRows(rows, 'u-4').map((r) => r.row)).toEqual([4])
  })

  it('counts done subtasks per to-do («3 من 5»)', () => {
    const { rows } = setup()
    const progress = progressByTodo(rows, (row) => row === 2)
    expect(progress.get('u-1')).toEqual({ done: 1, total: 2 })
    expect(progress.get('u-5')).toEqual({ done: 0, total: 1 })
    expect(t.hierarchy.progress(1, 2)).toBe('1 من 2')
  })

  it('a new row between two subtasks joins their to-do; anywhere else it is a to-do', () => {
    const { rows } = setup()
    // Rows are re-read after an insert; simulate a new row 3 between A.1 (2) and A.2 (now 4).
    const shifted = rows.map((r) => (r.row >= 3 ? { ...r, row: r.row + 1 } : r))
    expect(newRowIdentity(shifted, 3, 'new')).toEqual({ uid: 'new', parentUid: 'u-1', level: 1 })
    // Right after the last subtask, before the next to-do: a to-do.
    expect(newRowIdentity(rows, 7, 'new')).toEqual({ uid: 'new', parentUid: null, level: 0 })
    const atEnd = rows.map((r) => (r.row >= 4 ? { ...r, row: r.row + 1 } : r))
    expect(newRowIdentity(atEnd, 4, 'new').level).toBe(0)
  })
})

describe('moving rows (spec §8: a to-do moves with its subtasks)', () => {
  it('a to-do moved alone takes its subtasks', () => {
    const { rows } = setup()
    expect(planRowMove(rows, 1, 1, 7)).toEqual({ kind: 'extend', start: 1, end: 3 })
    expect(planRowMove(rows, 4, 4, 1)).toEqual({ kind: 'allow' })
  })

  it('a to-do may not land between the subtasks of another to-do', () => {
    const { rows } = setup()
    expect(planRowMove(rows, 4, 4, 3)).toEqual({ kind: 'refuse', message: ERROR_MESSAGES.invalid_move_target })
  })

  it('subtasks are reordered within their to-do only', () => {
    const { rows } = setup()
    expect(planRowMove(rows, 3, 3, 2)).toEqual({ kind: 'allow' })
    expect(planRowMove(rows, 2, 2, 7)).toEqual({ kind: 'refuse', message: t.guard.moveSubtaskAcross })
    expect(planRowMove(rows, 2, 2, 1)).toEqual({ kind: 'refuse', message: t.guard.moveSubtaskAcross })
  })

  it('a block mixing a to-do with another to-do’s subtasks is refused; a no-op move is ignored', () => {
    const { rows } = setup()
    expect(planRowMove(rows, 3, 4, 7)).toEqual({ kind: 'refuse', message: t.guard.moveMixed })
    expect(planRowMove(rows, 1, 1, 2)).toEqual({ kind: 'ignore' })
  })
})

describe('removing rows (spec §9.2.7)', () => {
  it('a to-do takes its subtasks along; every uid that leaves is listed', () => {
    const { rows } = setup()
    const plan = planRemoval(rows, [{ start: 1, end: 1 }])!
    expect(plan.spans).toEqual([{ start: 1, end: 3 }])
    expect(plan.extended).toBe(true)
    expect(plan.todos.map((f) => [f.row.uid, f.subtasks.map((s) => s.uid)])).toEqual([['u-1', ['u-2', 'u-3']]])
    expect(plan.subtasks).toEqual([])
    expect(plan.uids).toEqual(['u-1', 'u-2', 'u-3'])
  })

  it('a subtask alone is listed as a subtask; rows without tasks ask nothing', () => {
    const { rows } = setup()
    const plan = planRemoval(rows, [{ start: 6, end: 6 }])!
    expect(plan.subtasks.map((s) => s.uid)).toEqual(['u-6'])
    expect(plan.todos).toEqual([])
    expect(plan.extended).toBe(false)
    expect(planRemoval(rows, [{ start: 20, end: 25 }])).toBeNull()
  })
})
