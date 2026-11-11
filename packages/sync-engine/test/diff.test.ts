import { describe, expect, it } from 'vitest'
import type { OutboundAction } from '@naf-sheets/shared'
import { baseFromRemote, diffTask, inboundCreateRow, lastWriter, MANAGED_BLOCK_TITLE, splitDescription } from '../src'
import {
  AHMED,
  BADR,
  DANA,
  directory,
  external,
  FAHAD,
  follower,
  HUMAN_NOTES,
  JUMANA,
  LIST,
  localSubtask,
  localTodo,
  OTHER_LIST,
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

const remote0 = remoteTodo()
const base0 = baseFromRemote('uid-todo', remote0)
const sub0 = remoteSubtask()
const subBase0 = baseFromRemote('uid-sub', sub0)

function only<T extends OutboundAction['type']>(actions: OutboundAction[], type: T): Extract<OutboundAction, { type: T }> {
  expect(actions.map((a) => a.type)).toEqual([type])
  return actions[0] as Extract<OutboundAction, { type: T }>
}

describe('lastWriter', () => {
  it('compares instants, not strings, and gives ties and unknowns to Basecamp', () => {
    expect(lastWriter('2026-11-10T12:00:00+03:00', '2026-11-10T08:30:00Z')).toBe('local')
    expect(lastWriter('2026-11-10T11:00:00+03:00', '2026-11-10T08:30:00Z')).toBe('remote')
    expect(lastWriter(T2, T2)).toBe('remote')
    expect(lastWriter(null, T0)).toBe('remote')
    expect(lastWriter('not a date', T0)).toBe('remote')
  })
})

describe('diffTask — steady state and echo', () => {
  it('a row in sync with its base and record produces nothing', () => {
    expect(diffTask(localTodo(), base0, remote0, todoCtx())).toEqual({
      outbound: [],
      inbound: [],
      conflicts: [],
      warnings: [],
    })
  })

  it('a record equal to the base but with a newer updated_at is our echo: no inbound action', () => {
    const r = diffTask(localTodo({ localChangedAt: T0 }), base0, { ...remote0, updatedAt: T3 }, todoCtx())
    expect(r.inbound).toEqual([])
    expect(r.outbound).toEqual([])
  })
})

describe('diffTask — create and idempotency', () => {
  it('creates a to-do with the complete state', () => {
    const local = localTodo({ assignees: [person(AHMED), external(SARA)], position: 4 })
    const r = diffTask(local, null, null, todoCtx())
    const create = only(r.outbound, 'create_todo')
    expect(create.listId).toBe(LIST)
    expect(create.position).toBe(4)
    expect(create.write).toEqual({
      content: 'إطلاق الحملة',
      descriptionHtml: `${HUMAN_NOTES}<hr><div><strong>${MANAGED_BLOCK_TITLE}</strong><br>مسؤولون خارجيون: سارة المطيري (وكالة الإعلام)</div>`,
      assigneeIds: [AHMED],
      completionSubscriberIds: [],
      dueOn: '2026-12-01',
      startsOn: '2026-11-15',
      notify: true,
    })
  })

  it('never creates when the row already holds a Basecamp id', () => {
    const r = diffTask(localTodo({ bcId: TODO_ID }), null, null, todoCtx())
    expect(r.outbound).toEqual([])
    expect(r.warnings.map((w) => w.code)).toEqual(['remote_required'])
    const sub = diffTask(localSubtask({ bcId: SUBTASK_ID }), null, null, subtaskCtx())
    expect(sub.outbound).toEqual([])
    expect(sub.warnings.map((w) => w.code)).toEqual(['remote_required'])
  })

  it('never creates once a base or a record exists', () => {
    const fromBase = diffTask(localTodo({ dueOn: '2027-01-01' }), base0, remote0, todoCtx())
    expect(fromBase.outbound.map((a) => a.type)).toEqual(['update_todo'])
    const fromRemote = diffTask(localTodo(), null, remote0, todoCtx())
    expect(fromRemote.outbound.some((a) => a.type === 'create_todo')).toBe(false)
  })

  it('does nothing for a row of a local (unsynced) sheet', () => {
    expect(diffTask(localTodo(), null, null, todoCtx({ listId: null })).outbound).toEqual([])
  })

  it('creates a subtask under its synced to-do, or waits for it', () => {
    const created = only(diffTask(localSubtask({ position: 2 }), null, null, subtaskCtx()).outbound, 'create_subtask')
    expect(created).toEqual({
      type: 'create_subtask',
      uid: 'uid-sub',
      parentTodoId: TODO_ID,
      create: { title: 'تصميم الإعلان', dueOn: '2026-11-20', assigneeIds: [BADR] },
      position: 2,
    })
    const waiting = diffTask(localSubtask(), null, null, subtaskCtx({ parentTodoId: null }))
    expect(waiting.outbound).toEqual([])
    expect(waiting.warnings.map((w) => w.code)).toEqual(['parent_not_synced'])
  })
})

describe('diffTask — conflicts, field by field, last writer wins', () => {
  it('both sides changed the title: the later local change wins and is reported', () => {
    const r = diffTask(localTodo({ title: 'محلي', localChangedAt: T3 }), base0, remoteTodo({ content: 'بعيد', updatedAt: T2 }), todoCtx())
    expect(only(r.outbound, 'update_todo').write.content).toBe('محلي')
    expect(r.inbound).toEqual([])
    expect(r.conflicts).toEqual([
      { uid: 'uid-todo', field: 'title', localValue: 'محلي', remoteValue: 'بعيد', winner: 'local', localChangedAt: T3, remoteUpdatedAt: T2 },
    ])
  })

  it('both sides changed the title: the later Basecamp change wins and is reported', () => {
    const r = diffTask(localTodo({ title: 'محلي', localChangedAt: T1 }), base0, remoteTodo({ content: 'بعيد', updatedAt: T2 }), todoCtx())
    expect(r.outbound).toEqual([])
    expect(r.inbound).toEqual([{ type: 'update_row', uid: 'uid-todo', fields: { title: 'بعيد' } }])
    expect(r.conflicts[0]?.winner).toBe('remote')
  })

  it('the conflict unit is the field: other fields merge from both sides', () => {
    const r = diffTask(
      localTodo({ dueOn: '2027-01-01', localChangedAt: T1 }),
      base0,
      remoteTodo({ content: 'عنوان من Basecamp', updatedAt: T2 }),
      todoCtx(),
    )
    expect(r.conflicts).toEqual([])
    expect(r.inbound).toEqual([{ type: 'update_row', uid: 'uid-todo', fields: { title: 'عنوان من Basecamp' } }])
    const write = only(r.outbound, 'update_todo').write
    expect(write.dueOn).toBe('2027-01-01')
    expect(write.content).toBe('عنوان من Basecamp')
  })

  it('both sides made the same change: no conflict and nothing to do', () => {
    const r = diffTask(localTodo({ dueOn: '2027-01-01' }), base0, remoteTodo({ dueOn: '2027-01-01', updatedAt: T2 }), todoCtx())
    expect(r).toMatchObject({ outbound: [], inbound: [], conflicts: [] })
  })

  it('without a base (first link) every difference is a conflict', () => {
    const r = diffTask(localTodo({ dueOn: '2027-01-01', localChangedAt: T3 }), null, remoteTodo({ updatedAt: T2 }), todoCtx())
    expect(r.conflicts.map((c) => [c.field, c.winner])).toEqual([['dueOn', 'local']])
    expect(only(r.outbound, 'update_todo').todoId).toBe(TODO_ID)
  })
})

describe('diffTask — to-do updates are complete, completion and order are separate', () => {
  it('a to-do update carries every field and keeps completion subscribers', () => {
    const write = only(diffTask(localTodo({ title: 'جديد' }), base0, remote0, todoCtx()).outbound, 'update_todo').write
    expect(Object.keys(write).sort()).toEqual(
      ['assigneeIds', 'completionSubscriberIds', 'content', 'descriptionHtml', 'dueOn', 'notify', 'startsOn'].sort(),
    )
    expect(write.completionSubscriberIds).toEqual([DANA])
    expect(write.assigneeIds).toEqual([AHMED])
    expect(write.descriptionHtml).toBe(HUMAN_NOTES)
  })

  it('completion goes out as set_completion only', () => {
    const r = diffTask(localTodo({ completed: true }), base0, remote0, todoCtx())
    expect(r.outbound).toEqual([{ type: 'set_completion', uid: 'uid-todo', bcType: 'todo', bcId: TODO_ID, completed: true }])
  })

  it('completion in Basecamp comes in as a field update', () => {
    const r = diffTask(localTodo(), base0, remoteTodo({ completed: true, updatedAt: T2 }), todoCtx())
    expect(r.inbound).toEqual([{ type: 'update_row', uid: 'uid-todo', fields: { completed: true } }])
  })

  it('order goes out as a 1-based reposition; Basecamp order comes in as position', () => {
    expect(diffTask(localTodo({ position: 3 }), base0, remote0, todoCtx()).outbound).toEqual([
      { type: 'reposition', uid: 'uid-todo', bcType: 'todo', bcId: TODO_ID, position: 3 },
    ])
    expect(diffTask(localTodo(), base0, remoteTodo({ position: 2 }), todoCtx()).inbound).toEqual([
      { type: 'update_row', uid: 'uid-todo', fields: { position: 2 } },
    ])
  })

  it('order changed on both sides: the later local change wins, reported as a position conflict', () => {
    const r = diffTask(localTodo({ position: 3, localChangedAt: T3 }), base0, remoteTodo({ position: 2, updatedAt: T2 }), todoCtx())
    expect(r.outbound).toEqual([{ type: 'reposition', uid: 'uid-todo', bcType: 'todo', bcId: TODO_ID, position: 3 }])
    expect(r.inbound).toEqual([])
    expect(r.conflicts).toEqual([
      { uid: 'uid-todo', field: 'position', localValue: 3, remoteValue: 2, winner: 'local', localChangedAt: T3, remoteUpdatedAt: T2 },
    ])
    expect(r.warnings).toEqual([])
  })

  it('order changed on both sides: the later Basecamp change wins, reported as a position conflict', () => {
    const r = diffTask(localTodo({ position: 3, localChangedAt: T1 }), base0, remoteTodo({ position: 2, updatedAt: T2 }), todoCtx())
    expect(r.outbound).toEqual([])
    expect(r.inbound).toEqual([{ type: 'update_row', uid: 'uid-todo', fields: { position: 2 } }])
    expect(r.conflicts).toEqual([
      { uid: 'uid-todo', field: 'position', localValue: 3, remoteValue: 2, winner: 'remote', localChangedAt: T1, remoteUpdatedAt: T2 },
    ])
  })

  it('a row moved to another sheet moves the to-do to that list (the base knows the old list)', () => {
    expect(base0.listId).toBe(LIST)
    const r = diffTask(localTodo({ position: 2 }), base0, remote0, todoCtx({ listId: OTHER_LIST }))
    expect(r.outbound).toEqual([{ type: 'reposition', uid: 'uid-todo', bcType: 'todo', bcId: TODO_ID, position: 2, listId: OTHER_LIST }])
    expect(r.conflicts).toEqual([])
    const unfetched = diffTask(localTodo({ position: 2 }), base0, null, todoCtx({ listId: OTHER_LIST }))
    expect(unfetched.outbound).toEqual(r.outbound)
  })

  it('a to-do moved to another list in Basecamp moves the row (§9.3.11)', () => {
    const r = diffTask(localTodo(), base0, remoteTodo({ listId: OTHER_LIST, position: 5, updatedAt: T2 }), todoCtx())
    expect(r.inbound).toEqual([{ type: 'move_row', uid: 'uid-todo', toListId: OTHER_LIST, position: 5 }])
    expect(r.outbound).toEqual([])
  })

  it('moved to different lists on both sides: last writer wins, reported as a listId conflict', () => {
    const third = OTHER_LIST + 1
    const later = diffTask(localTodo({ localChangedAt: T3 }), base0, remoteTodo({ listId: OTHER_LIST, updatedAt: T2 }), todoCtx({ listId: third }))
    expect(later.outbound).toEqual([{ type: 'reposition', uid: 'uid-todo', bcType: 'todo', bcId: TODO_ID, position: 1, listId: third }])
    expect(later.conflicts).toEqual([
      { uid: 'uid-todo', field: 'listId', localValue: third, remoteValue: OTHER_LIST, winner: 'local', localChangedAt: T3, remoteUpdatedAt: T2 },
    ])
    const earlier = diffTask(localTodo({ localChangedAt: T1 }), base0, remoteTodo({ listId: OTHER_LIST, position: 4, updatedAt: T2 }), todoCtx({ listId: third }))
    expect(earlier.inbound).toEqual([{ type: 'move_row', uid: 'uid-todo', toListId: OTHER_LIST, position: 4 }])
    expect(earlier.conflicts.map((c) => [c.field, c.winner])).toEqual([['listId', 'remote']])
  })

  it('without a base the list difference cannot be attributed: last writer wins and it is reported', () => {
    const r = diffTask(localTodo({ localChangedAt: T1 }), null, remoteTodo({ listId: OTHER_LIST, updatedAt: T2 }), todoCtx())
    expect(r.inbound).toEqual([{ type: 'move_row', uid: 'uid-todo', toListId: OTHER_LIST, position: 1 }])
    expect(r.conflicts.map((c) => [c.field, c.winner])).toEqual([['listId', 'remote']])
  })

  it('notify is set only when a person newly assigns someone', () => {
    const added = only(diffTask(localTodo({ assignees: [person(AHMED), person(BADR)] }), base0, remote0, todoCtx()).outbound, 'update_todo')
    expect(added.write.notify).toBe(true)
    const removed = only(diffTask(localTodo({ assignees: [] }), base0, remote0, todoCtx()).outbound, 'update_todo')
    expect(removed.write.notify).toBe(false)
    expect(removed.write.assigneeIds).toEqual([])
  })
})

describe('diffTask — to-do update without the fetched record (§9.2.4: last synced state)', () => {
  const remote = remoteTodo({ assigneeIds: [AHMED, BADR], completionSubscriberIds: [DANA, JUMANA] })
  const base = baseFromRemote('uid-todo', remote)
  const local = localTodo({ assignees: [person(AHMED), person(BADR)], bcId: TODO_ID })

  it('builds the complete PUT from the base: subscribers, description, start date and assignees are kept', () => {
    const r = diffTask({ ...local, dueOn: '2027-01-01' }, base, null, todoCtx())
    expect(r.outbound).toEqual([
      {
        type: 'update_todo',
        uid: 'uid-todo',
        todoId: TODO_ID,
        write: {
          content: 'إطلاق الحملة',
          descriptionHtml: HUMAN_NOTES,
          assigneeIds: [AHMED, BADR],
          completionSubscriberIds: [DANA, JUMANA],
          dueOn: '2027-01-01',
          startsOn: '2026-11-15',
          notify: false,
        },
      },
    ])
    expect(r.inbound).toEqual([])
    expect(r.warnings).toEqual([])
  })

  it('sends the same PUT as with the fetched record when Basecamp has not changed', () => {
    const changed = { ...local, title: 'جديد', assignees: [person(AHMED), person(BADR), person(FAHAD)] }
    const fromBase = diffTask(changed, base, null, todoCtx())
    const fromRecord = diffTask(changed, base, remote, todoCtx())
    expect(only(fromBase.outbound, 'update_todo')).toEqual(only(fromRecord.outbound, 'update_todo'))
    expect(only(fromBase.outbound, 'update_todo').write.notify).toBe(true)
  })

  it('keeps the managed block the base holds when the directory cannot rebuild it', () => {
    const block = `<hr><div><strong>${MANAGED_BLOCK_TITLE}</strong><br>مسؤولون خارجيون: قديم</div>`
    const withBlock = baseFromRemote('uid-todo', remoteTodo({ descriptionHtml: HUMAN_NOTES + block, completionSubscriberIds: [DANA] }))
    const r = diffTask(
      localTodo({ assignees: [person(AHMED), external('ext-unknown')], title: 'جديد', bcId: TODO_ID }),
      withBlock,
      null,
      { ...todoCtx(), directory: { ...directory, externalContacts: new Map() } },
    )
    const write = only(r.outbound, 'update_todo').write
    expect(write.descriptionHtml).toBe(HUMAN_NOTES + block)
    expect(write.completionSubscriberIds).toEqual([DANA])
  })

  it('completion still goes out on its own endpoint', () => {
    const r = diffTask({ ...local, dueOn: '2027-01-01', completed: true }, base, null, todoCtx())
    expect(r.outbound.map((a) => a.type)).toEqual(['update_todo', 'set_completion'])
  })
})

describe('diffTask — positions Basecamp did not send (single-record GET)', () => {
  const unpositioned = (overrides: Parameters<typeof remoteTodo>[0] = {}) => remoteTodo({ position: null, ...overrides })

  it('an unknown position is not an order change and does not break echo suppression', () => {
    expect(diffTask(localTodo(), base0, unpositioned({ updatedAt: T2 }), todoCtx())).toEqual({ outbound: [], inbound: [], conflicts: [], warnings: [] })
    const sub = diffTask(localSubtask(), subBase0, remoteSubtask({ position: null, updatedAt: T2 }), subtaskCtx())
    expect(sub).toEqual({ outbound: [], inbound: [], conflicts: [], warnings: [] })
  })

  it('other changes in the record still come in; the row keeps its position', () => {
    const r = diffTask(localTodo(), base0, unpositioned({ content: 'من Basecamp', updatedAt: T2 }), todoCtx())
    expect(r.inbound).toEqual([{ type: 'update_row', uid: 'uid-todo', fields: { title: 'من Basecamp' } }])
    expect(r.outbound).toEqual([])
  })

  it('a local order change still goes out, and is never reported as a conflict', () => {
    const r = diffTask(localTodo({ position: 3, localChangedAt: T1 }), base0, unpositioned({ content: 'من Basecamp', updatedAt: T2 }), todoCtx())
    expect(r.outbound).toEqual([{ type: 'reposition', uid: 'uid-todo', bcType: 'todo', bcId: TODO_ID, position: 3 }])
    expect(r.conflicts).toEqual([])
  })

  it('without a base nothing is known about order: no reposition, no conflict', () => {
    const r = diffTask(localTodo({ position: 4 }), null, unpositioned(), todoCtx())
    expect(r.outbound).toEqual([])
    expect(r.conflicts).toEqual([])
  })

  it('a list move read without a position moves the row with position null (placed at the end)', () => {
    const r = diffTask(localTodo(), base0, unpositioned({ listId: OTHER_LIST, updatedAt: T2 }), todoCtx())
    expect(r.inbound).toEqual([{ type: 'move_row', uid: 'uid-todo', toListId: OTHER_LIST, position: null }])
  })

  it('a list move that is otherwise an echo takes the record’s position, never the base’s', () => {
    const r = diffTask(localTodo(), base0, remoteTodo({ listId: OTHER_LIST, position: 7, updatedAt: T2 }), todoCtx())
    expect(r.inbound).toEqual([{ type: 'move_row', uid: 'uid-todo', toListId: OTHER_LIST, position: 7 }])
  })
})

describe('diffTask — subtasks', () => {
  it('sends only the changed fields', () => {
    const r = diffTask(localSubtask({ title: 'تصميم نهائي' }), subBase0, sub0, subtaskCtx())
    expect(r.outbound).toEqual([{ type: 'update_subtask', uid: 'uid-sub', subtaskId: SUBTASK_ID, patch: { title: 'تصميم نهائي' } }])
  })

  it('clears a date with null and assignees with []', () => {
    const r = diffTask(localSubtask({ dueOn: null, assignees: [] }), subBase0, sub0, subtaskCtx())
    expect(only(r.outbound, 'update_subtask').patch).toEqual({ dueOn: null, assigneeIds: [] })
  })

  it('keeps start date, notes and attachments local', () => {
    const r = diffTask(
      localSubtask({
        startsOn: '2026-11-01',
        notesHtml: '<div>ملاحظة</div>',
        attachments: [{ id: 'a', filename: 'x.pdf', bcSgid: null, origin: 'local' }],
      }),
      subBase0,
      sub0,
      subtaskCtx(),
    )
    expect(r.outbound).toEqual([])
    expect(r.inbound).toEqual([])
  })

  it('a partial update needs no fetched record', () => {
    const r = diffTask(localSubtask({ dueOn: '2026-11-25' }), subBase0, null, subtaskCtx())
    expect(r.outbound).toEqual([{ type: 'update_subtask', uid: 'uid-sub', subtaskId: SUBTASK_ID, patch: { dueOn: '2026-11-25' } }])
  })

  it('completion and order go to their own endpoints', () => {
    const r = diffTask(localSubtask({ completed: true, position: 2 }), subBase0, sub0, subtaskCtx())
    expect(r.outbound).toEqual([
      { type: 'set_completion', uid: 'uid-sub', bcType: 'subtask', bcId: SUBTASK_ID, completed: true },
      { type: 'reposition', uid: 'uid-sub', bcType: 'subtask', bcId: SUBTASK_ID, position: 2 },
    ])
  })
})

describe('diffTask — inbound', () => {
  it('a Basecamp assignment change keeps externals and the follower role', () => {
    const local = localTodo({ assignees: [external(SARA), follower(FAHAD), person(AHMED)] })
    const base = baseFromRemote('uid-todo', remoteTodo({ assigneeIds: [AHMED, FAHAD] }))
    const r = diffTask(local, base, remoteTodo({ assigneeIds: [FAHAD, JUMANA], updatedAt: T2 }), todoCtx())
    expect(r.inbound).toEqual([
      { type: 'update_row', uid: 'uid-todo', fields: { assignees: [external(SARA), follower(FAHAD), person(JUMANA)] } },
    ])
  })

  it('warns when Basecamp removes the only internal follower of an external assignee', () => {
    const local = localSubtask({ assignees: [external(SARA), follower(FAHAD)] })
    const base = baseFromRemote('uid-sub', remoteSubtask({ assigneeIds: [FAHAD] }))
    const r = diffTask(local, base, remoteSubtask({ assigneeIds: [], updatedAt: T2 }), subtaskCtx())
    expect(r.inbound).toEqual([{ type: 'update_row', uid: 'uid-sub', fields: { assignees: [external(SARA)] } }])
    expect(r.warnings.map((w) => w.code)).toEqual(['follower_removed_remotely'])
  })

  it('a description edited in Basecamp updates the notes; a later write keeps Basecamp’s bytes', () => {
    const edited = '<div>نص عدّله شخص في Basecamp</div>'
    const remote = remoteTodo({ descriptionHtml: edited, updatedAt: T2 })
    const r = diffTask(localTodo({ dueOn: '2027-01-01' }), base0, remote, todoCtx())
    expect(r.inbound).toEqual([{ type: 'update_row', uid: 'uid-todo', fields: { notesHtml: edited } }])
    expect(only(r.outbound, 'update_todo').write.descriptionHtml).toBe(edited)
  })

  it('a notes cell that lost its stored description (files gone from the local notes) sends nothing and drops no file (Q2)', () => {
    const r = diffTask(localTodo({ notesHtml: '<div>خطة النشر للربع الرابع، راجعوا المرفق.</div>' }), base0, remote0, todoCtx())
    expect(r).toMatchObject({ outbound: [], inbound: [], conflicts: [] })
  })

  it('a plain value pasted over the notes keeps the files in the PUT (Q2)', () => {
    const r = diffTask(localTodo({ notesHtml: '<div>نص جديد</div>' }), base0, remote0, todoCtx())
    const write = only(r.outbound, 'update_todo').write
    expect(write.descriptionHtml).toContain('<div>نص جديد</div>')
    expect(write.descriptionHtml).toContain('sgid="BAh7CEkiCGdpZAY6BkVU"')
  })

  it('a plain value with the title changed also keeps the files, with the record not fetched (Q2)', () => {
    const r = diffTask(localTodo({ title: 'عنوان جديد', notesHtml: null }), base0, null, todoCtx())
    expect(only(r.outbound, 'update_todo').write.descriptionHtml).toContain('sgid="BAh7CEkiCGdpZAY6BkVU"')
  })

  it('whitespace reflowed by Basecamp is not a change', () => {
    const reflowed = HUMAN_NOTES.replace('</div><div>', '</div>\n  <div>')
    const r = diffTask(localTodo(), base0, remoteTodo({ descriptionHtml: reflowed, updatedAt: T2 }), todoCtx())
    expect(r).toMatchObject({ outbound: [], inbound: [], conflicts: [] })
  })

  it('archived, trashed or deleted marks the row and keeps it (§9.3.10)', () => {
    expect(diffTask(localTodo(), base0, remoteTodo({ status: 'trashed' }), todoCtx()).inbound).toEqual([
      { type: 'mark_deleted_remotely', uid: 'uid-todo', status: 'trashed' },
    ])
    expect(diffTask(localTodo(), base0, remoteTodo({ status: 'archived' }), todoCtx()).inbound).toEqual([
      { type: 'mark_deleted_remotely', uid: 'uid-todo', status: 'archived' },
    ])
    expect(diffTask(localSubtask(), subBase0, { type: 'deleted' }, subtaskCtx()).inbound).toEqual([
      { type: 'mark_deleted_remotely', uid: 'uid-sub', status: 'deleted' },
    ])
    const local = diffTask(localTodo({ title: 'تعديل' }), base0, remoteTodo({ status: 'trashed' }), todoCtx())
    expect(local.outbound).toEqual([])
  })

  it('marks once, and restores the row when the record is back', () => {
    expect(diffTask(localTodo({ deletedRemotely: true }), base0, remoteTodo({ status: 'trashed' }), todoCtx())).toMatchObject({
      inbound: [],
      outbound: [],
    })
    const back = diffTask(localTodo({ deletedRemotely: true }), base0, remoteTodo({ content: 'مستعاد', updatedAt: T2 }), todoCtx())
    expect(back.inbound).toEqual([
      { type: 'restore_row', uid: 'uid-todo' },
      { type: 'update_row', uid: 'uid-todo', fields: { title: 'مستعاد' } },
    ])
  })

  it('creates rows for records made in Basecamp, linked to them', () => {
    const todo = remoteTodo({ assigneeIds: [], descriptionHtml: `<div>أ</div><hr><div><strong>${MANAGED_BLOCK_TITLE}</strong><br>س</div>` })
    const row = inboundCreateRow(todo, { uid: 'new-1', sheetId: 'sheet-1', parentUid: null })
    expect(row.type === 'create_row' && row.task).toMatchObject({
      uid: 'new-1',
      level: 0,
      notesHtml: '<div>أ</div>',
      assignMode: 'auto',
      assignees: [],
      bcId: TODO_ID,
      deletedRemotely: false,
    })
    const sub = inboundCreateRow(remoteSubtask({ assigneeIds: [BADR, BADR] }), { uid: 'new-2', sheetId: 'sheet-1', parentUid: 'new-1' })
    expect(sub.type === 'create_row' && sub.task).toMatchObject({
      level: 1,
      parentUid: 'new-1',
      assignees: [person(BADR)],
      startsOn: null,
      bcId: SUBTASK_ID,
      deletedRemotely: false,
    })
    expect(() => inboundCreateRow(remoteSubtask(), { uid: 'x', sheetId: 's', parentUid: null })).toThrow()
  })

  it('a new row from a record without a position goes where the caller places it', () => {
    const placed = inboundCreateRow(remoteTodo({ position: null }), { uid: 'new-1', sheetId: 'sheet-1', parentUid: null, position: 6 })
    expect(placed.type === 'create_row' && placed.task.position).toBe(6)
    const own = inboundCreateRow(remoteTodo({ position: 2 }), { uid: 'new-1', sheetId: 'sheet-1', parentUid: null, position: 6 })
    expect(own.type === 'create_row' && own.task.position).toBe(2)
    expect(() => inboundCreateRow(remoteSubtask({ position: null }), { uid: 'x', sheetId: 's', parentUid: 'p' })).toThrow(/position/)
  })
})

describe('diffTask — guarded cases', () => {
  it('a row whose level or parent no longer matches Basecamp is not synced', () => {
    const r = diffTask(localSubtask({ uid: 'uid-todo', parentUid: 'p' }), base0, remote0, subtaskCtx())
    expect(r).toMatchObject({ outbound: [], inbound: [] })
    expect(r.warnings.map((w) => w.code)).toEqual(['hierarchy_change_unsupported'])
    const moved = diffTask(localSubtask(), subBase0, sub0, subtaskCtx({ parentTodoId: TODO_ID + 1 }))
    expect(moved.warnings.map((w) => w.code)).toEqual(['hierarchy_change_unsupported'])
  })

  it('an external-only assignment without follower holds every write but still applies inbound', () => {
    const r = diffTask(
      localTodo({ assignees: [external(SARA)], title: 'تعديل' }),
      base0,
      remoteTodo({ dueOn: '2027-02-02', updatedAt: T2 }),
      todoCtx(),
    )
    expect(r.outbound).toEqual([])
    expect(r.inbound).toEqual([{ type: 'update_row', uid: 'uid-todo', fields: { dueOn: '2027-02-02' } }])
    expect(r.warnings.map((w) => w.code)).toEqual(['invalid_local_assignees'])
  })

  it('never writes a block with names the directory lacks', () => {
    const block = `<hr><div><strong>${MANAGED_BLOCK_TITLE}</strong><br>مسؤولون خارجيون: قديم</div>`
    const remote = remoteTodo({ descriptionHtml: HUMAN_NOTES + block })
    const base = baseFromRemote('uid-todo', remote)
    const r = diffTask(
      localTodo({ assignees: [person(AHMED), external('ext-unknown')], title: 'جديد' }),
      base,
      remote,
      { ...todoCtx(), directory: { ...directory, externalContacts: new Map() } },
    )
    expect(splitDescription(only(r.outbound, 'update_todo').write.descriptionHtml).block).toBe(block)
    expect(r.warnings.map((w) => w.code)).toEqual(['directory_incomplete'])
  })
})
