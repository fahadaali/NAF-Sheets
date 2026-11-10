// Mandatory sync scenarios of spec §16 that are pure logic. Each test name
// starts with its scenario number. Scenarios that need IO, a browser or real
// Basecamp (1, 3–7, 11, 12, 17–19, 23) are not here.

import { describe, expect, it } from 'vitest'
import type { LocalTask, OutboundAction, RemoteTodo, SyncedBase } from '@naf-sheets/shared'
import {
  applyAssigneeEdit,
  baseAfterSubtaskWrite,
  baseAfterTodoWrite,
  baseFromRemote,
  computeAutoAssignees,
  DEFAULT_AUTO_ASSIGN_SETTINGS,
  diffTask,
  ERROR_MESSAGES,
  inboundCreateRow,
  MANAGED_BLOCK_TITLE,
  planDeletion,
  recreateSubtaskFromSnapshot,
  sortRows,
  splitDescription,
  type DiffContext,
} from '../src'
import {
  AHMED,
  BADR,
  DANA,
  external,
  FAHAD,
  follower,
  HUMAN_NOTES,
  JUMANA,
  localSubtask,
  localTodo,
  person,
  remoteSubtask,
  remoteTodo,
  SARA,
  SUBTASK_ID,
  subtaskCtx,
  T0,
  T1,
  T2,
  T3,
  TODO_ID,
  todoCtx,
} from './fixtures'

function only<T extends OutboundAction['type']>(actions: OutboundAction[], type: T): Extract<OutboundAction, { type: T }> {
  expect(actions.map((a) => a.type)).toEqual([type])
  return actions[0] as Extract<OutboundAction, { type: T }>
}

const block = (...lines: string[]): string => `<hr><div><strong>${MANAGED_BLOCK_TITLE}</strong><br>${lines.join('<br>')}</div>`

// ---------------------------------------------------------------------------
describe('§16 scenario 2 — sorting the sheet by date never changes identity', () => {
  // Sheet: P1 [a, b], P2 [c], P3 — each row linked to its own Basecamp record.
  const rows: LocalTask[] = [
    localTodo({ uid: 'P1', position: 1, title: 'نفس العنوان', dueOn: '2026-12-10' }),
    localSubtask({ uid: 'a', parentUid: 'P1', position: 1, title: 'أ', dueOn: '2026-11-30' }),
    localSubtask({ uid: 'b', parentUid: 'P1', position: 2, title: 'ب', dueOn: '2026-11-20' }),
    localTodo({ uid: 'P2', position: 2, title: 'نفس العنوان', dueOn: '2026-11-25' }),
    localSubtask({ uid: 'c', parentUid: 'P2', position: 1, title: 'ج', dueOn: null }),
    localTodo({ uid: 'P3', position: 3, title: 'ثالث', dueOn: null }),
  ]
  const bcIdOf: Record<string, number> = { P1: 1, a: 11, b: 12, P2: 2, c: 21, P3: 3 }
  const remoteOf = (row: LocalTask) =>
    row.level === 0
      ? remoteTodo({ id: bcIdOf[row.uid], position: row.position, content: row.title, dueOn: row.dueOn })
      : remoteSubtask({ id: bcIdOf[row.uid], position: row.position, title: row.title, dueOn: row.dueOn, todoId: bcIdOf[row.parentUid ?? ''] })
  const byDate = (x: LocalTask, y: LocalTask): number => (x.dueOn ?? '9999').localeCompare(y.dueOn ?? '9999')

  it('scenario 2: rows keep their uid, data and parent; families stay together', () => {
    const sorted = sortRows(rows, byDate)
    expect(sorted.map((r) => r.uid)).toEqual(['P2', 'c', 'P1', 'b', 'a', 'P3'])
    expect(sorted.map((r) => r.position)).toEqual([1, 1, 2, 1, 2, 3])
    const before = new Map(rows.map((r) => [r.uid, r]))
    for (const r of sorted) {
      const original = before.get(r.uid)
      expect({ ...r, position: 0 }).toEqual({ ...original, position: 0 })
    }
  })

  it('scenario 2: syncing after the sort only repositions the same Basecamp records', () => {
    const sorted = sortRows(rows, byDate)
    const moved: string[] = []
    for (const row of sorted) {
      const original = rows.find((r) => r.uid === row.uid) as LocalTask
      const remote = remoteOf(original)
      const ctx: DiffContext = row.level === 0 ? todoCtx() : subtaskCtx({ parentTodoId: bcIdOf[row.parentUid ?? ''] })
      const r = diffTask(row, baseFromRemote(row.uid, remote), remote, ctx)
      expect(r.inbound).toEqual([])
      for (const action of r.outbound) {
        expect(action).toEqual({ type: 'reposition', uid: row.uid, bcType: remote.type, bcId: bcIdOf[row.uid], position: row.position })
        moved.push(row.uid)
      }
    }
    expect(moved.sort()).toEqual(['P1', 'P2', 'a', 'b'])
  })

  it('scenario 2: two rows with the same title keep their own records', () => {
    const sorted = sortRows(rows, byDate)
    const sameTitle = sorted.filter((r) => r.title === 'نفس العنوان').map((r) => [r.uid, r.dueOn])
    expect(sameTitle).toEqual([
      ['P2', '2026-11-25'],
      ['P1', '2026-12-10'],
    ])
  })
})

// ---------------------------------------------------------------------------
describe('§16 scenario 8 — editing a free column appended to the description', () => {
  const remote = remoteTodo({ descriptionHtml: HUMAN_NOTES + block('القناة: تويتر') })
  const base = baseFromRemote('uid-todo', remote)

  it('scenario 8: only the managed block changes; the human part and its attachment stay byte for byte', () => {
    const local = localTodo({ freeColumnsForDescription: { القناة: 'لينكدإن' } })
    const r = diffTask(local, base, remote, todoCtx())
    const write = only(r.outbound, 'update_todo').write
    expect(write.descriptionHtml).toBe(HUMAN_NOTES + block('القناة: لينكدإن'))
    expect(splitDescription(write.descriptionHtml).human).toBe(splitDescription(remote.descriptionHtml).human)
    expect(write.descriptionHtml).toContain('<bc-attachment sgid="BAh7CEkiCGdpZAY6BkVU"')
    expect(r.inbound).toEqual([])
  })

  it('scenario 8: a human part Basecamp reflowed is sent back exactly as Basecamp has it', () => {
    const reflowed = HUMAN_NOTES.replace('</div><div>', '</div>\n<div>')
    const remote2 = remoteTodo({ descriptionHtml: reflowed + block('القناة: تويتر'), updatedAt: T2 })
    const r = diffTask(localTodo({ freeColumnsForDescription: { القناة: 'لينكدإن' } }), base, remote2, todoCtx())
    expect(only(r.outbound, 'update_todo').write.descriptionHtml).toBe(reflowed + block('القناة: لينكدإن'))
    expect(r.inbound).toEqual([])
  })

  it('scenario 8: clearing the value removes its line, and an empty block is dropped', () => {
    const r = diffTask(localTodo({ freeColumnsForDescription: { القناة: '' } }), base, remote, todoCtx())
    expect(only(r.outbound, 'update_todo').write.descriptionHtml).toBe(HUMAN_NOTES)
  })
})

// ---------------------------------------------------------------------------
describe('§16 scenario 9 — changing only the date of a to-do', () => {
  const description = HUMAN_NOTES + block('مسؤولون خارجيون: سارة المطيري (وكالة الإعلام)')
  const remote = remoteTodo({
    descriptionHtml: description,
    assigneeIds: [AHMED, BADR],
    completionSubscriberIds: [DANA, JUMANA],
    startsOn: '2026-11-15',
  })
  const base = baseFromRemote('uid-todo', remote)
  const local = localTodo({ assignees: [person(AHMED), person(BADR), external(SARA)] })

  it('scenario 9: the row is in sync before the change', () => {
    expect(diffTask(local, base, remote, todoCtx())).toMatchObject({ outbound: [], inbound: [] })
  })

  it('scenario 9: one full PUT that keeps assignees, description, subscribers and start date', () => {
    const r = diffTask({ ...local, dueOn: '2026-12-15' }, base, remote, todoCtx())
    expect(only(r.outbound, 'update_todo')).toEqual({
      type: 'update_todo',
      uid: 'uid-todo',
      todoId: TODO_ID,
      write: {
        content: remote.content,
        descriptionHtml: description,
        assigneeIds: [AHMED, BADR],
        completionSubscriberIds: [DANA, JUMANA],
        dueOn: '2026-12-15',
        startsOn: '2026-11-15',
        notify: false,
      },
    })
    expect(r.inbound).toEqual([])
  })

  it('scenario 9: clearing the date sends null and still every other field', () => {
    const write = only(diffTask({ ...local, dueOn: null }, base, remote, todoCtx()).outbound, 'update_todo').write
    expect(write).toMatchObject({ dueOn: null, assigneeIds: [AHMED, BADR], descriptionHtml: description, startsOn: '2026-11-15' })
  })
})

// ---------------------------------------------------------------------------
describe('§16 scenario 10 — deleting a subtask', () => {
  const snapshot = remoteSubtask({ title: 'تصميم الإعلان', assigneeIds: [BADR], dueOn: '2026-11-20', position: 2, completed: true })

  it('scenario 10: the permanent delete carries the full record as a snapshot', () => {
    const r = planDeletion([{ task: localSubtask(), bcId: SUBTASK_ID, remoteSubtask: snapshot }])
    expect(r).toEqual({ ok: true, value: [{ type: 'delete_subtask', uid: 'uid-sub', subtaskId: SUBTASK_ID, snapshot }] })
  })

  it('scenario 10: without the snapshot nothing is deleted', () => {
    expect(planDeletion([{ task: localSubtask(), bcId: SUBTASK_ID }])).toMatchObject({ ok: false, error: { code: 'snapshot_required' } })
  })

  it('scenario 10: undo re-creates it as a new subtask, then restores completion', () => {
    const create = recreateSubtaskFromSnapshot(snapshot, 'uid-sub')
    expect(create).toEqual({
      type: 'create_subtask',
      uid: 'uid-sub',
      parentTodoId: TODO_ID,
      create: { title: 'تصميم الإعلان', dueOn: '2026-11-20', assigneeIds: [BADR] },
      position: 2,
    })
    // The restored row has no base and no id: the diff creates the same subtask, never a "restore".
    const restored = localSubtask({ position: 2, completed: true })
    expect(diffTask(restored, null, null, subtaskCtx()).outbound).toEqual([create])
    // Once created, the next diff completes it.
    const created = remoteSubtask({ id: SUBTASK_ID + 1, position: 2, completed: false, updatedAt: T2 })
    const base = baseAfterSubtaskWrite('uid-sub', created, create.type === 'create_subtask' ? create.create : {})
    expect(diffTask(restored, base, created, subtaskCtx()).outbound).toEqual([
      { type: 'set_completion', uid: 'uid-sub', bcType: 'subtask', bcId: SUBTASK_ID + 1, completed: true },
    ])
  })

  it('scenario 10: deleting a to-do with subtasks trashes only the to-do', () => {
    const r = planDeletion([
      { task: localTodo(), bcId: TODO_ID },
      { task: localSubtask(), bcId: SUBTASK_ID, remoteSubtask: snapshot },
    ])
    expect(r).toEqual({ ok: true, value: [{ type: 'trash_todo', uid: 'uid-todo', todoId: TODO_ID }] })
  })
})

// ---------------------------------------------------------------------------
// Automatic assignment (§8.1): A = AHMED, B = BADR, C = JUMANA, D = DANA.
const settings = DEFAULT_AUTO_ASSIGN_SETTINGS
const parentRemote = (overrides: Partial<RemoteTodo> = {}): RemoteTodo => remoteTodo({ descriptionHtml: '', assigneeIds: [], ...overrides })
const autoParent = (overrides: Partial<LocalTask> = {}): LocalTask =>
  localTodo({ assignees: [], assignMode: 'auto', notesHtml: null, ...overrides })
const subs = (...assigneeLists: number[][]): LocalTask[] =>
  assigneeLists.map((ids, i) => localSubtask({ uid: `s${i + 1}`, position: i + 1, assignees: ids.map((id) => person(id)) }))
const autoCtx = (subtasks: LocalTask[], overrides: Partial<DiffContext> = {}): DiffContext =>
  todoCtx({ autoAssign: { subtasks, settings }, ...overrides })

describe('§16 scenario 13 — unassigned to-do with subtasks assigned to A, B, A', () => {
  const subtasks = subs([AHMED], [BADR], [AHMED])

  it('scenario 13: the to-do is assigned A and B in the sheet and in Basecamp, without a second notification', () => {
    const remote = parentRemote()
    const r = diffTask(autoParent(), baseFromRemote('uid-todo', remote), remote, autoCtx(subtasks))
    expect(r.inbound).toEqual([
      { type: 'update_row', uid: 'uid-todo', fields: { assignees: [person(AHMED, 'auto'), person(BADR, 'auto')] } },
    ])
    const write = only(r.outbound, 'update_todo').write
    expect(write.assigneeIds).toEqual([AHMED, BADR])
    expect(write.notify).toBe(false)
    expect(r.assignMode).toBeNull()
  })

  it('scenario 13: a new to-do is created already assigned, also without notification', () => {
    const write = only(diffTask(autoParent(), null, null, autoCtx(subtasks)).outbound, 'create_todo').write
    expect(write.assigneeIds).toEqual([AHMED, BADR])
    expect(write.notify).toBe(false)
  })
})

describe('§16 scenario 14 — a new subtask assigned to C in Basecamp', () => {
  const remote = parentRemote({ assigneeIds: [AHMED, BADR] })
  const base = baseFromRemote('uid-todo', remote)
  const parent = autoParent({ assignees: [person(AHMED, 'auto'), person(BADR, 'auto')] })

  it('scenario 14: the subtask becomes a row and C is added to the to-do automatically', () => {
    const created = inboundCreateRow(remoteSubtask({ id: 8009, position: 3, assigneeIds: [JUMANA] }), {
      uid: 's3',
      sheetId: 'sheet-1',
      parentUid: 'uid-todo',
    })
    expect(created.type).toBe('create_row')
    const newRow = (created as Extract<typeof created, { type: 'create_row' }>).task
    const r = diffTask(parent, base, remote, autoCtx([...subs([AHMED], [BADR]), newRow]))
    const write = only(r.outbound, 'update_todo').write
    expect(write.assigneeIds).toEqual([AHMED, BADR, JUMANA])
    expect(write.notify).toBe(false)
    expect(r.inbound).toEqual([
      {
        type: 'update_row',
        uid: 'uid-todo',
        fields: { assignees: [person(AHMED, 'auto'), person(BADR, 'auto'), person(JUMANA, 'auto')] },
      },
    ])
  })

  it('scenario 14: an existing subtask reassigned to C in Basecamp updates it, then the to-do', () => {
    const sub = localSubtask({ uid: 's2', position: 2, assignees: [person(BADR)] })
    const subRemote = remoteSubtask({ id: 8002, position: 2, assigneeIds: [BADR] })
    const subResult = diffTask(sub, baseFromRemote('s2', subRemote), { ...subRemote, assigneeIds: [JUMANA], updatedAt: T2 }, subtaskCtx())
    expect(subResult.inbound).toEqual([{ type: 'update_row', uid: 's2', fields: { assignees: [person(JUMANA)] } }])
    const updated = { ...sub, assignees: [person(JUMANA)] }
    const r = diffTask(parent, base, remote, autoCtx([...subs([AHMED]), updated]))
    expect(only(r.outbound, 'update_todo').write.assigneeIds).toEqual([AHMED, JUMANA])
  })
})

describe('§16 scenario 15 — manual assignment stops the union; emptying restores it', () => {
  const remote = parentRemote({ assigneeIds: [AHMED, BADR] })
  const base = baseFromRemote('uid-todo', remote)

  it('scenario 15: assigning D by hand makes the to-do manual with D only', () => {
    const edit = applyAssigneeEdit(autoParent({ assignees: [person(AHMED, 'auto'), person(BADR, 'auto')] }), [person(DANA)], {
      subtasks: subs([AHMED], [BADR]),
    })
    expect(edit).toEqual({ ok: true, value: { assignMode: 'manual', assignees: [person(DANA)] } })
    const parent = autoParent({ assignMode: 'manual', assignees: [person(DANA)], localChangedAt: T3 })
    const write = only(diffTask(parent, base, remote, autoCtx(subs([AHMED], [BADR]))).outbound, 'update_todo').write
    expect(write.assigneeIds).toEqual([DANA])
    expect(write.notify).toBe(true)
  })

  it('scenario 15: later subtask changes leave the manual to-do with D only', () => {
    const remoteD = parentRemote({ assigneeIds: [DANA], updatedAt: T3 })
    const parent = autoParent({ assignMode: 'manual', assignees: [person(DANA)] })
    const r = diffTask(parent, baseFromRemote('uid-todo', remoteD), remoteD, autoCtx(subs([AHMED], [BADR], [JUMANA])))
    expect(r).toMatchObject({ outbound: [], inbound: [], assignMode: null })
  })

  it('scenario 15: emptying the cell returns to the union at once', () => {
    const remoteD = parentRemote({ assigneeIds: [DANA], updatedAt: T3 })
    const subtasks = subs([AHMED], [BADR], [JUMANA])
    const edit = applyAssigneeEdit(autoParent({ assignMode: 'manual', assignees: [person(DANA)] }), [], { subtasks })
    expect(edit).toEqual({
      ok: true,
      value: { assignMode: 'auto', assignees: [person(AHMED, 'auto'), person(BADR, 'auto'), person(JUMANA, 'auto')] },
    })
    const parent = autoParent(edit.ok ? edit.value : {})
    const r = diffTask(parent, baseFromRemote('uid-todo', remoteD), remoteD, autoCtx(subtasks))
    const write = only(r.outbound, 'update_todo').write
    expect(write.assigneeIds).toEqual([AHMED, BADR, JUMANA])
    expect(write.notify).toBe(false)
  })
})

describe('§16 scenario 16 — the automatic update comes back as a webhook', () => {
  const subtasks = subs([AHMED], [BADR])
  const union = computeAutoAssignees(autoParent(), subtasks, settings)
  const before = parentRemote()
  const beforeBase = baseFromRemote('uid-todo', before)
  const parent = autoParent({ assignees: union, localChangedAt: T1 })

  function sentWrite(): ReturnType<typeof only<'update_todo'>>['write'] {
    return only(diffTask(autoParent(), beforeBase, before, autoCtx(subtasks)).outbound, 'update_todo').write
  }

  it('scenario 16: after the write, the echo produces no action and keeps auto mode', () => {
    const write = sentWrite()
    const response = parentRemote({ assigneeIds: [BADR, AHMED], updatedAt: T2 })
    const base: SyncedBase = baseAfterTodoWrite('uid-todo', response, write)
    const r = diffTask(parent, base, { ...response, updatedAt: T3 }, autoCtx(subtasks))
    expect(r).toEqual({ outbound: [], inbound: [], conflicts: [], assignMode: null, warnings: [] })
  })

  it('scenario 16: an echo that arrives before the base is saved is recognised too', () => {
    const r = diffTask(parent, beforeBase, parentRemote({ assigneeIds: [AHMED, BADR], updatedAt: T2 }), autoCtx(subtasks))
    expect(r).toEqual({ outbound: [], inbound: [], conflicts: [], assignMode: null, warnings: [] })
  })

  it('scenario 16: a different change made by a person in Basecamp switches to manual, once', () => {
    const base = baseAfterTodoWrite('uid-todo', parentRemote({ assigneeIds: [AHMED, BADR], updatedAt: T2 }), sentWrite())
    const r = diffTask(parent, base, parentRemote({ assigneeIds: [AHMED], updatedAt: T3 }), autoCtx(subtasks))
    expect(r.assignMode).toBe('manual')
    expect(r.inbound).toEqual([{ type: 'update_row', uid: 'uid-todo', fields: { assignees: [person(AHMED)] } }])
    expect(r.outbound).toEqual([])
  })
})

// ---------------------------------------------------------------------------
describe('§16 scenario 20 — two Basecamp people and an external contact', () => {
  const local = localTodo({ assignees: [person(AHMED), person(BADR), external(SARA)] })
  const expectedBlock = block('مسؤولون خارجيون: سارة المطيري (وكالة الإعلام)')

  it('scenario 20: the two people are assignees, the external is in the block, the human text is unchanged', () => {
    const remote = remoteTodo({ assigneeIds: [AHMED] })
    const r = diffTask(local, baseFromRemote('uid-todo', remote), remote, todoCtx())
    const write = only(r.outbound, 'update_todo').write
    expect(write.assigneeIds).toEqual([AHMED, BADR])
    expect(write.descriptionHtml).toBe(HUMAN_NOTES + expectedBlock)
    expect(splitDescription(write.descriptionHtml)).toEqual({ human: HUMAN_NOTES, block: expectedBlock })
  })

  it('scenario 20: the same on creation', () => {
    const write = only(diffTask(local, null, null, todoCtx()).outbound, 'create_todo').write
    expect(write.assigneeIds).toEqual([AHMED, BADR])
    expect(write.descriptionHtml).toBe(HUMAN_NOTES + expectedBlock)
  })
})

describe('§16 scenario 21 — a to-do assigned only to an external contact', () => {
  it('scenario 21: the assignment is refused until an internal follower is chosen', () => {
    const r = applyAssigneeEdit(localTodo(), [external(SARA)])
    expect(r).toEqual({ ok: false, error: { code: 'external_requires_follower', message: ERROR_MESSAGES.external_requires_follower } })
  })

  it('scenario 21: with a follower it is saved, and the follower is assigned in Basecamp', () => {
    const edit = applyAssigneeEdit(localTodo(), [external(SARA), follower(FAHAD)])
    expect(edit.ok).toBe(true)
    const local = localTodo(edit.ok ? edit.value : {})
    const remote = remoteTodo()
    const write = only(diffTask(local, baseFromRemote('uid-todo', remote), remote, todoCtx()).outbound, 'update_todo').write
    expect(write.assigneeIds).toEqual([FAHAD])
    expect(write.descriptionHtml).toBe(HUMAN_NOTES + block('مسؤولون خارجيون: سارة المطيري (وكالة الإعلام)', 'المتابع الداخلي: فهد'))
  })

  it('scenario 21: a row that somehow holds an external-only set is not sent', () => {
    const remote = remoteTodo()
    const r = diffTask(localTodo({ assignees: [external(SARA)] }), baseFromRemote('uid-todo', remote), remote, todoCtx())
    expect(r.outbound).toEqual([])
    expect(r.warnings.map((w) => w.code)).toEqual(['invalid_local_assignees'])
  })
})

describe('§16 scenario 22 — a subtask assigned only to an external contact', () => {
  it('scenario 22: refused without a follower', () => {
    expect(applyAssigneeEdit(localSubtask(), [external(SARA)])).toMatchObject({ ok: false, error: { code: 'external_requires_follower' } })
  })

  it('scenario 22: the follower is the subtask’s assignee in Basecamp; the external stays in the platform', () => {
    const local = localSubtask({ assignees: [external(SARA), follower(FAHAD)] })
    const remote = remoteSubtask({ assigneeIds: [BADR] })
    const r = diffTask(local, baseFromRemote('uid-sub', remote), remote, subtaskCtx())
    expect(only(r.outbound, 'update_subtask').patch).toEqual({ assigneeIds: [FAHAD] })
    const created = only(diffTask(local, null, null, subtaskCtx()).outbound, 'create_subtask')
    expect(created.create.assigneeIds).toEqual([FAHAD])
  })

  it('scenario 22: changes coming from Basecamp never remove the external', () => {
    const local = localSubtask({ assignees: [external(SARA), follower(FAHAD)] })
    const remote = remoteSubtask({ assigneeIds: [FAHAD] })
    const base = baseFromRemote('uid-sub', remote)
    const titleOnly = diffTask(local, base, { ...remote, title: 'عنوان جديد', updatedAt: T2 }, subtaskCtx())
    expect(titleOnly.inbound).toEqual([{ type: 'update_row', uid: 'uid-sub', fields: { title: 'عنوان جديد' } }])
    const reassigned = diffTask(local, base, { ...remote, assigneeIds: [FAHAD, JUMANA], updatedAt: T2 }, subtaskCtx())
    expect(reassigned.inbound).toEqual([
      { type: 'update_row', uid: 'uid-sub', fields: { assignees: [external(SARA), follower(FAHAD), person(JUMANA)] } },
    ])
  })
})

// ---------------------------------------------------------------------------
describe('§16 scenario 24 — the managed block edited by hand in Basecamp', () => {
  const local = localTodo({ assignees: [person(AHMED), external(SARA)] })
  const platformBlock = block('مسؤولون خارجيون: سارة المطيري (وكالة الإعلام)')
  const synced = remoteTodo({ descriptionHtml: HUMAN_NOTES + platformBlock, updatedAt: T0 })
  const base = baseFromRemote('uid-todo', synced)

  it('scenario 24: an edited block is rewritten from the platform and logged; the human text is kept', () => {
    const edited = remoteTodo({ descriptionHtml: HUMAN_NOTES + block('مسؤولون خارجيون: شخص آخر'), updatedAt: T2 })
    const r = diffTask(local, base, edited, todoCtx())
    expect(r.inbound).toEqual([{ type: 'rewrite_managed_block', uid: 'uid-todo' }])
    expect(only(r.outbound, 'update_todo').write.descriptionHtml).toBe(HUMAN_NOTES + platformBlock)
  })

  it('scenario 24: a block deleted in Basecamp is written back', () => {
    const deleted = remoteTodo({ descriptionHtml: HUMAN_NOTES, updatedAt: T2 })
    const r = diffTask(local, base, deleted, todoCtx())
    expect(r.inbound).toEqual([{ type: 'rewrite_managed_block', uid: 'uid-todo' }])
    expect(only(r.outbound, 'update_todo').write.descriptionHtml).toBe(HUMAN_NOTES + platformBlock)
  })

  it('scenario 24: markup Basecamp rewrote is not an edit and causes no write', () => {
    const sanitised = platformBlock.replace('<hr>', '<hr />\n').replace('<br>', '<br/>')
    const r = diffTask(local, base, remoteTodo({ descriptionHtml: HUMAN_NOTES + sanitised, updatedAt: T2 }), todoCtx())
    expect(r).toMatchObject({ outbound: [], inbound: [] })
  })

  it('scenario 24: a human edit and a block edit together: the notes come in, the block is rewritten', () => {
    const notes = '<div>تعديل بشري</div>'
    const both = remoteTodo({ descriptionHtml: notes + block('عبث'), updatedAt: T2 })
    const r = diffTask(local, base, both, todoCtx())
    expect(r.inbound).toEqual([
      { type: 'update_row', uid: 'uid-todo', fields: { notesHtml: notes } },
      { type: 'rewrite_managed_block', uid: 'uid-todo' },
    ])
    expect(only(r.outbound, 'update_todo').write.descriptionHtml).toBe(notes + platformBlock)
  })

  it('scenario 24: the rewrite coming back is an echo, so there is no loop', () => {
    const edited = remoteTodo({ descriptionHtml: HUMAN_NOTES + block('عبث'), updatedAt: T2 })
    const write = only(diffTask(local, base, edited, todoCtx()).outbound, 'update_todo').write
    const response = remoteTodo({ descriptionHtml: write.descriptionHtml.replace('<hr>', '<hr/>'), updatedAt: T3 })
    const r = diffTask(local, baseAfterTodoWrite('uid-todo', response, write), response, todoCtx())
    expect(r).toEqual({ outbound: [], inbound: [], conflicts: [], assignMode: null, warnings: [] })
  })
})
