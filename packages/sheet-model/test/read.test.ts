import type { Assignee } from '@naf-sheets/shared'
import { describe, expect, it } from 'vitest'
import { readTasks, splitAssigneeText, type AssigneeDirectory } from '../src'
import { blankWorkbook, counterUids, defaultPlan, linkedWorkbook, putRow } from './helpers'
import { ensureSystemColumns } from '../src'

const S = 'sheet-1'
const directory: AssigneeDirectory = {
  people: [
    { id: 11, name: 'سارة العتيبي' },
    { id: 12, name: 'Omar Ali' },
    { id: 13, name: 'خالد' },
    { id: 14, name: 'خالد' },
  ],
  externals: [{ id: 'ext-1', name: 'وكالة الإبداع' }],
}

function read(workbook: Parameters<typeof readTasks>[0], plan = defaultPlan(S), options: Parameters<typeof readTasks>[3] = { directory }) {
  const result = readTasks(workbook, S, plan, options)
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

describe('readTasks: fields', () => {
  it('reads title, assignees, dates, completion, notes and free columns', () => {
    const plan = defaultPlan(S, {
      columns: [...defaultPlan(S).columns, { columnKey: 'H', field: 'free', appendToDescription: true }, { columnKey: 'I', field: 'free' }],
    })
    const wb = blankWorkbook()
    putRow(wb, S, 0, { H: 'القناة', I: 'داخلي' })
    putRow(wb, S, 1, {
      A: '  إعداد الخطة  ',
      B: 'سارة العتيبي، Omar Ali',
      C: { v: '2026-11-01', t: 1 },
      D: { v: 46336, t: 2, s: { n: { pattern: 'yyyy-mm-dd' } } },
      E: { v: 1, t: 3 },
      G: 'السطر الأول\nالسطر الثاني',
      H: 'تويتر',
      I: 'لا يُرسل',
    })
    const ensured = ensureSystemColumns(wb.sheets[S] as never, plan, counterUids())
    if (!ensured.ok) throw new Error()
    wb.sheets[S] = ensured.value.sheet
    const { tasks, issues } = read(wb, plan)
    expect(issues).toEqual([])
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toEqual({
      uid: 'u-1',
      sheetId: 'p-sheet-1',
      parentUid: null,
      level: 0,
      position: 1,
      title: 'إعداد الخطة',
      assignees: [
        { kind: 'bc_person', bcPersonId: 11, source: 'manual' },
        { kind: 'bc_person', bcPersonId: 12, source: 'manual' },
      ],
      dueOn: '2026-11-10',
      startsOn: '2026-11-01',
      completed: true,
      notesHtml: '<div>السطر الأول<br>السطر الثاني</div>',
      freeColumnsForDescription: { القناة: 'تويتر' },
      attachments: [],
      assignMode: 'manual',
      localChangedAt: null,
      bcId: null,
      deletedRemotely: false,
    })
  })

  it('takes what lives outside the snapshot from the row state', () => {
    const { workbook } = linkedWorkbook(['مهمة'])
    const attachments = [{ id: 'a1', filename: 'خطة.pdf', bcSgid: null, origin: 'local' as const }]
    const { tasks } = read(workbook, defaultPlan(S), {
      directory,
      rowState: (uid) => (uid === 'u-1' ? { bcId: 900, assignMode: 'manual', localChangedAt: '2026-11-10T08:00:00Z', attachments, deletedRemotely: true } : undefined),
    })
    expect(tasks[0]).toMatchObject({ bcId: 900, assignMode: 'manual', localChangedAt: '2026-11-10T08:00:00Z', attachments, deletedRemotely: true })
  })

  it('reports an unreadable date (and reads it as null) instead of guessing', () => {
    const { workbook } = linkedWorkbook(['مهمة'])
    putRow(workbook, S, 1, { D: '10/11/2026', C: 'قريباً' })
    const { tasks, issues } = read(workbook)
    expect(tasks[0]?.dueOn).toBeNull()
    expect(issues.map((i) => [i.code, i.column, i.detail])).toEqual([
      ['invalid_date', 3, '10/11/2026'],
      ['invalid_date', 2, 'قريباً'],
    ])
    expect(issues[0]?.message).toMatch(/YYYY-MM-DD/)
  })

  it('reads Arabic-Indic digits in a date as Latin', () => {
    const { workbook } = linkedWorkbook(['مهمة'])
    putRow(workbook, S, 1, { D: '٢٠٢٦-١١-١٠' })
    expect(read(workbook).tasks[0]?.dueOn).toBe('2026-11-10')
  })
})

describe('readTasks: completion', () => {
  it('reads a checkbox by its rule values', () => {
    const { workbook } = linkedWorkbook(['أ', 'ب', 'ج', 'د'])
    workbook.resources = [
      {
        name: 'SHEET_DATA_VALIDATION_PLUGIN',
        data: JSON.stringify({
          [S]: [
            { uid: 'dv1', type: 'checkbox', ranges: [{ startRow: 1, endRow: 2, startColumn: 4, endColumn: 4 }] },
            { uid: 'dv2', type: 'checkbox', formula1: 'نعم', formula2: 'لا', ranges: [{ startRow: 3, endRow: 3, startColumn: 4, endColumn: 4 }] },
            { uid: 'dv3', type: 'checkbox', formula1: '=Z1', formula2: '=Z2', ranges: [{ startRow: 4, endRow: 4, startColumn: 4, endColumn: 4 }] },
          ],
        }),
      },
    ]
    putRow(workbook, S, 1, { E: { v: 1, t: 2 } })
    putRow(workbook, S, 2, { E: { v: 0, t: 2 } })
    putRow(workbook, S, 3, { E: 'نعم' })
    putRow(workbook, S, 4, { E: 'نعم' })
    const { tasks, issues } = read(workbook)
    expect(tasks.map((t) => t.completed)).toEqual([true, false, true, false])
    expect(issues.map((i) => [i.code, i.row])).toEqual([['checkbox_formula', 4]])
  })

  it('reads a status column by the values that mean completed', () => {
    const { workbook } = linkedWorkbook(['أ', 'ب', 'ج'])
    putRow(workbook, S, 1, { E: 'منجز' })
    putRow(workbook, S, 2, { E: 'قيد التنفيذ' })
    putRow(workbook, S, 3, { E: ' منجز ' })
    const plan = defaultPlan(S, { completedValues: ['منجز'] })
    expect(read(workbook, plan).tasks.map((t) => t.completed)).toEqual([true, false, true])
  })

  it('reads a plain boolean when the column has neither', () => {
    const { workbook } = linkedWorkbook(['أ', 'ب', 'ج'])
    putRow(workbook, S, 1, { E: { v: 1, t: 3 } })
    putRow(workbook, S, 2, { E: 'TRUE' })
    putRow(workbook, S, 3, { E: { v: true } })
    expect(read(workbook).tasks.map((t) => t.completed)).toEqual([true, false, true])
  })
})

describe('readTasks: assignees', () => {
  it('splits Univer multiple-choice lists, commas and Arabic commas', () => {
    expect(splitAssigneeText('["سارة","Omar Ali"]')).toEqual(['سارة', 'Omar Ali'])
    expect(splitAssigneeText('سارة, Omar Ali ،خالد\nسارة')).toEqual(['سارة', 'Omar Ali', 'خالد'])
    expect(splitAssigneeText('  ')).toEqual([])
  })

  it('resolves names through the wizard matches, the directory and the stored assignees', () => {
    const { workbook } = linkedWorkbook(['أ', 'ب'])
    putRow(workbook, S, 1, { B: '["سارة العتيبي","وكالة الإبداع","س. العتيبي","غير معروف","خالد","تجاهل"]' })
    putRow(workbook, S, 2, { B: 'سارة العتيبي' })
    const plan = defaultPlan(S, { assigneeMatches: { 'س. العتيبي': 11, تجاهل: null } })
    const stored: Assignee[] = [{ kind: 'follower', bcPersonId: 11, source: 'manual' }]
    const { tasks, issues } = read(workbook, plan, { directory, rowState: (uid) => (uid === 'u-2' ? { assignees: stored } : undefined) })
    expect(tasks[0]?.assignees).toEqual([
      { kind: 'bc_person', bcPersonId: 11, source: 'manual' },
      { kind: 'external', externalContactId: 'ext-1', source: 'manual', notifyEmail: false },
      { kind: 'bc_person', bcPersonId: 11, source: 'manual' },
    ])
    // A stored follower keeps its kind.
    expect(tasks[1]?.assignees).toEqual(stored)
    expect(issues.map((i) => [i.code, i.detail])).toEqual([
      ['unknown_assignee', 'غير معروف'],
      ['ambiguous_assignee', 'خالد'],
    ])
  })

  it('defaults the assign mode by §8.1: auto without assignees, manual with', () => {
    const { workbook } = linkedWorkbook(['أ', 'ب'])
    putRow(workbook, S, 2, { B: 'Omar Ali' })
    expect(read(workbook).tasks.map((t) => t.assignMode)).toEqual(['auto', 'manual'])
  })
})

describe('readTasks: identity and hierarchy', () => {
  const levels = [
    { row: 2, level: 1 as const, parentRow: 1 },
    { row: 3, level: 1 as const, parentRow: 1 },
    { row: 5, level: 1 as const, parentRow: 4 },
  ]

  it('gives positions among siblings by row order', () => {
    const { workbook } = linkedWorkbook(['حملة', 'تصميم', 'نشر', 'تقرير', 'مراجعة'], { levels })
    const { tasks } = read(workbook)
    expect(tasks.map((t) => [t.title, t.level, t.parentUid, t.position])).toEqual([
      ['حملة', 0, null, 1],
      ['تصميم', 1, 'u-1', 1],
      ['نشر', 1, 'u-1', 2],
      ['تقرير', 0, null, 2],
      ['مراجعة', 1, 'u-4', 1],
    ])
  })

  it('keeps every identity through a sort of the whole rows (§16 scenario 2)', () => {
    const { workbook } = linkedWorkbook(['ج', 'أ', 'ب'])
    putRow(workbook, S, 1, { D: 46340 })
    putRow(workbook, S, 2, { D: 46330 })
    putRow(workbook, S, 3, { D: 46335 })
    const before = read(workbook).tasks
    // Sort rows 2..4 by due date, whole rows (hidden system columns included), as a sort of the sheet does.
    const data = workbook.sheets[S]!.cellData as Record<number, unknown>
    const [r1, r2, r3] = [data[1], data[2], data[3]]
    data[1] = r2
    data[2] = r3
    data[3] = r1
    const after = read(workbook).tasks
    const byUid = (list: typeof before) => Object.fromEntries(list.map((t) => [t.uid, { title: t.title, dueOn: t.dueOn }]))
    expect(byUid(after)).toEqual(byUid(before))
    expect(after.map((t) => [t.uid, t.position])).toEqual([
      ['u-2', 1],
      ['u-3', 2],
      ['u-1', 3],
    ])
  })

  it('flags a subtask that is no longer under its to-do, and rows without a sound identity', () => {
    const { workbook } = linkedWorkbook(['حملة', 'تصميم', 'نشر', 'تقرير', 'مراجعة'], { levels })
    const data = workbook.sheets[S]!.cellData as Record<number, Record<number, unknown>>
    // Move the row of «مراجعة» (subtask of «تقرير») above «تقرير».
    const [r4, r5] = [data[4], data[5]]
    data[4] = r5 as Record<number, unknown>
    data[5] = r4 as Record<number, unknown>
    putRow(workbook, S, 6, { A: 'بلا معرّف' })
    putRow(workbook, S, 7, { A: 'نسخة', H: 'u-2', J: 1, I: 'u-1' })
    putRow(workbook, S, 8, { A: 'مستوى خاطئ', H: 'u-9', J: 7 })
    const { tasks, issues } = read(workbook)
    expect(tasks.map((t) => t.uid)).toEqual(['u-1', 'u-3', 'u-5', 'u-4'])
    expect(issues.map((i) => [i.code, i.row])).toEqual([
      ['untracked_row', 6],
      ['invalid_level', 8],
      ['duplicate_uid', 2],
      ['duplicate_uid', 7],
      ['invalid_hierarchy', 4],
    ])
    expect(issues.find((i) => i.code === 'duplicate_uid')?.message).toMatch(/نسخ صف/)
  })

  it('reports an empty title', () => {
    const { workbook } = linkedWorkbook(['مهمة'])
    putRow(workbook, S, 1, { A: '   ' })
    const { tasks, issues } = read(workbook)
    expect(tasks[0]?.title).toBe('')
    expect(issues.map((i) => i.code)).toEqual(['empty_title'])
  })

  it('refuses a sheet without system columns', () => {
    const result = readTasks(blankWorkbook(), S, defaultPlan(S))
    expect(!result.ok && result.error.code).toBe('system_columns_missing')
    expect(!result.ok && result.error.message).toMatch(/أعمدة النظام/)
  })
})

describe('readTasks: notes', () => {
  it('returns Basecamp\'s HTML unchanged while the text still reads the same', () => {
    const { workbook } = linkedWorkbook(['مهمة'])
    const html = '<div><strong>مهم</strong>: راجع <a href="https://x">المسودة</a><br>ثم أرسلها</div><bc-attachment sgid="x"></bc-attachment>'
    putRow(workbook, S, 1, { G: { v: 'مهم: راجع المسودة\nثم أرسلها', custom: { nafSheets: { notesHtml: html } } } })
    expect(read(workbook).tasks[0]?.notesHtml).toBe(html)
    // Phase 5 (spec §8.2, §10): editing the text keeps the description's files after the new text.
    putRow(workbook, S, 1, { G: { v: 'نص جديد <كتبه> شخص', custom: { nafSheets: { notesHtml: html } } } })
    expect(read(workbook).tasks[0]?.notesHtml).toBe('<div>نص جديد &lt;كتبه&gt; شخص</div><bc-attachment sgid="x"></bc-attachment>')
  })

  it('phase 5: clearing the text keeps the files; a cell of files only reads back as its stored HTML', () => {
    const { workbook } = linkedWorkbook(['مهمة'])
    const files = '<bc-attachment sgid="a"><figure><figcaption>خطة.pdf</figcaption></figure></bc-attachment>\n<bc-attachment sgid="b"></bc-attachment>'
    const html = `<div>نص</div>${files}`
    // The cell shows the text only: a file's caption is not notes text.
    putRow(workbook, S, 1, { G: { v: 'نص', custom: { nafSheets: { notesHtml: html } } } })
    expect(read(workbook).tasks[0]?.notesHtml).toBe(html)
    putRow(workbook, S, 1, { G: { custom: { nafSheets: { notesHtml: html } } } })
    expect(read(workbook).tasks[0]?.notesHtml).toBe('<bc-attachment sgid="a"><figure><figcaption>خطة.pdf</figcaption></figure></bc-attachment><bc-attachment sgid="b"></bc-attachment>')
    putRow(workbook, S, 1, { G: { custom: { nafSheets: { notesHtml: files } } } })
    expect(read(workbook).tasks[0]?.notesHtml).toBe(files)
    // Without stored files, an empty cell is still no notes.
    putRow(workbook, S, 1, { G: { custom: { nafSheets: { notesHtml: '<div>نص</div>' } } } })
    expect(read(workbook).tasks[0]?.notesHtml).toBeNull()
  })
})
