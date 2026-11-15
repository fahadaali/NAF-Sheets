import { describe, expect, it } from 'vitest'
import { diffTask } from '@naf-sheets/sync-engine'
import {
  deletedTasks,
  findColumns,
  inboundEdits,
  isoToSerial,
  readDate,
  readRoles,
  readTab,
  serialToIso,
  statusAfterRemoteCompletion,
  type CellValue,
  type PeopleMap,
  type RowIdentity,
  type TabColumns,
} from '../src'

// Shaped like «السوشل ميديا» in «الاتصال المؤسسي والتسويق» (read 2026-11-15):
// A المهمة الرئيسية, B المهمة, C القسم, D الحالة, E الموعد, F الاسم (formula), K ترقيم آلي.
const HEADER: CellValue[] = ['المهمة الرئيسية', 'المهمة', 'القسم', 'الحالة', 'الموعد', 'الاسم', '', '', '', '', 'ترقيم آلي']
const SOCIAL: CellValue[][] = [
  HEADER,
  ['إعداد المحتوى ومراجعته'],
  ['إعداد المحتوى ومراجعته', 'تعديل أعمدة لوحة المحتوى في بيس كامب', 'مسؤول السوشل ميديا', 'لم تبدأ', 46336, 'أبو عمار', '', '', '', '', 1],
  ['فيديو الموشن'],
  ['فيديو الموشن', 'بناء بنك أفكار للموشن', 'مسؤول السوشل ميديا', 'منجزة', 46338, 'أبو عمار', '', '', '', '', 2],
  ['فيديو الموشن', 'اعتماد بنك الأفكار', 'الاعتمادات', 'جارية', '', 'فهد وعمر', '', '', '', '', 3],
  [],
]

const ROLES_TAB: CellValue[][] = [
  ['المسمى', 'الاسم (اكتبه هنا)', 'ما يتولاه'],
  ['الاعتمادات', 'فهد وعمر', 'القرارات'],
  ['مسؤول السوشل ميديا', 'أبو عمار', 'مشروع السوشل ميديا'],
  ['المحامي الرئيسي', 'أبو شبيب', 'اعتماد المحتوى'],
  ['المحامي الرئيسي', 'أبو شبيب', 'الاستشارات'],
  ['الشريك', '', ''],
]
const FAHAD = 49045323
const OMAR = 52761043
const PEOPLE: PeopleMap = new Map([
  ['أبو عمار', [OMAR]],
  ['فهد وعمر', [FAHAD, OMAR]],
])

function columns(header: CellValue[] = HEADER): TabColumns {
  const found = findColumns(header)
  if (!found.ok) throw new Error(found.message)
  return found.columns
}

function read(values: CellValue[][], identities = new Map<number, RowIdentity>()) {
  let n = 0
  return readTab({
    values,
    columns: columns(values[0]),
    roles: readRoles(ROLES_TAB).roles,
    people: PEOPLE,
    identities,
    newUid: () => `u${++n}`,
    sheetId: 'tab-social',
    changedAt: '2026-11-15T10:00:00Z',
  })
}

describe('dates', () => {
  it('reads Google serial numbers and typed text', () => {
    expect(serialToIso(46336)).toBe('2026-11-10')
    expect(isoToSerial('2026-11-10')).toBe(46336)
    expect(readDate('2026/11/10')).toEqual({ ok: true, value: '2026-11-10' })
    expect(readDate('٢٠٢٦/١١/١٠')).toEqual({ ok: true, value: '2026-11-10' })
    expect(readDate('')).toEqual({ ok: true, value: null })
    expect(readDate('2026/02/30')).toEqual({ ok: false })
    expect(readDate('بعد العيد')).toEqual({ ok: false })
  })
})

describe('findColumns', () => {
  it('finds the fixed columns by header, wherever they are', () => {
    expect(columns()).toEqual({ main: 0, sub: 1, role: 2, status: 3, due: 4 })
    // «التسويق الإلكتروني» has «التقدم» before «الاسم».
    const marketing = ['المهمة الرئيسية', 'المهمة', 'القسم', 'الحالة', 'الموعد', 'التقدم', 'الاسم']
    expect(columns(marketing)).toEqual({ main: 0, sub: 1, role: 2, status: 3, due: 4 })
    expect(columns(['الموعد', ' المهمة ', 'الحالة', 'القسم', 'المهمة الرئيسية'])).toEqual({ main: 4, sub: 1, role: 3, status: 2, due: 0 })
  })

  it('refuses a tab without a fixed column, in Arabic', () => {
    const r = findColumns(['المهمة', 'المسؤول', 'الحالة', 'الموعد'])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('missing')
      expect(r.headers).toEqual(['المهمة الرئيسية', 'القسم'])
      expect(r.message).toContain('«المهمة الرئيسية»')
    }
  })

  it('refuses a duplicated fixed column', () => {
    const r = findColumns([...HEADER, 'الحالة'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('duplicated')
  })
})

describe('readRoles', () => {
  it('maps titles to names and reports a title given two names', () => {
    const { roles, conflicts } = readRoles([...ROLES_TAB, ['الاعتمادات', 'فهد', '']])
    expect(roles.get('مسؤول السوشل ميديا')).toBe('أبو عمار')
    expect(roles.get('الاعتمادات')).toBe('فهد وعمر')
    expect(conflicts).toEqual([{ role: 'الاعتمادات', names: ['فهد وعمر', 'فهد'] }])
  })
})

describe('readTab', () => {
  it('turns heading rows into to-dos and the rows under them into subtasks', () => {
    const r = read(SOCIAL)
    expect(r.issues).toEqual([])
    expect(r.tasks.map((t) => [t.uid, t.level, t.parentUid, t.position, t.title])).toEqual([
      ['u1', 0, null, 1, 'إعداد المحتوى ومراجعته'],
      ['u2', 1, 'u1', 1, 'تعديل أعمدة لوحة المحتوى في بيس كامب'],
      ['u3', 0, null, 2, 'فيديو الموشن'],
      ['u4', 1, 'u3', 1, 'بناء بنك أفكار للموشن'],
      ['u5', 1, 'u3', 2, 'اعتماد بنك الأفكار'],
    ])
    expect(r.newIdentities.map((i) => i.row)).toEqual([1, 2, 3, 4, 5])
  })

  it('reads people through «المسميات», status and due date', () => {
    const [main, first, , done, approval] = read(SOCIAL).tasks
    expect(main!.assignees).toEqual([])
    expect(main!.assignMode).toBe('auto')
    expect(first!.assignees.map((a) => a.kind === 'bc_person' && a.bcPersonId)).toEqual([OMAR])
    expect(first!.dueOn).toBe('2026-11-10')
    expect(first!.completed).toBe(false)
    expect(done!.completed).toBe(true)
    expect(approval!.assignees.map((a) => a.kind === 'bc_person' && a.bcPersonId)).toEqual([FAHAD, OMAR])
    expect(approval!.dueOn).toBeNull()
    expect(approval!.completed).toBe(false) // «جارية» is not done
  })

  it('keeps known identities and carries fields the sheet has no column for', () => {
    const identities = new Map<number, RowIdentity>([
      [1, { uid: 'todo-a', bcId: 900, level: 0, carry: { notesHtml: '<div>من Basecamp</div>', startsOn: '2026-11-01' } }],
      [2, { uid: 'sub-a', bcId: 901, level: 1 }],
    ])
    const r = read(SOCIAL, identities)
    expect(r.tasks[0]).toMatchObject({ uid: 'todo-a', bcId: 900, notesHtml: '<div>من Basecamp</div>', startsOn: '2026-11-01' })
    expect(r.tasks[1]).toMatchObject({ uid: 'sub-a', bcId: 901, parentUid: 'todo-a' })
    expect(r.newIdentities.map((i) => i.row)).toEqual([3, 4, 5])
  })

  it('holds back a row whose person cannot be resolved, never sending it with no assignee', () => {
    const values = [
      HEADER,
      ['التأسيس'],
      ['التأسيس', 'تسمية الأشخاص للأدوار', 'الشريك', 'لم تبدأ'],
      ['التأسيس', 'اعتماد المحتوى', 'المحامي الرئيسي', 'لم تبدأ'],
      ['التأسيس', 'مهمة بمسمى غير معروف', 'المدير المالي', 'لم تبدأ'],
    ]
    const r = read(values)
    expect(r.tasks.map((t) => t.title)).toEqual(['التأسيس'])
    expect(r.issues.map((i) => [i.code, i.row, i.blocking])).toEqual([
      ['role_without_name', 2, true],
      ['name_unmapped', 3, true],
      ['role_unknown', 4, true],
    ])
    expect(r.issues[1]!.message).toContain('«أبو شبيب»')
    // Held rows are still rows: they must not be taken for deleted ones.
    expect(r.rows).toHaveLength(4)
  })

  it('holds back an unreadable date', () => {
    const r = read([HEADER, ['أ'], ['أ', 'ب', '', 'لم تبدأ', 'الأسبوع القادم']])
    expect(r.tasks.map((t) => t.title)).toEqual(['أ'])
    expect(r.issues[0]).toMatchObject({ code: 'date_unreadable', row: 2 })
  })

  it('finds the parent by position and rewrites a stale repeated title (decision 4)', () => {
    const values = [HEADER, ['فيديو الموشن القصير'], ['فيديو الموشن', 'بناء بنك أفكار', '', 'لم تبدأ']]
    const r = read(values)
    expect(r.tasks[1]!.parentUid).toBe(r.tasks[0]!.uid)
    expect(r.fixes).toEqual([{ row: 2, column: 0, value: 'فيديو الموشن القصير' }])
  })

  it('reports a subtask with no to-do above it and keeps it out of the sync', () => {
    const r = read([HEADER, ['', 'مهمة يتيمة', '', 'لم تبدأ'], ['أ']])
    expect(r.tasks.map((t) => t.title)).toEqual(['أ'])
    expect(r.issues[0]).toMatchObject({ code: 'subtask_without_main', row: 1, blocking: true })
    expect(r.rows.map((x) => x.row)).toEqual([1, 2])
  })

  it('refuses to turn a to-do into a subtask', () => {
    const identities = new Map<number, RowIdentity>([[2, { uid: 'was-todo', bcId: 5, level: 0 }]])
    const r = read([HEADER, ['أ'], ['أ', 'ب', '', 'لم تبدأ']], identities)
    expect(r.issues[0]).toMatchObject({ code: 'level_changed', row: 2, blocking: true })
    expect(r.tasks.map((t) => t.uid)).not.toContain('was-todo')
  })

  it('treats a copied row (same identity twice) as a new task', () => {
    const identities = new Map<number, RowIdentity>([
      [1, { uid: 'todo-a', bcId: 1, level: 0 }],
      [2, { uid: 'todo-a', bcId: 1, level: 0 }],
    ])
    const r = read([HEADER, ['أ'], ['أ نسخة']], identities)
    expect(r.tasks.map((t) => [t.uid, t.bcId])).toEqual([
      ['todo-a', 1],
      ['u1', null],
    ])
    expect(r.issues[0]).toMatchObject({ code: 'duplicate_identity', blocking: false })
  })

  it('feeds the sync engine: new rows become creates', () => {
    const r = read(SOCIAL)
    const todo = r.tasks[0]!
    const result = diffTask(todo, null, null, { directory: { externalContacts: new Map(), personNames: new Map() }, listId: 77 })
    expect(result.outbound[0]).toMatchObject({ type: 'create_todo', uid: 'u1', listId: 77 })
  })
})

describe('deletedTasks (decision 9-ب: automatic)', () => {
  it('deletes rows gone from the sheet, letting subtasks go with their to-do', () => {
    const known = [
      { uid: 'a', level: 0 as const, parentUid: null, bcId: 1 },
      { uid: 'a1', level: 1 as const, parentUid: 'a', bcId: 2 },
      { uid: 'b', level: 0 as const, parentUid: null, bcId: 3 },
      { uid: 'b1', level: 1 as const, parentUid: 'b', bcId: 4 },
    ]
    const gone = deletedTasks(known, [{ uid: 'b' }])
    expect(gone.map((g) => g.task.uid)).toEqual(['a', 'b1'])
  })
})

describe('inboundEdits', () => {
  const r = read(SOCIAL)
  const cols = columns()

  it('writes a renamed to-do into its row and its subtask rows', () => {
    const out = inboundEdits(r.rows, cols, [{ type: 'update_row', uid: 'u3', fields: { title: 'فيديو الموشن ٢' } }])
    expect(out.edits).toEqual([
      { row: 3, column: 0, value: 'فيديو الموشن ٢' },
      { row: 4, column: 0, value: 'فيديو الموشن ٢' },
      { row: 5, column: 0, value: 'فيديو الموشن ٢' },
    ])
  })

  it('writes subtask title, due date and completion', () => {
    const out = inboundEdits(r.rows, cols, [
      { type: 'update_row', uid: 'u2', fields: { title: 'جديد', dueOn: '2026-12-01', completed: true } },
      { type: 'update_row', uid: 'u4', fields: { completed: false } },
      { type: 'update_row', uid: 'u5', fields: { completed: false } },
    ])
    expect(out.edits).toEqual([
      { row: 2, column: 1, value: 'جديد' },
      { row: 2, column: 4, value: '2026-12-01' },
      { row: 2, column: 3, value: 'منجزة' },
      { row: 4, column: 3, value: 'جارية' }, // decision 3
    ])
  })

  it('never writes people from Basecamp: alerts instead (decision 2-أ)', () => {
    const out = inboundEdits(r.rows, cols, [{ type: 'update_row', uid: 'u2', fields: { assignees: [] } }])
    expect(out.edits).toEqual([])
    expect(out.alerts[0]).toMatchObject({ uid: 'u2', code: 'assignees_changed_in_basecamp' })
  })

  it('hands structural actions and unknown rows to the caller', () => {
    const out = inboundEdits(r.rows, cols, [
      { type: 'mark_deleted_remotely', uid: 'u2', status: 'trashed' },
      { type: 'update_row', uid: 'nope', fields: { title: 'x' } },
    ])
    expect(out.structural).toHaveLength(1)
    expect(out.unknownRows).toEqual(['nope'])
  })
})

describe('statusAfterRemoteCompletion', () => {
  it('maps Basecamp completion onto the four statuses', () => {
    expect(statusAfterRemoteCompletion('لم تبدأ', true)).toBe('منجزة')
    expect(statusAfterRemoteCompletion('منجزة', true)).toBeNull()
    expect(statusAfterRemoteCompletion('منجزة', false)).toBe('جارية')
    expect(statusAfterRemoteCompletion('متوقفة', false)).toBeNull()
  })
})
