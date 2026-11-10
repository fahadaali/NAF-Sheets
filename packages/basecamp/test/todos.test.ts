// To-dos (todos.md; spec §9.2.4–§9.2.7, Appendix A-4).

import type { TodoWrite } from '@naf-sheets/shared'
import { describe, expect, it } from 'vitest'
import { todoWriteBody } from '../src/client'
import { makeClient, rawTodo, reply, TOKEN } from './helpers'

const SIX_FIELDS_AND_NOTIFY = ['assignee_ids', 'completion_subscriber_ids', 'content', 'description', 'due_on', 'notify', 'starts_on']

const full: TodoWrite = {
  content: 'Draft the press release',
  descriptionHtml: '<div>Notes</div>',
  assigneeIds: [11, 12],
  completionSubscriberIds: [13],
  dueOn: '2026-12-01',
  startsOn: '2026-11-20',
  notify: true,
}

describe('PUT /todos/{id}.json always sends every field (it clears what is omitted)', () => {
  it('sends all six synced fields plus notify, exactly as given', async () => {
    const { client, calls } = makeClient(reply(200, rawTodo(5)))
    await client.todos.update(TOKEN, 5, full)
    expect(calls[0]?.method).toBe('PUT')
    expect(calls[0]?.path).toBe('/todos/5.json')
    expect(calls[0]?.json).toEqual({
      content: 'Draft the press release',
      description: '<div>Notes</div>',
      assignee_ids: [11, 12],
      completion_subscriber_ids: [13],
      due_on: '2026-12-01',
      starts_on: '2026-11-20',
      notify: true,
    })
  })

  it('sends empty and null values explicitly instead of omitting them', async () => {
    const { client, calls } = makeClient(reply(200, rawTodo(5)))
    await client.todos.update(TOKEN, 5, { content: 'T', descriptionHtml: '', assigneeIds: [], completionSubscriberIds: [], dueOn: null, startsOn: null, notify: false })
    const sent = calls[0]?.json as Record<string, unknown>
    expect(Object.keys(sent).sort()).toEqual(SIX_FIELDS_AND_NOTIFY)
    expect(sent).toEqual({ content: 'T', description: '', assignee_ids: [], completion_subscriber_ids: [], due_on: null, starts_on: null, notify: false })
    // The wire text really carries the nulls (JSON.stringify would drop undefined).
    expect(calls[0]?.rawBody).toContain('"due_on":null')
    expect(calls[0]?.rawBody).toContain('"starts_on":null')
  })

  it('cannot be called with a partial write (type level and run time)', async () => {
    const { client, calls } = makeClient(reply(200, rawTodo(5)))
    // @ts-expect-error a to-do update must carry every field of TodoWrite
    await expect(client.todos.update(TOKEN, 5, { content: 'only the title' })).rejects.toThrow(TypeError)
    // A cast cannot sneak an omission past the run-time check either.
    const missingDue = { ...full, dueOn: undefined } as unknown as TodoWrite
    await expect(client.todos.update(TOKEN, 5, missingDue)).rejects.toThrow(/dueOn/)
    const missingAssignees = { ...full, assigneeIds: undefined } as unknown as TodoWrite
    await expect(client.todos.update(TOKEN, 5, missingAssignees)).rejects.toThrow(/assigneeIds/)
    const missingDescription = { ...full, descriptionHtml: undefined } as unknown as TodoWrite
    await expect(client.todos.update(TOKEN, 5, missingDescription)).rejects.toThrow(/descriptionHtml/)
    const missingNotify = { ...full, notify: undefined } as unknown as TodoWrite
    await expect(client.todos.update(TOKEN, 5, missingNotify)).rejects.toThrow(/notify/)
    expect(calls).toHaveLength(0)
  })

  it('refuses a blank content and malformed dates or ids before sending', async () => {
    const { client, calls } = makeClient(reply(200, rawTodo(5)))
    await expect(client.todos.update(TOKEN, 5, { ...full, content: '  ' })).rejects.toThrow(/content/)
    await expect(client.todos.update(TOKEN, 5, { ...full, dueOn: '01/12/2026' })).rejects.toThrow(/dueOn/)
    await expect(client.todos.update(TOKEN, 5, { ...full, assigneeIds: [0] })).rejects.toThrow(/assigneeIds/)
    expect(calls).toHaveLength(0)
  })

  it('returns the normalised to-do from the response', async () => {
    const { client } = makeClient(reply(200, rawTodo(5, { content: 'Updated', due_on: '2026-12-01', assignees: [{ id: 11, name: 'A' }] })))
    const todo = await client.todos.update(TOKEN, 5, full)
    expect(todo).toMatchObject({ type: 'todo', id: 5, content: 'Updated', dueOn: '2026-12-01', assigneeIds: [11], listId: 300, bucketId: 900 })
  })

  it('todoWriteBody is the same body for create and update', () => {
    expect(Object.keys(todoWriteBody(full)).sort()).toEqual(SIX_FIELDS_AND_NOTIFY)
  })
})

describe('create, read, list', () => {
  it('creates in a to-do list with the full body', async () => {
    const { client, calls } = makeClient(reply(201, rawTodo(8)))
    const todo = await client.todos.create(TOKEN, 300, { ...full, notify: false })
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.path).toBe('/todolists/300/todos.json')
    expect(calls[0]?.json).toEqual(todoWriteBody({ ...full, notify: false }))
    expect(todo.id).toBe(8)
  })

  it('lists pending to-dos by default, completed ones with ?completed=true, archived/trashed with ?status=', async () => {
    const { client, calls } = makeClient(reply(200, [rawTodo(1)]))
    await client.todos.list(TOKEN, 300).all()
    await client.todos.list(TOKEN, 300, { completed: true }).all()
    await client.todos.list(TOKEN, 300, { status: 'archived' }).all()
    await client.todos.list(TOKEN, 300, { status: 'trashed', completed: true }).all()
    await client.todos.list(TOKEN, 300, { completed: false }).all()
    expect(calls.map((c) => c.path)).toEqual([
      '/todolists/300/todos.json',
      '/todolists/300/todos.json?completed=true',
      '/todolists/300/todos.json?status=archived',
      '/todolists/300/todos.json?completed=true&status=trashed',
      '/todolists/300/todos.json',
    ])
    expect(() => client.todos.list(TOKEN, 300, { status: 'deleted' as 'archived' })).toThrow(TypeError)
  })

  it('getRaw keeps the wire shape (attachments, steps)', async () => {
    const { client, calls } = makeClient(reply(200, rawTodo(5, { description_attachments: [{ id: 1, sgid: 's', filename: 'a.pdf' }] })))
    const raw = await client.todos.getRaw(TOKEN, 5)
    expect(calls[0]?.path).toBe('/todos/5.json')
    expect(raw.description_attachments?.[0]?.filename).toBe('a.pdf')
  })
})

describe('completion, position, trash', () => {
  it('completes with POST and uncompletes with DELETE on the completion endpoint', async () => {
    const { client, calls } = makeClient(reply(204))
    await client.todos.complete(TOKEN, 5)
    await client.todos.uncomplete(TOKEN, 5)
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /todos/5/completion.json', 'DELETE /todos/5/completion.json'])
  })

  it('repositions with a 1-based position, optionally into another list', async () => {
    const { client, calls } = makeClient(reply(204))
    await client.todos.reposition(TOKEN, 5, 3)
    await client.todos.reposition(TOKEN, 5, 1, 301)
    expect(calls.map((c) => [c.method, c.path, c.json])).toEqual([
      ['PUT', '/todos/5/position.json', { position: 3 }],
      ['PUT', '/todos/5/position.json', { position: 1, parent_id: 301 }],
    ])
  })

  it('refuses position 0 and non-integer positions', async () => {
    const { client, calls } = makeClient(reply(204))
    await expect(client.todos.reposition(TOKEN, 5, 0)).rejects.toThrow(/1-based/)
    await expect(client.todos.reposition(TOKEN, 5, 1.5)).rejects.toThrow(/1-based/)
    await expect(client.todos.reposition(TOKEN, 5, 1, -2)).rejects.toThrow(TypeError)
    expect(calls).toHaveLength(0)
  })

  it('trashes through the recordings status endpoint (recoverable), and archives/restores the same way', async () => {
    const { client, calls } = makeClient(reply(204))
    await client.todos.trash(TOKEN, 5)
    await client.recordings.archive(TOKEN, 5)
    await client.recordings.restore(TOKEN, 5)
    await client.recordings.trash(TOKEN, 300)
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'PUT /recordings/5/status/trashed.json',
      'PUT /recordings/5/status/archived.json',
      'PUT /recordings/5/status/active.json',
      'PUT /recordings/300/status/trashed.json',
    ])
    expect(calls.every((c) => c.rawBody === undefined)).toBe(true)
  })

  it('untrashes a to-do (the untrash_todo action) with one call to the active status endpoint', async () => {
    const { client, calls } = makeClient(reply(204))
    await expect(client.todos.untrash(TOKEN, 5)).resolves.toBeUndefined()
    expect(calls.map((c) => [c.method, c.path, c.rawBody])).toEqual([['PUT', '/recordings/5/status/active.json', undefined]])
    await expect(client.todos.untrash(TOKEN, 0)).rejects.toThrow(TypeError)
    expect(calls).toHaveLength(1)
  })
})
