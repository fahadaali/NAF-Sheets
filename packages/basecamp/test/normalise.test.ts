// Normalisers on the official examples (fixtures/docs-examples.ts cites the
// doc section of each one).

import type { RemoteSubtask, RemoteTodo } from '@naf-sheets/shared'
import { describe, expect, it } from 'vitest'
import { NormaliseError, normaliseSubtask, normaliseTodo, POSITION_UNKNOWN } from '../src/normalise'
import { getSubtaskExample, getTodoExample, listSubtasksExample, listTodosExample } from './fixtures/docs-examples'
import { rawSubtask, rawTodo } from './helpers'

const first = (v: unknown): unknown => (v as unknown[])[0]

describe('normaliseTodo', () => {
  it('maps todos.md "Get to-dos" (GET /todolists/3/todos.json) example', () => {
    const expected: RemoteTodo = {
      type: 'todo',
      id: 1069480013,
      listId: 1069480012,
      bucketId: 2085958505,
      position: 1,
      content: 'Go cutting edge: iOS8 and Android 4.5 only',
      descriptionHtml: '',
      assigneeIds: [],
      completionSubscriberIds: [],
      dueOn: null,
      startsOn: null,
      completed: false,
      status: 'active',
      updatedAt: '2026-05-12T04:29:00.000Z',
      subtasksCount: 0,
      subtasksCompletedCount: 0,
      creatorId: 1049715938,
    }
    expect(normaliseTodo(first(listTodosExample))).toEqual(expected)
  })

  it('maps todos.md "Get a to-do" (GET /todos/2.json) example, which has no position', () => {
    expect(normaliseTodo(getTodoExample)).toEqual({
      type: 'todo',
      id: 1069480015,
      listId: 1069480012,
      bucketId: 2085958505,
      position: POSITION_UNKNOWN,
      content: 'Clear and simple UI',
      descriptionHtml: '',
      assigneeIds: [1049715930],
      completionSubscriberIds: [1049715930],
      dueOn: null,
      startsOn: null,
      completed: true,
      status: 'active',
      updatedAt: '2026-07-21T01:06:20.117Z',
      subtasksCount: 0,
      subtasksCompletedCount: 0,
      creatorId: 1049715938,
    } satisfies RemoteTodo)
    expect(POSITION_UNKNOWN).toBe(0)
  })

  it('maps dates, several people, subtask counters and trashed status', () => {
    const t = normaliseTodo(
      rawTodo(5, {
        due_on: '2026-12-01',
        starts_on: '2026-11-20',
        description: '<div>x</div><hr>',
        assignees: [{ id: 3, name: 'A', personable_type: 'SomethingNew' }, { id: 4, name: 'B' }],
        completion_subscribers: [{ id: 6, name: 'C' }],
        subtasks_count: 120,
        subtasks_completed_count: 7,
        status: 'trashed',
        position: 4,
      }),
    )
    expect(t).toMatchObject({
      dueOn: '2026-12-01',
      startsOn: '2026-11-20',
      descriptionHtml: '<div>x</div><hr>',
      assigneeIds: [3, 4],
      completionSubscriberIds: [6],
      subtasksCount: 120,
      subtasksCompletedCount: 7,
      status: 'trashed',
      position: 4,
    })
  })

  it('creatorId is null when the creator is missing', () => {
    const raw = rawTodo(5)
    delete raw['creator']
    expect(normaliseTodo(raw).creatorId).toBeNull()
  })

  it('rejects instead of defaulting fields the sync engine depends on', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['completed', { completed: undefined }],
      ['description', { description: null }],
      ['assignees', { assignees: undefined }],
      ['assignees[0].id', { assignees: [{ name: 'no id' }] }],
      ['due_on', { due_on: '01/12/2026' }],
      ['status', { status: 'deleted' }],
      ['subtasks_count', { subtasks_count: -1 }],
      ['parent', { parent: undefined }],
      ['bucket.id', { bucket: { name: 'x' } }],
      ['type', { type: 'Message' }],
      ['position', { position: 0 }],
    ]
    for (const [field, over] of cases) {
      const err = (() => {
        try {
          normaliseTodo(rawTodo(5, over))
        } catch (e) {
          return e
        }
        return null
      })()
      expect(err, field).toBeInstanceOf(NormaliseError)
      expect((err as NormaliseError).field, field).toBe(field)
    }
    const noDue = rawTodo(5)
    delete noDue['due_on']
    expect(() => normaliseTodo(noDue)).toThrow(/due_on is missing/)
    expect(() => normaliseTodo(null)).toThrow(NormaliseError)
    expect(() => normaliseTodo([])).toThrow(NormaliseError)
  })

  it('refuses a loose to-do whose parent is the to-do set (it has no sheet)', () => {
    expect(() => normaliseTodo(rawTodo(5, { parent: { id: 9, type: 'Todoset', title: 'To-dos' } }))).toThrow(/parent\.type/)
  })
})

describe('normaliseSubtask', () => {
  it('maps subtasks.md "Get a recording\'s subtasks" (GET /recordings/3/subtasks.json) example', () => {
    const expected: RemoteSubtask = {
      type: 'subtask',
      id: 1069479877,
      todoId: 1069479876,
      position: 1,
      title: 'Hero shot on the desk',
      assigneeIds: [],
      dueOn: null,
      completed: false,
      updatedAt: '2026-07-02T00:23:00.000Z',
    }
    expect(normaliseSubtask(first(listSubtasksExample))).toEqual(expected)
  })

  it('maps subtasks.md "Get a subtask" (GET /subtasks/2.json) example', () => {
    expect(normaliseSubtask(getSubtaskExample)).toEqual({
      type: 'subtask',
      id: 1069479879,
      todoId: 1069479876,
      position: 3,
      title: 'Outdoors, natural light',
      assigneeIds: [1049715938],
      dueOn: null,
      completed: false,
      updatedAt: '2026-07-02T02:18:00.000Z',
    } satisfies RemoteSubtask)
  })

  it('maps a due date and completion', () => {
    expect(normaliseSubtask(rawSubtask(3, { due_on: '2026-12-05', completed: true }))).toMatchObject({ dueOn: '2026-12-05', completed: true })
  })

  it('refuses a card step (parent is a card, not a to-do) and a non-subtask', () => {
    expect(() => normaliseSubtask(rawSubtask(3, { parent: { id: 1, type: 'Kanban::Card' } }))).toThrow(/parent\.type/)
    expect(() => normaliseSubtask(rawTodo(3))).toThrow(/type/)
    expect(() => normaliseSubtask(rawSubtask(3, { title: 7 }))).toThrow(/title/)
  })
})
