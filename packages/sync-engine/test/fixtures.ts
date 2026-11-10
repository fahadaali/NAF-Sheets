// Test builders. Ids are arbitrary but fixed; timestamps are passed in, never read from a clock.

import type { Assignee, AssigneeSource, ExternalContact, LocalTask, RemoteSubtask, RemoteTodo } from '@naf-sheets/shared'
import type { DiffContext } from '../src/diff'
import type { Directory } from '../src/managed-block'

// Basecamp people
export const AHMED = 101
export const BADR = 102
export const JUMANA = 103
export const DANA = 104
export const FAHAD = 105

// External contacts
export const SARA = 'ext-sara'
export const KHALID = 'ext-khalid'

export const LIST = 900
export const OTHER_LIST = 901
export const TODO_ID = 7001
export const SUBTASK_ID = 8001

export const T0 = '2026-11-10T08:00:00.000Z'
export const T1 = '2026-11-10T09:00:00.000Z'
export const T2 = '2026-11-10T10:00:00.000Z'
export const T3 = '2026-11-10T11:00:00.000Z'

export function person(id: number, source: AssigneeSource = 'manual'): Assignee {
  return { kind: 'bc_person', bcPersonId: id, source }
}

export function follower(id: number, source: AssigneeSource = 'manual'): Assignee {
  return { kind: 'follower', bcPersonId: id, source }
}

export function external(id: string, source: AssigneeSource = 'manual', notifyEmail = true): Assignee {
  return { kind: 'external', externalContactId: id, source, notifyEmail }
}

const contacts: ExternalContact[] = [
  { id: SARA, name: 'سارة المطيري', organization: 'وكالة الإعلام', email: 'sara@example.com', phone: null },
  { id: KHALID, name: 'خالد', organization: null, email: null, phone: null },
]

export const directory: Directory = {
  externalContacts: new Map(contacts.map((c) => [c.id, c])),
  personNames: new Map([
    [AHMED, 'أحمد'],
    [BADR, 'بدر'],
    [JUMANA, 'جمانة'],
    [DANA, 'دانة'],
    [FAHAD, 'فهد'],
  ]),
}

/** A human description with an attachment, as Basecamp stores rich text. */
export const HUMAN_NOTES =
  '<div>خطة النشر للربع الرابع، راجعوا المرفق.</div><div><bc-attachment sgid="BAh7CEkiCGdpZAY6BkVU" content-type="application/pdf" filename="plan.pdf"></bc-attachment></div>'

export function localTodo(overrides: Partial<LocalTask> = {}): LocalTask {
  return {
    uid: 'uid-todo',
    sheetId: 'sheet-1',
    parentUid: null,
    level: 0,
    position: 1,
    title: 'إطلاق الحملة',
    assignees: [person(AHMED)],
    dueOn: '2026-12-01',
    startsOn: '2026-11-15',
    completed: false,
    notesHtml: HUMAN_NOTES,
    freeColumnsForDescription: {},
    attachments: [],
    assignMode: 'manual',
    localChangedAt: T1,
    bcId: null,
    deletedRemotely: false,
    ...overrides,
  }
}

export function localSubtask(overrides: Partial<LocalTask> = {}): LocalTask {
  return {
    uid: 'uid-sub',
    sheetId: 'sheet-1',
    parentUid: 'uid-todo',
    level: 1,
    position: 1,
    title: 'تصميم الإعلان',
    assignees: [person(BADR)],
    dueOn: '2026-11-20',
    startsOn: null,
    completed: false,
    notesHtml: null,
    freeColumnsForDescription: {},
    attachments: [],
    assignMode: 'auto',
    localChangedAt: T1,
    bcId: null,
    deletedRemotely: false,
    ...overrides,
  }
}

export function remoteTodo(overrides: Partial<RemoteTodo> = {}): RemoteTodo {
  return {
    type: 'todo',
    id: TODO_ID,
    listId: LIST,
    bucketId: 1,
    position: 1,
    content: 'إطلاق الحملة',
    descriptionHtml: HUMAN_NOTES,
    assigneeIds: [AHMED],
    completionSubscriberIds: [DANA],
    dueOn: '2026-12-01',
    startsOn: '2026-11-15',
    completed: false,
    status: 'active',
    updatedAt: T0,
    subtasksCount: 0,
    subtasksCompletedCount: 0,
    creatorId: AHMED,
    ...overrides,
  }
}

export function remoteSubtask(overrides: Partial<RemoteSubtask> = {}): RemoteSubtask {
  return {
    type: 'subtask',
    id: SUBTASK_ID,
    todoId: TODO_ID,
    position: 1,
    title: 'تصميم الإعلان',
    assigneeIds: [BADR],
    dueOn: '2026-11-20',
    completed: false,
    updatedAt: T0,
    ...overrides,
  }
}

export function todoCtx(overrides: Partial<DiffContext> = {}): DiffContext {
  return { directory, listId: LIST, ...overrides }
}

export function subtaskCtx(overrides: Partial<DiffContext> = {}): DiffContext {
  return { directory, parentTodoId: TODO_ID, ...overrides }
}

/** All HTML tag names used in a fragment. */
export function tagNames(html: string): string[] {
  return [...new Set([...html.matchAll(/<\/?([a-z][a-z0-9-]*)/gi)].map((m) => (m[1] ?? '').toLowerCase()))].sort()
}
