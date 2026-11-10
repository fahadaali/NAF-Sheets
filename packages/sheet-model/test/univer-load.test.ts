// Snapshots written by this package, loaded into a headless Univer 1.4.0:
// formulas still compute (computed by the engine, cached values poisoned),
// the system columns are hidden, marks and indentation are cell styles Univer
// reads, notes load, and the platform's cell data survives Univer's own save.

import { IResourceManagerService, UniverInstanceType } from '@univerjs/core'
import { SheetsNoteModel } from '@univerjs/sheets-note'
import { afterEach, describe, expect, it } from 'vitest'
import { applyInbound, ensureSystemColumns, indentTaskRow, isoToSerial, readTasks, type WorkbookSnapshot } from '../src'
import type { LocalTask, SheetPlan } from '@naf-sheets/shared'
import { blankWorkbook, counterUids, defaultPlan, putRow } from './helpers'
import { loadHeadless, poison, waitFor, type HeadlessUniver } from './headless-univer'

const S = 'sheet-1'
const SUM = 'sheet-2'
// Values a theme would supply (test data, not interface code).
const deletedStyle = { st: { s: 1 }, cl: { rgb: '#8a8a8a' } }
const unsyncedStyle = { bg: { rgb: '#f2f2f2' } }

function fixture(): { workbook: WorkbookSnapshot; plan: SheetPlan } {
  const workbook = blankWorkbook([
    { id: S, title: 'المهام' },
    { id: SUM, title: 'الملخص' },
  ])
  putRow(workbook, S, 0, { H: 'الأيام المتبقية' })
  putRow(workbook, S, 1, { A: 'إعداد الخطة', D: { v: 46340, t: 2 }, H: { f: '=D2-46336' } })
  putRow(workbook, S, 2, { A: 'تصميم', B: 'سارة', D: { v: 46345, t: 2 }, H: { f: '=D3-46336' } })
  putRow(workbook, S, 3, { A: 'نشر', D: { v: 46350, t: 2 }, H: { f: '=D4-46336' } })
  workbook.sheets[SUM]!.cellData = {
    0: {
      0: { f: "=COUNTA('المهام'!A2:A20)" },
      1: { f: "=SUM('المهام'!H2:H20)" },
      2: { f: '=DATE(2026,11,10)' },
      3: { f: "=MAX('المهام'!D2:D20)" },
    },
  }
  workbook.resources = [
    { name: 'SHEET_NOTE_PLUGIN', data: JSON.stringify({ [S]: { 2: { 1: { id: 'n1', row: 2, col: 1, width: 160, height: 72, note: 'تأكد من الهوية' } } } }) },
    {
      name: 'SHEET_DATA_VALIDATION_PLUGIN',
      data: JSON.stringify({ [S]: [{ uid: 'dv1', type: 'checkbox', ranges: [{ startRow: 1, endRow: 9, startColumn: 4, endColumn: 4 }] }] }),
    },
  ]
  const plan = defaultPlan(S)
  const ensured = ensureSystemColumns(workbook.sheets[S] as never, plan, counterUids())
  if (!ensured.ok) throw new Error(ensured.error.message)
  workbook.sheets[S] = ensured.value.sheet
  return { workbook, plan }
}

let u: HeadlessUniver | undefined
afterEach(() => {
  u?.dispose()
  u = undefined
})

function value(h: HeadlessUniver, sheetId: string, row: number, col: number): unknown {
  return h.workbook.getSheetBySheetId(sheetId)?.getCellRaw(row, col)?.v
}

describe('after ensureSystemColumns', () => {
  it('formulas compute as before, and the system columns are hidden', async () => {
    const { workbook } = fixture()
    u = loadHeadless(poison(workbook))
    const h = u
    await h.calculate()
    await waitFor(() => value(h, SUM, 0, 0) !== -1 && value(h, SUM, 0, 1) !== -1)
    expect(value(h, SUM, 0, 0)).toBe(3)
    expect(value(h, SUM, 0, 1)).toBe(4 + 9 + 14)
    expect(value(h, S, 1, 7)).toBe(4)
    const sheet = h.workbook.getSheetBySheetId(S)
    // A..H are user columns (H holds the formulas); I, J, K are the system columns.
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((c) => sheet?.getColVisible(c))).toEqual(Array(8).fill(true))
    expect([8, 9, 10].map((c) => sheet?.getColVisible(c))).toEqual([false, false, false])
    expect(sheet?.getCellRaw(0, 8)?.v).toBe('__uid')
  })

  it('date serials match the engine in both date systems', async () => {
    const { workbook } = fixture()
    u = loadHeadless(poison(workbook))
    const h = u
    await h.calculate()
    await waitFor(() => value(h, SUM, 0, 2) !== -1)
    expect(value(h, SUM, 0, 2)).toBe(isoToSerial('2026-11-10'))
    h.dispose()
    const d1904 = { ...fixture().workbook, dateSystem: 'date1904' } as WorkbookSnapshot
    u = loadHeadless(poison(d1904))
    const h2 = u
    await h2.calculate()
    await waitFor(() => value(h2, SUM, 0, 2) !== -1)
    expect(value(h2, SUM, 0, 2)).toBe(isoToSerial('2026-11-10', 'date1904'))
  })
})

describe('after applyInbound and indentTaskRow', () => {
  function changed() {
    const { workbook, plan } = fixture()
    const task: LocalTask = {
      uid: 'n-1',
      sheetId: plan.sheetId,
      parentUid: null,
      level: 0,
      position: 1,
      title: 'مهمة من Basecamp',
      assignees: [],
      dueOn: '2026-11-12',
      startsOn: null,
      completed: true,
      notesHtml: '<div>من <strong>Basecamp</strong></div>',
      freeColumnsForDescription: {},
      attachments: [],
      assignMode: 'auto',
      localChangedAt: null,
      bcId: 77,
      deletedRemotely: false,
    }
    const inbound = applyInbound(
      workbook,
      S,
      plan,
      [
        { type: 'create_row', task, remote: {} as never },
        { type: 'update_row', uid: 'u-3', fields: { dueOn: '2026-11-30' } },
        { type: 'mark_deleted_remotely', uid: 'u-2', status: 'trashed' },
      ],
      { deletedStyle },
    )
    if (!inbound.ok) throw new Error(inbound.error.message)
    expect(inbound.value.outcomes.map((o) => o.status)).toEqual(['applied', 'applied', 'applied'])
    const indented = indentTaskRow(inbound.value.workbook, S, plan, 'u-2', { subtaskIndent: 18, unsyncedStyle })
    if (!indented.ok) throw new Error(indented.error.message)
    return { workbook: indented.value.workbook, plan }
  }

  it('formulas compute with the rows in their new places', async () => {
    const { workbook } = changed()
    u = loadHeadless(poison(workbook))
    const h = u
    await h.calculate()
    await waitFor(() => value(h, SUM, 0, 0) !== -1 && value(h, SUM, 0, 1) !== -1 && value(h, SUM, 0, 3) !== -1)
    const sheet = h.workbook.getSheetBySheetId(S)
    expect([1, 2, 3, 4].map((r) => sheet?.getCellRaw(r, 0)?.v)).toEqual(['مهمة من Basecamp', 'إعداد الخطة', 'تصميم', 'نشر'])
    // Per-row formulas moved with their rows and still read their own row.
    expect([2, 3, 4].map((r) => sheet?.getCellRaw(r, 7)?.f)).toEqual(['=D3-46336', '=D4-46336', '=D5-46336'])
    await waitFor(() => sheet?.getCellRaw(4, 7)?.v !== undefined)
    // 2026-11-30 is 20 days after 2026-11-10 (serial 46336).
    expect([2, 3, 4].map((r) => sheet?.getCellRaw(r, 7)?.v)).toEqual([4, 9, 20])
    expect(value(h, SUM, 0, 0)).toBe(4)
    expect(value(h, SUM, 0, 1)).toBe(4 + 9 + 20)
    expect(value(h, SUM, 0, 3)).toBe(isoToSerial('2026-11-30'))
    expect([8, 9, 10].map((c) => sheet?.getColVisible(c))).toEqual([false, false, false])
  })

  it('styles, indentation, notes and validation are read by Univer as written', async () => {
    const { workbook, plan } = changed()
    u = loadHeadless(workbook)
    const h = u
    const sheet = h.workbook.getSheetBySheetId(S)
    // «تصميم» (u-2): deleted in Basecamp, then made a subtask.
    expect(sheet?.getComposedCellStyle(3, 0)).toMatchObject({ st: { s: 1 }, cl: { rgb: '#8a8a8a' }, pd: { l: 18 } })
    expect(sheet?.getComposedCellStyle(3, 6)).toMatchObject({ bg: { rgb: '#f2f2f2' } })
    expect(sheet?.getComposedCellStyle(2, 0).st).toBeUndefined()
    // The new row's date got a serial and a YYYY-MM-DD format.
    expect(sheet?.getCellRaw(1, 3)).toMatchObject({ v: isoToSerial('2026-11-12'), s: { n: { pattern: 'yyyy-mm-dd' } } })
    const notes = h.get<SheetsNoteModel>(SheetsNoteModel)
    const unitId = h.workbook.getUnitId()
    expect(notes.getNote(unitId, S, { row: 3, col: 1 })?.note).toBe('تأكد من الهوية')
    expect(notes.getNote(unitId, S, { row: 3, col: 6 })?.note).toBe('لا يُزامَن مع Basecamp')
    const resources = h.resources()
    expect((resources.SHEET_DATA_VALIDATION_PLUGIN as Record<string, Array<{ ranges: unknown }>>)[S]?.[0]?.ranges).toEqual([
      { startRow: 1, endRow: 9, startColumn: 4, endColumn: 4 },
    ])
    // Univer's own save keeps every platform field: reading it back gives the same tasks.
    const saved = { ...h.workbook.save(), resources: h.get<IResourceManagerService>(IResourceManagerService).getResources(unitId, UniverInstanceType.UNIVER_SHEET) }
    const before = readTasks(workbook, S, plan)
    const after = readTasks(saved as WorkbookSnapshot, S, plan)
    expect(after).toEqual(before)
    expect(after.ok && after.value.tasks.map((t) => [t.uid, t.level, t.parentUid, t.completed, t.deletedRemotely])).toEqual([
      ['n-1', 0, null, true, false],
      ['u-1', 0, null, false, false],
      ['u-2', 1, 'u-1', false, true],
      ['u-3', 0, null, false, false],
    ])
    expect(after.ok && after.value.tasks[0]?.notesHtml).toBe('<div>من <strong>Basecamp</strong></div>')
  })
})
