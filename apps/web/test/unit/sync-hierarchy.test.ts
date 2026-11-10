import { indentTaskRow, outdentTaskRow, type WorkbookSnapshot } from '@naf-sheets/sheet-model'
import { ERROR_MESSAGES } from '@naf-sheets/sync-engine'
import type { ICellData } from '@univerjs/core'
import { describe, expect, it } from 'vitest'
import { snapshotReader } from '../../src/sync/cells'
import { cellPatch, planHierarchyEdit, writesAsMatrix } from '../../src/sync/hierarchy-edit'
import { sheetLayout } from '../../src/sync/layout'
import { readTaskRows } from '../../src/sync/rows'
import { applyPatch, COL, META, SHEET, sheetOf, syncedWorkbook } from './sync-fixtures'

const INDENT = 16

/** The editor's writes applied to a copy, the way Univer merges them. */
function applyWrites(workbook: WorkbookSnapshot, writes: ReturnType<typeof planHierarchyEdit>): WorkbookSnapshot {
  if (!writes.ok) throw new Error(writes.message)
  const out = structuredClone(workbook)
  const data = sheetOf(out).cellData as Record<number, Record<number, ICellData | undefined>>
  for (const w of writes.writes) {
    data[w.row] ??= {}
    const next = applyPatch(data[w.row]![w.column], w.patch, out.styles as Record<string, unknown>)
    if (next === undefined) delete data[w.row]![w.column]
    else data[w.row]![w.column] = next
  }
  return out
}

/** Every task row's [uid, level, parent, title, title style] in sheet order. */
function shape(workbook: WorkbookSnapshot) {
  const reader = snapshotReader(sheetOf(workbook))
  const layout = sheetLayout(reader, META)!
  const styleOf = (c: ICellData | null | undefined) => (typeof c?.s === 'string' ? (workbook.styles as Record<string, unknown>)[c.s] : (c?.s ?? null))
  return readTaskRows(reader, layout).map((r) => [r.uid, r.level, r.parentUid, reader.cell(r.row, COL.title)?.v, styleOf(reader.cell(r.row, COL.title))])
}

const layoutOf = (workbook: WorkbookSnapshot) => sheetLayout(snapshotReader(sheetOf(workbook)), META)!

describe('Tab / Shift+Tab: exactly what sheet-model computes', () => {
  it('indent writes level, parent and the title indentation, and nothing else', () => {
    const workbook = syncedWorkbook([{ title: 'A' }, { title: 'B' }, { title: 'C' }])
    const edit = planHierarchyEdit(workbook, layoutOf(workbook), 'u-2', 'indent', { subtaskIndent: INDENT })
    expect(edit.ok).toBe(true)
    const expected = indentTaskRow(workbook, SHEET, layoutOf(workbook).plan!, 'u-2', { subtaskIndent: INDENT })
    expect(expected.ok).toBe(true)
    const ours = applyWrites(workbook, edit)
    expect(shape(ours)).toEqual(shape(expected.ok ? expected.value.workbook : workbook))
    expect(shape(ours)[1]?.slice(0, 3)).toEqual(['u-2', 1, 'u-1'])
    expect((edit.ok ? edit.writes : []).map((w) => [w.row, w.column]).sort()).toEqual([
      [2, COL.title],
      [2, COL.parent],
      [2, COL.level],
    ])
    // The title keeps its text; only its padding is added (reversible mark).
    const title = sheetOf(ours).cellData?.[2]?.[COL.title] as ICellData
    expect(title.v).toBe('B')
    expect((title.s as { pd?: { l?: number } }).pd?.l).toBe(INDENT)
  })

  it('outdent of a middle subtask moves it after its former siblings, as sheet-model does', () => {
    const workbook = syncedWorkbook([{ title: 'A' }, { title: 'A.1', level: 1 }, { title: 'A.2', level: 1 }, { title: 'A.3', level: 1 }, { title: 'B' }])
    // A to-do with subtasks cannot be indented (a third level).
    expect(planHierarchyEdit(workbook, layoutOf(workbook), 'u-1', 'indent')).toEqual({ ok: false, message: ERROR_MESSAGES.parent_has_subtasks })
    const edit = planHierarchyEdit(workbook, layoutOf(workbook), 'u-2', 'outdent', { subtaskIndent: INDENT })
    const expected = outdentTaskRow(workbook, SHEET, layoutOf(workbook).plan!, 'u-2', { subtaskIndent: INDENT })
    expect(expected.ok).toBe(true)
    const ours = applyWrites(workbook, edit)
    expect(shape(ours)).toEqual(shape(expected.ok ? expected.value.workbook : workbook))
    expect(shape(ours).map((s) => s.slice(0, 3))).toEqual([
      ['u-1', 0, null],
      ['u-3', 1, 'u-1'],
      ['u-4', 1, 'u-1'],
      ['u-2', 0, null],
      ['u-5', 0, null],
    ])
  })

  it('a third level is refused with the sync engine’s Arabic message, and nothing is written', () => {
    const workbook = syncedWorkbook([{ title: 'A' }, { title: 'A.1', level: 1 }])
    expect(planHierarchyEdit(workbook, layoutOf(workbook), 'u-2', 'indent')).toEqual({ ok: false, message: ERROR_MESSAGES.third_level_not_allowed })
    const single = syncedWorkbook([{ title: 'A' }])
    expect(planHierarchyEdit(single, layoutOf(single), 'u-1', 'indent')).toEqual({ ok: false, message: ERROR_MESSAGES.no_parent_above })
  })

  it('the writes form one command value (one undo step)', () => {
    const workbook = syncedWorkbook([{ title: 'A' }, { title: 'B' }])
    const edit = planHierarchyEdit(workbook, layoutOf(workbook), 'u-2', 'indent')
    const matrix = writesAsMatrix(edit.ok ? edit.writes : [])
    expect(Object.keys(matrix)).toEqual(['2'])
    expect(matrix[2]![COL.level]).toEqual({ v: 1, t: 2 })
    expect(matrix[2]![COL.parent]).toEqual({ v: 'u-1', t: 1 })
  })
})

describe('cell patches in Univer’s merge terms', () => {
  it('removed keys are sent as null, style keys too', () => {
    expect(cellPatch({ v: 'a', s: { bl: 1, pd: { l: 16 } }, custom: { x: 1 } }, { v: 'a', s: { bl: 1 } }, {}, {})).toEqual({ custom: null, s: { bl: 1, pd: null } })
    expect(cellPatch({ v: 'u-1', t: 1 }, undefined, {}, {})).toEqual({ v: null })
    expect(cellPatch({ v: 1, t: 2 }, { v: 1, t: 2 }, {}, {})).toBeNull()
    expect(cellPatch({ v: 'a', s: 'id1' }, { v: 'a', s: { bl: 1 } }, { id1: { bl: 1 } }, {})).toBeNull()
  })
})
