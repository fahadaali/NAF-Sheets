import { describe, expect, it } from 'vitest'
import type { SheetMeta } from '@naf-sheets/shared'
import {
  buildLinkPlan,
  canStart,
  firstInvalidStepBefore,
  initialState,
  isStepApplicable,
  stepErrors,
  STEPS,
  wizardReducer,
  wizardSheets,
} from '../../src/wizard/model'
import type { WizardAction, WizardSheet, WizardState } from '../../src/wizard/model'

// A blank workbook's sheet: the default columns (spec §7.1) and two tasks.
const TASKS: WizardSheet = {
  planId: 'meta-1',
  univerSheetId: 'u-1',
  title: 'المهام',
  grid: [
    ['المهمة', 'المسؤول', 'تاريخ البدء', 'تاريخ الاستحقاق', 'الحالة', 'المرفقات', 'ملاحظات'],
    ['إعداد الخطة', 'فهد', '', '2026-11-20', 'منجز'],
    ['نشر المقال', 'سارة', '', '', 'قيد التنفيذ'],
  ],
}

// An imported sheet: a title row, the header on row 3, a numbering column, a checkbox status column.
const PLAN: WizardSheet = {
  planId: 'meta-2',
  univerSheetId: 'u-2',
  title: 'خطة الإطلاق',
  grid: [
    ['تقرير الحالة'],
    [],
    ['م', 'البند', 'المكلف', 'الموعد النهائي', 'Done', 'التصنيف'],
    ['1', 'حملة الإطلاق', 'أبو عمر', '2026-12-01', 'TRUE', 'تسويق'],
    ['1.1', 'تصميم', 'سارة', '', 'FALSE', 'تصميم'],
    ['1.2', 'نشر', 'فهد', '', 'TRUE'],
    ['2', 'تقرير', 'فهد', '', 'FALSE'],
  ],
}

const NOTES: WizardSheet = { planId: 'meta-3', univerSheetId: 'u-3', title: 'ملاحظات', grid: [] }

const run = (state: WizardState, ...actions: WizardAction[]): WizardState => actions.reduce(wizardReducer, state)
const fresh = () => initialState('خطة الاتصال 2026', [TASKS, PLAN, NOTES])

describe('wizardSheets', () => {
  it('lists the platform’s sheets in tab order with their text, and counts unregistered ones', () => {
    const meta = (id: string, univerSheetId: string, title: string, position: number): SheetMeta => ({
      id,
      univerSheetId,
      title,
      position,
      syncMode: 'local',
      bcTodolistId: null,
      headerRow: 1,
    })
    const snapshot = {
      sheets: {
        'u-2': { cellData: { 0: { 0: { v: 'المهمة' }, 1: { v: 3 } }, 2: { 1: { v: true, t: 3 } } } },
        'u-1': { cellData: {} },
        'u-9': { cellData: { 0: { 0: { v: 'ورقة جديدة' } } } },
      },
    }
    const { sheets, unregistered } = wizardSheets([meta('m-2', 'u-2', 'ب', 2), meta('m-1', 'u-1', 'أ', 1), meta('m-5', 'u-5', 'ج', 3)], snapshot as never)
    expect(sheets.map((s) => [s.planId, s.title])).toEqual([
      ['m-1', 'أ'],
      ['m-2', 'ب'],
      ['m-5', 'ج'],
    ])
    expect(sheets[1]?.grid).toEqual([['المهمة', '3'], [], ['', 'TRUE']])
    expect(sheets[2]?.grid).toEqual([]) // registered but absent from the snapshot
    expect(unregistered).toBe(1)
  })
})

describe('initial suggestions', () => {
  it('a blank workbook: header row 1, the default columns mapped, flat, «منجز» completes', () => {
    const d = fresh().drafts['meta-1']!
    expect(d.mode).toBe('new')
    expect(d.headerRow).toBe(1)
    expect(d.headerDetected).toBe(true)
    expect(d.columns.map((c) => c.field)).toEqual(['title', 'assignees', 'starts_on', 'due_on', 'completed', 'attachments', 'notes'])
    expect(d.hierarchy).toEqual({ mode: 'flat' })
    expect(d.completedValues).toEqual(['منجز'])
  })

  it('an imported sheet: header found on row 3, numbering column A, checkbox status, a free column', () => {
    const d = fresh().drafts['meta-2']!
    expect(d.headerRow).toBe(3)
    expect(d.columns.map((c) => [c.header, c.field])).toEqual([
      ['م', 'free'],
      ['البند', 'title'],
      ['المكلف', 'assignees'],
      ['الموعد النهائي', 'due_on'],
      ['Done', 'completed'],
      ['التصنيف', 'free'],
    ])
    expect(d.hierarchy).toEqual({ mode: 'numbering', column: 0 })
    expect(d.completedValues).toEqual(['TRUE'])
  })
})

describe('steps', () => {
  it('cannot leave step 1 without a project choice, nor with "existing" and no project', () => {
    let s = fresh()
    expect(stepErrors(s, 'project')).toHaveLength(1)
    expect(run(s, { type: 'next' }).step).toBe('project')
    s = run(s, { type: 'setProject', project: { mode: 'existing', projectId: null } }, { type: 'next' })
    expect(s.step).toBe('project')
    s = run(s, { type: 'setProject', project: { mode: 'existing', projectId: 42 } }, { type: 'next' })
    expect(s.step).toBe('sheets')
  })

  it('«بدون ربط الآن» ends the wizard at step 1', () => {
    const s = run(fresh(), { type: 'setProject', project: { mode: 'none' } })
    expect(STEPS.filter((step) => isStepApplicable(s, step))).toEqual(['project'])
    expect(run(s, { type: 'next' }).step).toBe('project')
  })

  it('all sheets local: straight from sheets to the preview', () => {
    let s = run(
      fresh(),
      { type: 'setProject', project: { mode: 'create' } },
      { type: 'next' },
      { type: 'setSheetMode', sheet: 'meta-1', mode: 'local' },
      { type: 'setSheetMode', sheet: 'meta-2', mode: 'local' },
      { type: 'setSheetMode', sheet: 'meta-3', mode: 'local' },
    )
    s = run(s, { type: 'next' })
    expect(s.step).toBe('preview')
    expect(run(s, { type: 'back' }).step).toBe('sheets')
  })

  it('an empty synced sheet must be made local before step 3 can be left', () => {
    let s = run(fresh(), { type: 'setProject', project: { mode: 'create' } }, { type: 'next' }, { type: 'next' })
    expect(s.step).toBe('headerRow')
    expect(stepErrors(s, 'headerRow').join(' ')).toContain('ملاحظات')
    expect(run(s, { type: 'next' }).step).toBe('headerRow')
    s = run(s, { type: 'back' }, { type: 'setSheetMode', sheet: 'meta-3', mode: 'local' }, { type: 'next' }, { type: 'next' })
    expect(s.step).toBe('columns')
  })

  it('existing lists need an existing project, one list per sheet, and are dropped when the project changes', () => {
    let s = run(fresh(), { type: 'setProject', project: { mode: 'create' } }, { type: 'setSheetMode', sheet: 'meta-1', mode: 'existing' })
    expect(s.drafts['meta-1']?.mode).toBe('new')
    s = run(
      s,
      { type: 'setProject', project: { mode: 'existing', projectId: 42 } },
      { type: 'setSheetMode', sheet: 'meta-1', mode: 'existing' },
      { type: 'setSheetMode', sheet: 'meta-2', mode: 'existing' },
    )
    expect(stepErrors(s, 'sheets')).toHaveLength(2) // no list chosen yet
    s = run(s, { type: 'setTodolist', sheet: 'meta-1', todolistId: 7 }, { type: 'setTodolist', sheet: 'meta-2', todolistId: 7 })
    expect(stepErrors(s, 'sheets')).toEqual([expect.stringContaining('خطة الإطلاق')])
    s = run(s, { type: 'setProject', project: { mode: 'existing', projectId: 43 } })
    expect([s.drafts['meta-1']?.mode, s.drafts['meta-1']?.todolistId]).toEqual(['new', null])
  })

  it('changing the header row re-reads the columns', () => {
    const s = run(fresh(), { type: 'setHeaderRow', sheet: 'meta-2', row: 4 })
    const d = s.drafts['meta-2']!
    expect(d.headerRow).toBe(4)
    expect(d.headerDetected).toBe(false)
    expect(d.columns.map((c) => c.header)).toEqual(['1', 'حملة الإطلاق', 'أبو عمر', '2026-12-01', 'TRUE', 'تسويق'])
    expect(stepErrors(s, 'columns').join(' ')).toContain('خطة الإطلاق') // no title column any more
  })

  it('column mapping: a title is required, each field at most once, «إلحاقه بوصف المهمة» only on free columns', () => {
    let s = run(fresh(), { type: 'setSheetMode', sheet: 'meta-3', mode: 'local' }, { type: 'setColumnField', sheet: 'meta-1', column: 6, field: 'assignees' })
    expect(stepErrors(s, 'columns')).toEqual([expect.stringContaining('المسؤول')])
    s = run(s, { type: 'setColumnField', sheet: 'meta-1', column: 6, field: 'free' }, { type: 'setAppendToDescription', sheet: 'meta-1', column: 6, value: true })
    expect(s.drafts['meta-1']?.columns[6]).toMatchObject({ field: 'free', appendToDescription: true })
    s = run(s, { type: 'setAppendToDescription', sheet: 'meta-1', column: 0, value: true })
    expect(s.drafts['meta-1']?.columns[0]?.appendToDescription).toBe(false)
    s = run(s, { type: 'setColumnField', sheet: 'meta-1', column: 6, field: 'notes' })
    expect(s.drafts['meta-1']?.columns[6]?.appendToDescription).toBe(false)
    s = run(s, { type: 'setColumnField', sheet: 'meta-1', column: 0, field: 'free' })
    expect(stepErrors(s, 'columns')).toEqual([expect.stringContaining('عنوان المهمة')])
  })

  it('status and assignee steps apply only where such a column is mapped', () => {
    let s = run(fresh(), { type: 'setProject', project: { mode: 'create' } }, { type: 'setSheetMode', sheet: 'meta-3', mode: 'local' })
    expect(isStepApplicable(s, 'status')).toBe(true)
    expect(isStepApplicable(s, 'existingTasks')).toBe(false)
    s = run(
      s,
      { type: 'setColumnField', sheet: 'meta-1', column: 4, field: 'free' },
      { type: 'setColumnField', sheet: 'meta-2', column: 4, field: 'free' },
      { type: 'setColumnField', sheet: 'meta-1', column: 1, field: 'free' },
      { type: 'setColumnField', sheet: 'meta-2', column: 2, field: 'free' },
    )
    expect(isStepApplicable(s, 'status')).toBe(false)
    expect(isStepApplicable(s, 'assignees')).toBe(false)
  })

  it('the step list jumps back freely, forwards only as far as already reached', () => {
    let s = run(fresh(), { type: 'setProject', project: { mode: 'create' } }, { type: 'setSheetMode', sheet: 'meta-3', mode: 'local' })
    expect(run(s, { type: 'goTo', step: 'columns' }).step).toBe('project')
    s = run(s, { type: 'next' }, { type: 'next' }, { type: 'next' })
    expect(s.step).toBe('columns')
    s = run(s, { type: 'goTo', step: 'project' })
    expect(s.step).toBe('project')
    expect(run(s, { type: 'goTo', step: 'columns' }).step).toBe('columns')
    expect(run(s, { type: 'goTo', step: 'hierarchy' }).step).toBe('project')
    expect(firstInvalidStepBefore(s, 'preview')).toBeNull()
  })

  it('per-sheet steps show the first sheet they concern', () => {
    const s = run(fresh(), { type: 'setProject', project: { mode: 'create' } }, { type: 'setSheetMode', sheet: 'meta-1', mode: 'local' }, { type: 'next' }, { type: 'setSheetMode', sheet: 'meta-3', mode: 'local' }, { type: 'next' })
    expect(s.step).toBe('headerRow')
    expect(s.activeSheet).toBe('meta-2')
    expect(run(s, { type: 'setActiveSheet', sheet: 'meta-1' }).activeSheet).toBe('meta-2') // local: not offered
  })
})

describe('buildLinkPlan', () => {
  it('sends exactly the choices, with column letters, per the contract', () => {
    const s = run(
      fresh(),
      { type: 'setProject', project: { mode: 'existing', projectId: 42 } },
      { type: 'setSheetMode', sheet: 'meta-1', mode: 'existing' },
      { type: 'setTodolist', sheet: 'meta-1', todolistId: 7 },
      { type: 'setExistingTasks', sheet: 'meta-1', value: 'match_by_title' },
      { type: 'setCompletedValue', sheet: 'meta-1', value: 'قيد التنفيذ', completed: false },
      { type: 'setCompletedValue', sheet: 'meta-1', value: 'تم', completed: true },
      { type: 'setAssigneeMatch', sheet: 'meta-1', text: 'سارة', personId: 501 },
      { type: 'setAssigneeMatch', sheet: 'meta-1', text: 'فهد', personId: null },
      { type: 'setAppendToDescription', sheet: 'meta-2', column: 5, value: true },
      { type: 'setSheetMode', sheet: 'meta-3', mode: 'local' },
    )
    expect(buildLinkPlan(s)).toEqual({
      project: { mode: 'existing', projectId: 42 },
      sheets: [
        {
          sheetId: 'meta-1',
          mode: 'existing',
          todolistId: 7,
          headerRow: 1,
          columns: [
            { columnKey: 'A', field: 'title' },
            { columnKey: 'B', field: 'assignees' },
            { columnKey: 'C', field: 'starts_on' },
            { columnKey: 'D', field: 'due_on' },
            { columnKey: 'E', field: 'completed' },
            { columnKey: 'F', field: 'attachments' },
            { columnKey: 'G', field: 'notes' },
          ],
          completedValues: ['منجز', 'تم'],
          hierarchy: { mode: 'flat' },
          existingTasks: 'match_by_title',
          assigneeMatches: { سارة: 501, فهد: null },
        },
        {
          sheetId: 'meta-2',
          mode: 'new',
          headerRow: 3,
          columns: [
            { columnKey: 'A', field: 'free', appendToDescription: false },
            { columnKey: 'B', field: 'title' },
            { columnKey: 'C', field: 'assignees' },
            { columnKey: 'D', field: 'due_on' },
            { columnKey: 'E', field: 'completed' },
            { columnKey: 'F', field: 'free', appendToDescription: true },
          ],
          completedValues: ['TRUE'],
          hierarchy: { mode: 'numbering', columnKey: 'A' },
          existingTasks: 'create_all',
          assigneeMatches: {},
        },
        { sheetId: 'meta-3', mode: 'local', headerRow: 1, columns: [], hierarchy: { mode: 'flat' }, existingTasks: 'create_all', assigneeMatches: {} },
      ],
    })
  })

  it('«إنشاء مشروع جديد بالاسم نفسه» uses the workbook title', () => {
    const s = run(fresh(), { type: 'setProject', project: { mode: 'create' } })
    expect(buildLinkPlan(s).project).toEqual({ mode: 'create', name: 'خطة الاتصال 2026' })
  })

  it('leaving a list resets the existing-tasks strategy; indentation and flat hierarchies have no column', () => {
    const s = run(
      fresh(),
      { type: 'setProject', project: { mode: 'existing', projectId: 42 } },
      { type: 'setSheetMode', sheet: 'meta-1', mode: 'existing' },
      { type: 'setExistingTasks', sheet: 'meta-1', value: 'match_by_title' },
      { type: 'setSheetMode', sheet: 'meta-1', mode: 'new' },
      { type: 'setHierarchy', sheet: 'meta-2', hierarchy: { mode: 'indent' } },
    )
    const plan = buildLinkPlan(s)
    expect(plan.sheets[0]).toMatchObject({ mode: 'new', existingTasks: 'create_all' })
    expect(plan.sheets[0]).not.toHaveProperty('todolistId')
    expect(plan.sheets[1]?.hierarchy).toEqual({ mode: 'indent' })
  })
})

describe('canStart', () => {
  const ready = () =>
    run(
      fresh(),
      { type: 'setProject', project: { mode: 'existing', projectId: 42 } },
      { type: 'setSheetMode', sheet: 'meta-1', mode: 'existing' },
      { type: 'setTodolist', sheet: 'meta-1', todolistId: 7 },
      { type: 'setExistingTasks', sheet: 'meta-1', value: 'match_by_title' },
      { type: 'setSheetMode', sheet: 'meta-3', mode: 'local' },
    )

  it('needs a valid plan, and a review of proposed matches when there are any', () => {
    expect(canStart(fresh(), 0)).toBe(false)
    expect(canStart(run(fresh(), { type: 'setProject', project: { mode: 'none' } }), 0)).toBe(false)
    const s = ready()
    expect(canStart(s, 0)).toBe(true)
    expect(canStart(s, 3)).toBe(false)
    expect(canStart(run(s, { type: 'setMatchesReviewed', value: true }), 3)).toBe(true)
  })

  it('any change to the plan withdraws the review', () => {
    const s = run(ready(), { type: 'setMatchesReviewed', value: true }, { type: 'setColumnField', sheet: 'meta-1', column: 6, field: 'free' })
    expect(s.matchesReviewed).toBe(false)
    expect(canStart(s, 3)).toBe(false)
  })
})
