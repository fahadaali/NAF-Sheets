import { readTasks } from '@naf-sheets/sheet-model'
import type { IRange } from '@univerjs/core'
import { describe, expect, it } from 'vitest'
import { snapshotReader } from '../../src/sync/cells'
import { guardCommand, guardMutation, pastedColumnCount, stripSystem, type GuardContext } from '../../src/sync/guard'
import { needsIdentity, titleWriteWithIdentity } from '../../src/sync/identity'
import { sheetLayout, type SystemColumns } from '../../src/sync/layout'
import { readTaskRows } from '../../src/sync/rows'
import { t } from '../../src/strings'
import { applyPatch, COL, META, PLAN, put, SHEET, sheetOf, syncedWorkbook } from './sync-fixtures'

const ROW = 1
const range = (startRow: number, startColumn: number, endRow = startRow, endColumn = startColumn, rangeType = 0): IRange =>
  ({ startRow, startColumn, endRow, endColumn, rangeType }) as IRange

function context(selections: IRange[] = [range(1, 0)]) {
  const workbook = syncedWorkbook([{ title: 'A' }, { title: 'A.1', level: 1 }, { title: 'B' }])
  const reader = snapshotReader(sheetOf(workbook))
  const layout = sheetLayout(reader, META)!
  const ctx: GuardContext = { layout: layout as GuardContext['layout'], reader, selections }
  return { workbook, reader, layout, ctx }
}

describe('system columns: commands that would write to them are refused', () => {
  it('typing into a system cell is refused; typing a title is allowed', () => {
    const { ctx } = context()
    expect(guardCommand('sheet.command.set-range-values', { range: range(ROW, COL.uid), value: { v: 'x' } }, ctx)).toEqual({ kind: 'refuse', message: t.guard.systemColumns })
    expect(guardCommand('sheet.command.set-range-values', { range: range(ROW, COL.title), value: { v: 'x' } }, ctx)).toEqual({ kind: 'allow' })
    expect(guardCommand('sheet.command.set-range-values', { value: { 1: { [COL.level]: { v: 1 } } } }, ctx).kind).toBe('refuse')
  })

  it('clearing whole rows runs again with the system columns left out (a copy; the original params are untouched)', () => {
    const { ctx } = context([range(1, 0, 2, 0, 1)])
    const params = { unitId: 'wb', subUnitId: SHEET }
    const frozen = JSON.stringify(params)
    const decision = guardCommand('sheet.command.clear-selection-content', params, ctx)
    expect(decision.kind).toBe('replace')
    const ranges = (decision as unknown as { params: { ranges: IRange[] } }).params.ranges
    expect(ranges.map((r) => [r.startRow, r.endRow, r.startColumn, r.endColumn])).toEqual([[1, 2, 0, COL.uid - 1]])
    expect(JSON.stringify(params)).toBe(frozen)
  })

  it('a range between and around the system columns is split around them', () => {
    const { reader } = context()
    const system: SystemColumns = { uid: 7, parentUid: 8, level: 9 }
    expect(stripSystem(range(1, 5, 1, 12), system, reader).map((r) => [r.startColumn, r.endColumn])).toEqual([
      [5, 6],
      [10, 12],
    ])
    expect(stripSystem(range(1, 7, 1, 9), system, reader)).toEqual([])
  })

  it('fill, column removal, column moves and cell shifts that reach them are refused', () => {
    const { ctx } = context()
    expect(guardCommand('sheet.command.auto-fill', { sourceRange: range(1, 0, 1, 9), targetRange: range(2, 0, 3, 9) }, ctx).kind).toBe('refuse')
    expect(guardCommand('sheet.command.auto-fill', { sourceRange: range(1, 3), targetRange: range(2, 3, 5, 3) }, ctx).kind).toBe('allow')
    expect(guardCommand('sheet.command.remove-col', { range: range(0, 8, 999, 8, 2) }, ctx).kind).toBe('refuse')
    expect(guardCommand('sheet.command.remove-col', { range: range(0, 3, 999, 3, 2) }, ctx).kind).toBe('allow')
    expect(guardCommand('sheet.command.insert-col', { range: range(0, 8, 999, 8, 2) }, ctx).kind).toBe('refuse')
    // Inserting before them shifts them; they are found again by their header text.
    expect(guardCommand('sheet.command.insert-col', { range: range(0, 2, 999, 2, 2) }, ctx).kind).toBe('allow')
    expect(guardCommand('sheet.command.move-cols', { fromRange: range(0, 2, 999, 2, 2), toRange: range(0, 8, 999, 8, 2) }, { ...ctx, selections: [range(0, 2, 999, 2, 2)] }).kind).toBe('refuse')
    expect(guardCommand('sheet.command.delete-range-move-left', { range: range(1, 2) }, ctx)).toEqual({ kind: 'refuse', message: t.guard.shiftCells })
    expect(guardCommand('sheet.command.delete-range-move-left', { range: range(40, 2) }, ctx).kind).toBe('allow')
    expect(guardCommand('sheet.command.move-range', { fromRange: range(1, 0, 1, 9), toRange: range(8, 0, 8, 9) }, ctx).kind).toBe('refuse')
    expect(guardCommand('sheet.command.set-col-visible-on-cols', { ranges: [range(0, 5, 999, 9, 2)] }, ctx)).toEqual({ kind: 'refuse', message: t.guard.unhide })
  })

  it('a paste is refused when it would reach them, measured from the clipboard', () => {
    const { ctx } = context([range(1, 5)])
    const twoColumns = { textContent: 'a\tb' }
    const fourColumns = { textContent: 'a\tb\tc\td' }
    expect(pastedColumnCount(fourColumns)).toBe(4)
    expect(pastedColumnCount({ htmlContent: '<table><tr><td>a</td><td colspan="3">b</td></tr></table>' })).toBe(4)
    expect(guardCommand('sheet.command.paste-by-short-key', twoColumns, ctx).kind).toBe('allow')
    expect(guardCommand('sheet.command.paste-by-short-key', fourColumns, ctx)).toEqual({ kind: 'refuse', message: t.guard.paste })
    expect(guardCommand('sheet.command.paste-by-short-key', twoColumns, { ...ctx, selections: [range(1, 0, 1, 0, 1)] }).kind).toBe('refuse')
  })

  it('a sort is widened to whole rows so every identity travels with its row', () => {
    const { ctx } = context()
    const params = { unitId: 'wb', subUnitId: SHEET, range: range(1, 0, 3, 6), orderRules: [{ colIndex: 3, type: 'asc' }], hasTitle: false }
    const decision = guardCommand('sheet.command.sort-range', params, ctx)
    expect(decision.kind).toBe('replace')
    const widened = (decision as unknown as { params: { range: IRange; orderRules: unknown } }).params
    expect([widened.range.startColumn, widened.range.endColumn]).toEqual([0, COL.level])
    expect(widened.orderRules).toBe(params.orderRules)
    expect(params.range.endColumn).toBe(6)
    expect(guardCommand('sheet.command.sort-range', { ...params, range: range(1, 0, 3, 12) }, ctx).kind).toBe('allow')
  })

  it('row moves are not this guard’s business; unknown commands pass', () => {
    const { ctx } = context()
    expect(guardCommand('sheet.command.move-rows', { fromRange: range(1, 0), toRange: range(3, 0) }, ctx).kind).toBe('allow')
    expect(guardCommand('sheet.command.set-bold', {}, ctx).kind).toBe('allow')
  })
})

describe('backstop on mutations', () => {
  it('refuses a content change in a system cell, allows the same value and style-only changes', () => {
    const { ctx } = context()
    const write = (cell: unknown) => guardMutation('sheet.mutation.set-range-values', { unitId: 'wb', subUnitId: SHEET, cellValue: { 1: { [COL.uid]: cell } } }, ctx)
    expect(write({ v: 'other' }).kind).toBe('refuse')
    expect(write(null).kind).toBe('refuse')
    expect(write({ v: 'u-1', t: 1 }).kind).toBe('allow')
    expect(write({ s: { bl: 1 } }).kind).toBe('allow')
    expect(guardMutation('sheet.mutation.set-range-values', { cellValue: { 1: { 0: { v: 'title' } } } }, ctx).kind).toBe('allow')
    expect(guardMutation('sheet.mutation.remove-col', { range: range(0, 9, 999, 9, 2) }, ctx).kind).toBe('refuse')
  })
})

describe('a new row that gets a title gets its identity in the same edit', () => {
  it('the title write carries uid, parent and level, which sheet-model reads back', () => {
    const { workbook, reader, layout } = context()
    const rows = readTaskRows(reader, layout)
    const params = { unitId: 'wb', subUnitId: SHEET, range: range(4, COL.title), value: { v: 'مهمة جديدة' } }
    const copy = titleWriteWithIdentity(params, layout, reader, rows, () => 'new-uid')!
    expect(copy.range).toBeUndefined()
    expect(params.range.startRow).toBe(4)
    const cells = (copy.value as Record<number, Record<number, Record<string, unknown>>>)[4]!
    expect(cells[COL.title]).toEqual({ v: 'مهمة جديدة' })
    expect(cells[COL.uid]).toEqual({ v: 'new-uid', t: 1 })
    expect(cells[COL.level]).toEqual({ v: 0, t: 2 })
    // Applied as Univer applies it, then read by the server's reader.
    put(workbook, 4, Object.fromEntries(Object.entries(cells).map(([c, p]) => [c, applyPatch(undefined, p)])))
    const read = readTasks(workbook, SHEET, PLAN)
    expect(read.ok && read.value.tasks.map((task) => [task.uid, task.title, task.level])).toContainEqual(['new-uid', 'مهمة جديدة', 0])
    expect(read.ok && read.value.issues).toEqual([])
  })

  it('nothing is added for a row that has a uid, an empty title, or another column', () => {
    const { reader, layout } = context()
    const rows = readTaskRows(reader, layout)
    const uid = () => 'x'
    expect(titleWriteWithIdentity({ range: range(1, COL.title), value: { v: 'جديد' } }, layout, reader, rows, uid)).toBeNull()
    expect(titleWriteWithIdentity({ range: range(4, COL.title), value: { v: '  ' } }, layout, reader, rows, uid)).toBeNull()
    expect(titleWriteWithIdentity({ range: range(4, COL.due), value: { v: '2026-11-20' } }, layout, reader, rows, uid)).toBeNull()
    expect(needsIdentity(reader, layout, 1)).toBe(false)
  })
})
