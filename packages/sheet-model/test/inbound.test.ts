import type { InboundAction, LocalTask, RemoteTodo, SheetPlan } from '@naf-sheets/shared'
import { describe, expect, it } from 'vitest'
import { applyInbound, readTasks, type ApplyInboundOptions, type AssigneeDirectory, type WorkbookSnapshot } from '../src'
import { cell, counterUids, defaultPlan, linkedWorkbook, platformId, putRow, uidTitles } from './helpers'
import { ensureSystemColumns } from '../src'

const S = 'sheet-1'
// Style values come from the caller's theme; these stand in for them.
const deletedStyle = { st: { s: 1 }, cl: { rgb: 'theme-muted' } } as const
const directory: AssigneeDirectory = {
  people: [
    { id: 11, name: 'سارة' },
    { id: 12, name: 'عمر' },
  ],
  externals: [{ id: 'ext-1', name: 'وكالة الإبداع' }],
}
const options: ApplyInboundOptions = { deletedStyle, directory }

function apply(workbook: WorkbookSnapshot, actions: InboundAction[], plan: SheetPlan = defaultPlan(S), opts: ApplyInboundOptions = options) {
  const frozen = structuredClone(workbook)
  const result = applyInbound(workbook, S, plan, actions, opts)
  if (!result.ok) throw new Error(result.error.message)
  expect(workbook).toEqual(frozen) // never mutates its input
  return result.value
}

function readBack(workbook: WorkbookSnapshot, plan: SheetPlan = defaultPlan(S), sheetId = S) {
  const r = readTasks(workbook, sheetId, plan, { directory })
  if (!r.ok) throw new Error(r.error.message)
  return r.value.tasks
}

function newTask(uid: string, title: string, position: number, extra: Partial<LocalTask> = {}): LocalTask {
  return {
    uid,
    sheetId: platformId(S),
    parentUid: null,
    level: 0,
    position,
    title,
    assignees: [],
    dueOn: null,
    startsOn: null,
    completed: false,
    notesHtml: null,
    freeColumnsForDescription: {},
    attachments: [],
    assignMode: 'auto',
    localChangedAt: null,
    bcId: 500,
    deletedRemotely: false,
    ...extra,
  }
}
const remote = {} as RemoteTodo

describe('update_row', () => {
  it('writes only the mapped cells it carries', () => {
    const { workbook } = linkedWorkbook(['إعداد الخطة', 'تصميم'])
    putRow(workbook, S, 1, { C: { v: 46300, t: 2 }, F: 'مرفق محلي' })
    const result = apply(workbook, [
      { type: 'update_row', uid: 'u-1', fields: { title: 'إعداد الخطة النهائية', dueOn: '2026-11-20', assignees: [{ kind: 'bc_person', bcPersonId: 12, source: 'manual' }] } },
    ])
    expect(result.outcomes).toEqual([{ index: 0, type: 'update_row', uid: 'u-1', status: 'applied' }])
    const wb = result.workbook
    expect(cell(wb, S, 1, 'A')).toEqual({ v: 'إعداد الخطة النهائية', t: 1 })
    expect(cell(wb, S, 1, 'B')).toEqual({ v: 'عمر', t: 1 })
    // An empty date cell gets a serial and the YYYY-MM-DD format.
    expect(cell(wb, S, 1, 'D')).toEqual({ v: 46346, t: 2, s: { n: { pattern: 'yyyy-mm-dd' } } })
    expect(cell(wb, S, 1, 'C')).toEqual({ v: 46300, t: 2 })
    expect(cell(wb, S, 1, 'F')).toEqual({ v: 'مرفق محلي' })
    expect(result.changedCells).toEqual([
      { sheetId: S, row: 1, column: 0 },
      { sheetId: S, row: 1, column: 1 },
      { sheetId: S, row: 1, column: 3 },
    ])
    expect(readBack(wb)[0]).toMatchObject({ title: 'إعداد الخطة النهائية', dueOn: '2026-11-20', assignees: [{ kind: 'bc_person', bcPersonId: 12 }] })
  })

  it('never writes over a formula, and says so', () => {
    const { workbook } = linkedWorkbook(['مهمة'])
    putRow(workbook, S, 1, { D: { f: '=TODAY()+7', v: 46343 } })
    const result = apply(workbook, [{ type: 'update_row', uid: 'u-1', fields: { dueOn: '2026-12-01' } }])
    expect(cell(result.workbook, S, 1, 'D')).toEqual({ f: '=TODAY()+7', v: 46343 })
    expect(result.issues.map((i) => [i.code, i.row, i.column])).toEqual([['formula_cell', 1, 3]])
    expect(result.issues[0]?.message).toMatch(/معادلة/)
  })

  it('keeps a date written as text as text, and clears with null', () => {
    const { workbook } = linkedWorkbook(['أ', 'ب'])
    putRow(workbook, S, 1, { D: { v: '2026-11-01', t: 1, s: 'st1' } })
    putRow(workbook, S, 2, { D: { v: 46300, t: 2 } })
    const result = apply(workbook, [
      { type: 'update_row', uid: 'u-1', fields: { dueOn: '2026-11-02' } },
      { type: 'update_row', uid: 'u-2', fields: { dueOn: null } },
    ])
    expect(cell(result.workbook, S, 1, 'D')).toEqual({ v: '2026-11-02', t: 1, s: 'st1' })
    expect(cell(result.workbook, S, 2, 'D')).toBeUndefined()
  })

  it('writes completion the way the column holds it', () => {
    const { workbook } = linkedWorkbook(['أ', 'ب', 'ج'])
    workbook.resources = [
      { name: 'SHEET_DATA_VALIDATION_PLUGIN', data: JSON.stringify({ [S]: [{ uid: 'dv', type: 'checkbox', ranges: [{ startRow: 1, endRow: 1, startColumn: 4, endColumn: 4 }] }] }) },
    ]
    const checkbox = apply(workbook, [{ type: 'update_row', uid: 'u-1', fields: { completed: true } }])
    expect(cell(checkbox.workbook, S, 1, 'E')).toEqual({ v: 1, t: 2 })
    const unticked = apply(checkbox.workbook, [{ type: 'update_row', uid: 'u-1', fields: { completed: false } }])
    expect(cell(unticked.workbook, S, 1, 'E')).toEqual({ v: 0, t: 2 })

    const plan = defaultPlan(S, { completedValues: ['منجز', 'تم'] })
    putRow(workbook, S, 2, { E: 'قيد التنفيذ' })
    putRow(workbook, S, 3, { E: 'تم' })
    const status = apply(workbook, [
      { type: 'update_row', uid: 'u-2', fields: { completed: true } },
      { type: 'update_row', uid: 'u-3', fields: { completed: false } },
    ], plan)
    expect(cell(status.workbook, S, 2, 'E')).toEqual({ v: 'منجز', t: 1 })
    expect(cell(status.workbook, S, 3, 'E')).toBeUndefined()
    expect(readBack(status.workbook, plan).map((t) => t.completed)).toEqual([false, true, false])

    const plain = apply(workbook, [{ type: 'update_row', uid: 'u-1', fields: { completed: true } }], defaultPlan(S), options)
    expect(cell(plain.workbook, S, 1, 'E')).toEqual({ v: 1, t: 2 }) // the checkbox rule covers row 1
    const bool = apply(linkedWorkbook(['أ']).workbook, [{ type: 'update_row', uid: 'u-1', fields: { completed: true } }])
    expect(cell(bool.workbook, S, 1, 'E')).toEqual({ v: 1, t: 3 })
  })

  it('writes assignees as Univer\'s JSON list in a multiple-choice column, and refuses unknown names', () => {
    const { workbook } = linkedWorkbook(['أ', 'ب'])
    workbook.resources = [
      { name: 'SHEET_DATA_VALIDATION_PLUGIN', data: JSON.stringify({ [S]: [{ uid: 'dv', type: 'listMultiple', formula1: '["سارة","عمر"]', ranges: [{ startRow: 1, endRow: 1, startColumn: 1, endColumn: 1 }] }] }) },
    ]
    putRow(workbook, S, 2, { B: 'سارة' })
    const result = apply(workbook, [
      {
        type: 'update_row',
        uid: 'u-1',
        fields: {
          assignees: [
            { kind: 'bc_person', bcPersonId: 11, source: 'auto' },
            { kind: 'external', externalContactId: 'ext-1', source: 'manual', notifyEmail: true },
          ],
        },
      },
      { type: 'update_row', uid: 'u-2', fields: { assignees: [{ kind: 'bc_person', bcPersonId: 99, source: 'manual' }] } },
    ])
    expect(cell(result.workbook, S, 1, 'B')).toEqual({ v: '["سارة","وكالة الإبداع"]', t: 1 })
    expect(cell(result.workbook, S, 2, 'B')).toEqual({ v: 'سارة' })
    expect(result.issues.map((i) => [i.code, i.detail])).toEqual([['assignee_name_unknown', '99']])
    const plain = apply(workbook, [{ type: 'update_row', uid: 'u-2', fields: { assignees: [{ kind: 'bc_person', bcPersonId: 11, source: 'manual' }, { kind: 'bc_person', bcPersonId: 12, source: 'manual' }] } }])
    expect(cell(plain.workbook, S, 2, 'B')).toEqual({ v: 'سارة، عمر', t: 1 })
  })

  it('round-trips the description HTML through the notes cell', () => {
    const { workbook } = linkedWorkbook(['مهمة'])
    const html = '<div>اقرأ <strong>المسودة</strong><br>ثم وقّع</div><bc-attachment sgid="BAh"></bc-attachment>'
    const result = apply(workbook, [{ type: 'update_row', uid: 'u-1', fields: { notesHtml: html } }])
    expect(cell(result.workbook, S, 1, 'G')).toEqual({ v: 'اقرأ المسودة\nثم وقّع', t: 1, custom: { nafSheets: { notesHtml: html } } })
    expect(readBack(result.workbook)[0]?.notesHtml).toBe(html)
    const again = apply(result.workbook, [{ type: 'update_row', uid: 'u-1', fields: { notesHtml: html } }])
    expect(again.changedCells).toEqual([])
    const cleared = apply(result.workbook, [{ type: 'update_row', uid: 'u-1', fields: { notesHtml: null } }])
    expect(cell(cleared.workbook, S, 1, 'G')).toBeUndefined()
  })

  it('moves a row to its new position like a sort: formulas in moved rows follow their row', () => {
    const { workbook } = linkedWorkbook(['أ', 'ب', 'ج'])
    putRow(workbook, S, 1, { F: { f: '=D2+1', v: 10 } })
    putRow(workbook, S, 3, { F: { f: '=$D$2+D4', v: 20 } })
    const result = apply(workbook, [{ type: 'update_row', uid: 'u-3', fields: { position: 1 } }])
    expect(uidTitles(result.workbook)).toEqual([
      ['u-3', 'ج'],
      ['u-1', 'أ'],
      ['u-2', 'ب'],
    ])
    // Relative parts shift with the row, absolute ones stay; cached values are dropped to be computed again.
    expect(cell(result.workbook, S, 1, 'F')).toEqual({ f: '=$D$2+D2' })
    expect(cell(result.workbook, S, 2, 'F')).toEqual({ f: '=D3+1' })
    expect(readBack(result.workbook).map((t) => [t.uid, t.position])).toEqual([
      ['u-3', 1],
      ['u-1', 2],
      ['u-2', 3],
    ])
  })

  it('refuses an unknown row and leaves the workbook as it was for that action', () => {
    const { workbook } = linkedWorkbook(['أ'])
    const result = apply(workbook, [
      { type: 'update_row', uid: 'nope', fields: { title: 'x' } },
      { type: 'update_row', uid: 'u-1', fields: { title: 'ب' } },
      { type: 'rewrite_managed_block', uid: 'u-1', editedBlockHtml: '' },
    ])
    expect(result.outcomes.map((o) => [o.status, o.error?.code])).toEqual([
      ['refused', 'row_not_found'],
      ['applied', undefined],
      ['ignored', undefined],
    ])
    expect(cell(result.workbook, S, 1, 'A')?.v).toBe('ب')
  })
})

describe('create_row', () => {
  it('inserts a to-do at its position and its subtasks under it (§9.3.8)', () => {
    const { workbook } = linkedWorkbook(['أ', 'ب'])
    const todo = newTask('n-1', 'جديدة', 2, { dueOn: '2026-11-15', assignees: [{ kind: 'bc_person', bcPersonId: 11, source: 'manual' }] })
    const sub1 = newTask('n-2', 'فرعية ١', 1, { level: 1, parentUid: 'n-1', bcId: 501 })
    const sub2 = newTask('n-3', 'فرعية ٢', 1, { level: 1, parentUid: 'n-1', bcId: 502 })
    const result = apply(workbook, [
      { type: 'create_row', task: todo, remote },
      { type: 'create_row', task: sub1, remote },
      { type: 'create_row', task: sub2, remote },
    ])
    expect(result.outcomes.every((o) => o.status === 'applied')).toBe(true)
    expect(uidTitles(result.workbook)).toEqual([
      ['u-1', 'أ'],
      ['n-1', 'جديدة'],
      ['n-3', 'فرعية ٢'],
      ['n-2', 'فرعية ١'],
      ['u-2', 'ب'],
    ])
    const tasks = readBack(result.workbook)
    expect(tasks.map((t) => [t.uid, t.level, t.parentUid, t.position])).toEqual([
      ['u-1', 0, null, 1],
      ['n-1', 0, null, 2],
      ['n-3', 1, 'n-1', 1],
      ['n-2', 1, 'n-1', 2],
      ['u-2', 0, null, 3],
    ])
    expect(tasks[1]).toMatchObject({ dueOn: '2026-11-15', assignees: [{ kind: 'bc_person', bcPersonId: 11 }] })
  })

  it('takes the empty row under the table and never writes over data', () => {
    const { workbook } = linkedWorkbook(['أ', 'ب'])
    putRow(workbook, S, 3, { C: 'المجموع', D: { f: '=COUNTA(A2:A3)', v: 2 } })
    // Row 4 holds a total: no free row under the last task.
    const blocked = apply(workbook, [{ type: 'create_row', task: newTask('n-1', 'جديدة', 1), remote }])
    expect(blocked.outcomes[0]?.error?.code).toBe('no_free_row')
    expect(blocked.outcomes[0]?.error?.message).toMatch(/صفاً فارغاً/)
    expect(blocked.workbook).toBe(workbook)
    // A row that only carries formatting counts as free.
    const { workbook: styled } = linkedWorkbook(['أ'])
    putRow(styled, S, 2, { A: { s: { bd: { b: { s: 1, cl: { rgb: 'theme-border' } } } } } })
    const placed = apply(styled, [{ type: 'create_row', task: newTask('n-1', 'جديدة', 1), remote }])
    expect(uidTitles(placed.workbook)).toEqual([
      ['n-1', 'جديدة'],
      ['u-1', 'أ'],
    ])
    expect(cell(placed.workbook, S, 1, 'A')).toEqual({ s: { bd: { b: { s: 1, cl: { rgb: 'theme-border' } } } }, v: 'جديدة', t: 1 })
  })

  it('refuses a duplicate uid, a subtask without its to-do, an empty title and another sheet\'s task', () => {
    const { workbook } = linkedWorkbook(['أ'])
    const result = apply(workbook, [
      { type: 'create_row', task: newTask('u-1', 'نسخة', 1), remote },
      { type: 'create_row', task: newTask('n-2', 'فرعية', 1, { level: 1, parentUid: 'missing' }), remote },
      { type: 'create_row', task: newTask('n-3', '  ', 1), remote },
      // LocalTask.sheetId is the platform's sheet id, not the Univer one.
      { type: 'create_row', task: newTask('n-4', 'ورقة خطأ', 1, { sheetId: S }), remote },
    ])
    expect(result.outcomes.map((o) => o.error?.code)).toEqual(['uid_exists', 'parent_not_found', 'title_required', 'sheet_not_found'])
    expect(result.workbook).toBe(workbook)
  })

  it('moves notes and validation ranges with their rows', () => {
    const { workbook } = linkedWorkbook(['أ', 'ب'])
    workbook.resources = [
      { name: 'SHEET_NOTE_PLUGIN', data: JSON.stringify({ [S]: { 2: { 0: { id: 'n', row: 2, col: 0, width: 160, height: 72, note: 'ملاحظة على ب' } } } }) },
      { name: 'SHEET_DATA_VALIDATION_PLUGIN', data: JSON.stringify({ [S]: [{ uid: 'dv', type: 'checkbox', ranges: [{ startRow: 1, endRow: 2, startColumn: 4, endColumn: 4 }] }] }) },
    ]
    const result = apply(workbook, [{ type: 'create_row', task: newTask('n-1', 'جديدة', 1), remote }])
    const notes = JSON.parse(result.workbook.resources?.find((r) => r.name === 'SHEET_NOTE_PLUGIN')?.data ?? '{}')
    expect(notes[S]).toEqual({ 3: { 0: { id: 'n', row: 3, col: 0, width: 160, height: 72, note: 'ملاحظة على ب' } } })
    // Rows 2 and 3 held tasks with the checkbox; they moved to 3 and 4. The new row came from row 4.
    const dv = JSON.parse(result.workbook.resources?.find((r) => r.name === 'SHEET_DATA_VALIDATION_PLUGIN')?.data ?? '{}')
    expect(dv[S][0].ranges).toEqual([{ startRow: 2, endRow: 3, startColumn: 4, endColumn: 4 }])
    expect(result.changedResources).toEqual(['SHEET_DATA_VALIDATION_PLUGIN', 'SHEET_NOTE_PLUGIN'])
  })

  it('writes shared formulas out in full before moving them', () => {
    const { workbook } = linkedWorkbook(['أ', 'ب', 'ج'])
    putRow(workbook, S, 1, { F: { f: '=D2*2', si: 'g1', v: 2 } })
    putRow(workbook, S, 2, { F: { si: 'g1', v: 4 } })
    putRow(workbook, S, 3, { F: { si: 'g1', v: 6 } })
    const result = apply(workbook, [{ type: 'update_row', uid: 'u-3', fields: { position: 1 } }])
    expect([1, 2, 3].map((r) => cell(result.workbook, S, r, 'F'))).toEqual([{ f: '=D2*2' }, { f: '=D3*2' }, { f: '=D4*2' }])
  })

  it('refuses to move rows with merged cells or array formulas', () => {
    const { workbook } = linkedWorkbook(['أ', 'ب'])
    workbook.sheets[S]!.mergeData = [{ startRow: 1, endRow: 1, startColumn: 4, endColumn: 5 }]
    const merged = apply(workbook, [{ type: 'update_row', uid: 'u-2', fields: { position: 1 } }])
    expect(merged.outcomes[0]?.error?.code).toBe('merged_cells')
    const { workbook: array } = linkedWorkbook(['أ', 'ب'])
    putRow(array, S, 2, { F: { f: '=SORT(D2:D3)', ref: 'F3:F4' } })
    const refused = apply(array, [{ type: 'update_row', uid: 'u-2', fields: { position: 1 } }])
    expect(refused.outcomes[0]?.error?.code).toBe('unsupported_formula')
  })
})

describe('mark_deleted_remotely / restore_row (§9.3.10)', () => {
  it('strikes the row through in the given style, keeps it, and restores exactly what was there', () => {
    const { workbook } = linkedWorkbook(['أ', 'ب'])
    workbook.styles = { bold: { bl: 1, cl: { rgb: 'theme-fg' } } }
    putRow(workbook, S, 1, { A: { v: 'أ', s: 'bold' }, D: { v: 46336, t: 2, s: { n: { pattern: 'yyyy-mm-dd' } } } })
    const marked = apply(workbook, [{ type: 'mark_deleted_remotely', uid: 'u-1', status: 'trashed' }])
    const a = cell(marked.workbook, S, 1, 'A')
    expect(a?.s).toEqual({ bl: 1, cl: { rgb: 'theme-muted' }, st: { s: 1 } })
    expect(cell(marked.workbook, S, 1, 'D')?.s).toEqual({ n: { pattern: 'yyyy-mm-dd' }, st: { s: 1 }, cl: { rgb: 'theme-muted' } })
    expect(cell(marked.workbook, S, 2, 'A')).toEqual(cell(workbook, S, 2, 'A'))
    expect(readBack(marked.workbook).map((t) => t.deletedRemotely)).toEqual([true, false])
    expect(uidTitles(marked.workbook)).toEqual(uidTitles(workbook))

    const restored = apply(marked.workbook, [{ type: 'restore_row', uid: 'u-1' }])
    expect(restored.workbook.sheets[S]?.cellData).toEqual(workbook.sheets[S]?.cellData)
    expect(readBack(restored.workbook)[0]?.deletedRemotely).toBe(false)
  })

  it('keeps a change a person made while the row was marked', () => {
    const { workbook } = linkedWorkbook(['أ'])
    const marked = apply(workbook, [{ type: 'mark_deleted_remotely', uid: 'u-1', status: 'archived' }])
    const edited = structuredClone(marked.workbook)
    const a = cell(edited, S, 1, 'A') as { s: Record<string, unknown> }
    a.s.cl = { rgb: 'person-picked' }
    const restored = apply(edited, [{ type: 'restore_row', uid: 'u-1' }])
    expect(cell(restored.workbook, S, 1, 'A')).toEqual({ v: 'أ', s: { cl: { rgb: 'person-picked' } } })
  })
})

describe('move_row (§9.3.11, §16 scenario 4)', () => {
  const T = 'sheet-2'
  // The target sheet maps the same fields to other columns, plus a free column found by its header.
  function twoSheets() {
    const { workbook } = linkedWorkbook(['حملة', 'تصميم', 'تقرير'], {
      levels: [{ row: 2, level: 1, parentRow: 1 }],
    })
    putRow(workbook, S, 0, { F: 'القناة' })
    putRow(workbook, S, 1, { D: { v: 46336, t: 2 }, F: 'تويتر' })
    const targetPlan: SheetPlan = {
      ...defaultPlan(T),
      todolistId: 202,
      columns: [
        { columnKey: 'B', field: 'title' },
        { columnKey: 'A', field: 'due_on' },
        { columnKey: 'C', field: 'assignees' },
        { columnKey: 'D', field: 'completed' },
      ],
    }
    workbook.sheets[T] = {
      id: T,
      name: 'المنفذ',
      cellData: { 0: { 0: { v: 'الموعد' }, 1: { v: 'المهمة' }, 2: { v: 'المسؤول' }, 3: { v: 'الحالة' }, 4: { v: 'القناة' } }, 1: { 1: { v: 'موجودة' } } },
    }
    workbook.sheetOrder = [S, T]
    const ensured = ensureSystemColumns(workbook.sheets[T] as never, targetPlan, counterUids('t'))
    if (!ensured.ok) throw new Error()
    workbook.sheets[T] = ensured.value.sheet
    return { workbook, targetPlan }
  }

  it('moves the to-do and its subtasks to the sheet of the new list', () => {
    const { workbook, targetPlan } = twoSheets()
    const opts: ApplyInboundOptions = { ...options, sheetForList: (id) => (id === 202 ? { univerSheetId: T, plan: targetPlan } : null) }
    const result = apply(workbook, [{ type: 'move_row', uid: 'u-1', toListId: 202, position: 1 }], defaultPlan(S, { hierarchy: { mode: 'indent' } }), opts)
    expect(result.outcomes[0]?.status).toBe('applied')
    expect(uidTitles(result.workbook)).toEqual([['u-3', 'تقرير']])
    const moved = readTasks(result.workbook, T, targetPlan, { directory })
    if (!moved.ok) throw new Error()
    expect(moved.value.tasks.map((t) => [t.uid, t.title, t.level, t.parentUid, t.position, t.dueOn])).toEqual([
      ['u-1', 'حملة', 0, null, 1, '2026-11-10'],
      ['u-2', 'تصميم', 1, 'u-1', 1, null],
      ['t-1', 'موجودة', 0, null, 2, null],
    ])
    // The free column found its namesake in the target.
    expect(cell(result.workbook, T, 1, 'E')?.v).toBe('تويتر')
    // Nothing is left behind in the source rows the family occupied.
    expect(cell(result.workbook, S, 2, 'A')).toBeUndefined()
    expect(cell(result.workbook, S, 3, 'A')).toBeUndefined()
  })

  it('refuses when a value has no column in the target sheet', () => {
    const { workbook, targetPlan } = twoSheets()
    putRow(workbook, S, 2, { G: 'ملاحظة على الفرعية' })
    const opts: ApplyInboundOptions = { ...options, sheetForList: () => ({ univerSheetId: T, plan: targetPlan }) }
    const result = apply(workbook, [{ type: 'move_row', uid: 'u-1', toListId: 202, position: null }], defaultPlan(S), opts)
    expect(result.outcomes[0]?.error?.code).toBe('move_unplaced_cells')
    expect(result.outcomes[0]?.error?.detail).toBe('ملاحظات')
    expect(result.workbook).toBe(workbook)
  })

  it('sends a to-do of an unlinked list to «غير مصنّف», created with the source layout', () => {
    const { workbook } = linkedWorkbook(['أ', 'ب'])
    putRow(workbook, S, 1, { E: { v: 1, t: 3 } })
    const opts: ApplyInboundOptions = { ...options, sheetForList: () => null, unclassified: { univerSheetId: 'sheet-u', sheetId: 'p-u' } }
    const result = apply(workbook, [{ type: 'move_row', uid: 'u-1', toListId: 999, position: null }], defaultPlan(S), opts)
    expect(result.outcomes[0]?.status).toBe('applied')
    expect(result.createdSheets.map((s) => [s.univerSheetId, s.name, s.plan.sheetId, s.plan.mode, s.plan.todolistId])).toEqual([
      ['sheet-u', 'غير مصنّف', 'p-u', 'local', undefined],
    ])
    expect(result.workbook.sheetOrder).toEqual([S, 'sheet-u'])
    const plan = result.createdSheets[0]?.plan as SheetPlan
    const tasks = readTasks(result.workbook, 'sheet-u', plan)
    expect(tasks.ok && tasks.value.tasks.map((t) => [t.uid, t.title, t.completed])).toEqual([['u-1', 'أ', true]])
    expect(uidTitles(result.workbook)).toEqual([['u-2', 'ب']])
    // An existing «غير مصنّف» sheet needs its plan.
    const again = apply(result.workbook, [{ type: 'move_row', uid: 'u-2', toListId: null, position: null }], defaultPlan(S), opts)
    expect(again.outcomes[0]?.error?.code).toBe('unclassified_plan_required')
    const withPlan = apply(result.workbook, [{ type: 'move_row', uid: 'u-2', toListId: null, position: null }], defaultPlan(S), {
      ...opts,
      unclassified: { univerSheetId: 'sheet-u', sheetId: 'p-u', plan },
    })
    expect(withPlan.outcomes[0]?.status).toBe('applied')
    expect(uidTitles(withPlan.workbook, 'sheet-u')).toEqual([
      ['u-1', 'أ'],
      ['u-2', 'ب'],
    ])
  })

  it('reorders in place when the new list is this sheet\'s own', () => {
    const { workbook } = linkedWorkbook(['أ', 'ب'])
    const opts: ApplyInboundOptions = { ...options, sheetForList: () => ({ univerSheetId: S, plan: defaultPlan(S) }) }
    const result = apply(workbook, [{ type: 'move_row', uid: 'u-2', toListId: 101, position: 1 }], defaultPlan(S), opts)
    expect(uidTitles(result.workbook)).toEqual([
      ['u-2', 'ب'],
      ['u-1', 'أ'],
    ])
  })
})
