// Subtasks (subtasks.md; spec §9.2.4, §9.2.7, Appendix A-5).

import type { RemoteSubtask } from '@naf-sheets/shared'
import { describe, expect, it } from 'vitest'
import { subtaskPatchBody } from '../src/client'
import { makeClient, rawSubtask, reply, TOKEN } from './helpers'

describe('PUT /subtasks/{id}.json is partial: only the given fields are sent', () => {
  it('sends only the title when only the title changed', async () => {
    const { client, calls } = makeClient(reply(200, rawSubtask(9, { title: 'New' })))
    const s = await client.subtasks.update(TOKEN, 9, { title: 'New' })
    expect(calls[0]?.method).toBe('PUT')
    expect(calls[0]?.path).toBe('/subtasks/9.json')
    expect(calls[0]?.json).toEqual({ title: 'New' })
    expect(s).toMatchObject({ type: 'subtask', id: 9, title: 'New' })
  })

  it('clears the due date with "due_on": null', async () => {
    const { client, calls } = makeClient(reply(200, rawSubtask(9)))
    await client.subtasks.update(TOKEN, 9, { dueOn: null })
    expect(calls[0]?.json).toEqual({ due_on: null })
    expect(calls[0]?.rawBody).toBe('{"due_on":null}')
  })

  it('removes every assignee with "assignee_ids": []', async () => {
    const { client, calls } = makeClient(reply(200, rawSubtask(9)))
    await client.subtasks.update(TOKEN, 9, { assigneeIds: [] })
    expect(calls[0]?.rawBody).toBe('{"assignee_ids":[]}')
  })

  it('sends exactly the provided combination', async () => {
    const { client, calls } = makeClient(reply(200, rawSubtask(9)))
    await client.subtasks.update(TOKEN, 9, { dueOn: '2026-12-05', assigneeIds: [3, 4] })
    expect(calls[0]?.json).toEqual({ due_on: '2026-12-05', assignee_ids: [3, 4] })
  })

  it('treats an undefined key as "leave unchanged"', () => {
    expect(subtaskPatchBody({ title: 'x', dueOn: undefined })).toEqual({ title: 'x' })
  })

  it('refuses an empty patch, fields subtasks do not have, and a blank title', async () => {
    const { client, calls } = makeClient(reply(200, rawSubtask(9)))
    await expect(client.subtasks.update(TOKEN, 9, {})).rejects.toThrow(/empty subtask patch/)
    await expect(client.subtasks.update(TOKEN, 9, { startsOn: '2026-01-01' } as never)).rejects.toThrow(/startsOn/)
    await expect(client.subtasks.update(TOKEN, 9, { title: '' })).rejects.toThrow(/blank/)
    await expect(client.subtasks.update(TOKEN, 9, { dueOn: '2026-1-1' })).rejects.toThrow(/dueOn/)
    expect(calls).toHaveLength(0)
  })
})

describe('create, list, get', () => {
  it('creates under the to-do with title and assignees; a null due date is omitted', async () => {
    const { client, calls } = makeClient(reply(201, rawSubtask(10)))
    await client.subtasks.create(TOKEN, 500, { title: 'Book the room', dueOn: null, assigneeIds: [1] })
    await client.subtasks.create(TOKEN, 500, { title: 'Call', dueOn: '2026-12-01', assigneeIds: [] })
    expect(calls.map((c) => [c.method, c.path, c.json])).toEqual([
      ['POST', '/recordings/500/subtasks.json', { title: 'Book the room', assignee_ids: [1] }],
      ['POST', '/recordings/500/subtasks.json', { title: 'Call', assignee_ids: [], due_on: '2026-12-01' }],
    ])
  })

  it('lists a to-do\'s subtasks by recording id, normalised, in the order received', async () => {
    const { client, calls } = makeClient(reply(200, [rawSubtask(1, { position: 1 }), rawSubtask(2, { position: 2 })]))
    const all = await client.subtasks.list(TOKEN, 500).all()
    expect(calls[0]?.path).toBe('/recordings/500/subtasks.json')
    expect(all.map((s) => [s.id, s.position, s.todoId])).toEqual([
      [1, 1, 500],
      [2, 2, 500],
    ])
  })

  it('gets one subtask', async () => {
    const { client, calls } = makeClient(reply(200, rawSubtask(7)))
    expect((await client.subtasks.get(TOKEN, 7)).id).toBe(7)
    expect(calls[0]?.path).toBe('/subtasks/7.json')
  })
})

describe('completion, position, permanent delete', () => {
  it('completes and uncompletes through the completion endpoint', async () => {
    const { client, calls } = makeClient(reply(204))
    await client.subtasks.complete(TOKEN, 7)
    await client.subtasks.uncomplete(TOKEN, 7)
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /subtasks/7/completion.json', 'DELETE /subtasks/7/completion.json'])
  })

  it('repositions with a 1-based position', async () => {
    const { client, calls } = makeClient(reply(204))
    await client.subtasks.reposition(TOKEN, 7, 4)
    expect(calls[0]?.json).toEqual({ position: 4 })
    expect(calls[0]?.path).toBe('/subtasks/7/position.json')
    await expect(client.subtasks.reposition(TOKEN, 7, 0)).rejects.toThrow(/1-based/)
  })

  it('deletes permanently only with a snapshot of that same subtask', async () => {
    const { client, calls } = makeClient(reply(204))
    const snapshot: RemoteSubtask = { type: 'subtask', id: 7, todoId: 500, position: 2, title: 'x', assigneeIds: [3], dueOn: null, completed: false, updatedAt: '2026-11-01T10:00:00Z' }
    await expect(client.subtasks.deletePermanently(TOKEN, 7, { ...snapshot, id: 8 })).rejects.toThrow(/snapshot/)
    await expect(client.subtasks.deletePermanently(TOKEN, 7, undefined as unknown as RemoteSubtask)).rejects.toThrow(/snapshot/)
    expect(calls).toHaveLength(0)
    await client.subtasks.deletePermanently(TOKEN, 7, snapshot)
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /subtasks/7.json'])
    expect(calls[0]?.rawBody).toBeUndefined()
  })
})
