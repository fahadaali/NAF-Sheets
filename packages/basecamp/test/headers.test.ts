// Spec §9.2.10 / Appendix A-1: User-Agent on every request, Bearer token on
// every request, JSON Content-Type on every POST/PUT.

import type { RemoteSubtask, TodoWrite } from '@naf-sheets/shared'
import { describe, expect, it } from 'vitest'
import { createBasecampClient, DEFAULT_USER_AGENT, NAF_WEBHOOK_TYPES, type BasecampClientOptions } from '../src/client'
import { ACCOUNT, BASE, type Call, countingLimiter, makeClient, rawSubtask, rawTodo, type Reply, reply, TOKEN } from './helpers'

const write: TodoWrite = {
  content: 'Task',
  descriptionHtml: '',
  assigneeIds: [],
  completionSubscriberIds: [],
  dueOn: null,
  startsOn: null,
  notify: false,
}

/** Answers every endpoint with a plausible body, so every call can be exercised. */
function router(call: Call): Reply {
  const p = call.path.split('?')[0] ?? ''
  if (call.method === 'DELETE' || /\/(completion|position)\.json$/.test(p) || /\/status\/\w+\.json$/.test(p)) return reply(204)
  if (p === '/attachments.json') return reply(201, { attachable_sgid: 'sgid-1' })
  if (p === '/account/enrollments/people.json') return reply(201, [{ id: 1, name: 'A', status: 'created' }])
  if (/\/people\/(users|client_users)\.json$/.test(p)) return reply(200, { granted: [], revoked: [] })
  if (/^\/todos\/\d+\.json$/.test(p) || /\/todolists\/\d+\/todos\.json$/.test(p)) {
    return call.method === 'GET' && p.endsWith('/todos.json') ? reply(200, [rawTodo(1)]) : reply(200, rawTodo(1))
  }
  if (/^\/subtasks\/\d+\.json$/.test(p) || /\/subtasks\.json$/.test(p)) {
    return call.method === 'GET' && p.endsWith('/subtasks.json') ? reply(200, [rawSubtask(1)]) : reply(200, rawSubtask(1))
  }
  if (call.method === 'GET' && /(webhooks|people|comments|todolists|projects)\.json$/.test(p)) return reply(200, [])
  return reply(200, { id: 1, dock: [] })
}

describe('mandatory headers', () => {
  it('sends User-Agent and the bearer token on a GET, without Content-Type', async () => {
    const { client, calls } = makeClient(reply(200, rawTodo(2)))
    await client.todos.get(TOKEN, 2)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${BASE}/todos/2.json`)
    expect(calls[0]?.headers).toEqual({ 'User-Agent': 'NAF Comms (info@naflaw.sa)', Authorization: `Bearer ${TOKEN}` })
  })

  it('sends the JSON Content-Type on every POST and PUT, with or without a body', async () => {
    const { client, calls } = makeClient(router)
    await client.todos.complete(TOKEN, 1) // POST, no body
    await client.recordings.trash(TOKEN, 1) // PUT, no body
    await client.todos.update(TOKEN, 1, write) // PUT, body
    await client.todos.create(TOKEN, 3, write) // POST, body
    for (const call of calls) {
      expect(call.headers['Content-Type']).toBe('application/json; charset=utf-8')
      expect(call.headers['User-Agent']).toBe(DEFAULT_USER_AGENT)
    }
    expect(calls[0]?.rawBody).toBeUndefined()
    expect(calls[1]?.rawBody).toBeUndefined()
  })

  it('sends no Content-Type on DELETE', async () => {
    const { client, calls } = makeClient(reply(204))
    await client.todos.uncomplete(TOKEN, 1)
    expect(calls[0]?.method).toBe('DELETE')
    expect(calls[0]?.headers['Content-Type']).toBeUndefined()
    expect(calls[0]?.headers['Authorization']).toBe(`Bearer ${TOKEN}`)
  })

  it('carries User-Agent and Authorization on every request of every endpoint', async () => {
    const { client, calls } = makeClient(router)
    const snapshot: RemoteSubtask = { type: 'subtask', id: 4, todoId: 1, position: 1, title: 's', assigneeIds: [], dueOn: null, completed: false, updatedAt: '' }
    await client.projects.list(TOKEN).all()
    await client.projects.get(TOKEN, 1)
    await client.projects.create(TOKEN, { name: 'P' })
    await client.todolists.list(TOKEN, 1).all()
    await client.todolists.get(TOKEN, 1)
    await client.todolists.create(TOKEN, 1, { name: 'L' })
    await client.todos.list(TOKEN, 1).all()
    await client.todos.get(TOKEN, 1)
    await client.todos.getRaw(TOKEN, 1)
    await client.todos.create(TOKEN, 1, write)
    await client.todos.update(TOKEN, 1, write)
    await client.todos.complete(TOKEN, 1)
    await client.todos.uncomplete(TOKEN, 1)
    await client.todos.reposition(TOKEN, 1, 1)
    await client.todos.trash(TOKEN, 1)
    await client.todos.untrash(TOKEN, 1)
    await client.recordings.archive(TOKEN, 1)
    await client.recordings.restore(TOKEN, 1)
    await client.subtasks.list(TOKEN, 1).all()
    await client.subtasks.get(TOKEN, 1)
    await client.subtasks.create(TOKEN, 1, { title: 's', dueOn: null, assigneeIds: [] })
    await client.subtasks.update(TOKEN, 1, { title: 's' })
    await client.subtasks.complete(TOKEN, 1)
    await client.subtasks.uncomplete(TOKEN, 1)
    await client.subtasks.reposition(TOKEN, 1, 1)
    await client.subtasks.deletePermanently(TOKEN, 4, snapshot)
    await client.webhooks.list(TOKEN, 1).all()
    await client.webhooks.create(TOKEN, 1, { payloadUrl: 'https://x.example/h', types: NAF_WEBHOOK_TYPES })
    await client.webhooks.get(TOKEN, 1)
    await client.webhooks.update(TOKEN, 1, { payloadUrl: 'https://x.example/h', types: ['Todo'], active: true })
    await client.webhooks.delete(TOKEN, 1)
    await client.people.listProject(TOKEN, 1).all()
    await client.people.listAll(TOKEN).all()
    await client.people.me(TOKEN)
    await client.people.updateProjectAccess(TOKEN, 1, { grant: [2] })
    await client.people.enroll(TOKEN, { people: [{ name: 'A', emailAddress: 'a@example.com' }] })
    await client.people.updateClientUsers(TOKEN, 1, { revoke: [2] })
    await client.comments.list(TOKEN, 1).all()
    await client.comments.create(TOKEN, 1, '<div>hi</div>')
    await client.attachments.upload(TOKEN, { name: 'a.txt', contentType: 'text/plain', data: new Uint8Array([1]) })
    await client.http.get(TOKEN, '/projects/1.json')
    expect(calls).toHaveLength(41)
    for (const call of calls) {
      expect(call.url.startsWith(`${BASE}/`), call.url).toBe(true)
      expect(call.headers['User-Agent'], call.path).toBe('NAF Comms (info@naflaw.sa)')
      expect(call.headers['Authorization'], call.path).toBe(`Bearer ${TOKEN}`)
      expect(call.redirect, call.path).toBe('manual')
      if (call.method === 'POST' || call.method === 'PUT') {
        const expected = call.path.startsWith('/attachments.json') ? 'text/plain' : 'application/json; charset=utf-8'
        expect(call.headers['Content-Type'], call.path).toBe(expected)
      }
    }
  })

  it('uses a custom User-Agent when given', async () => {
    const { client, calls } = makeClient(reply(200, rawTodo(1)), { userAgent: 'Other App (ops@example.com)' })
    await client.todos.get(TOKEN, 1)
    expect(calls[0]?.headers['User-Agent']).toBe('Other App (ops@example.com)')
  })

  it('uses the token passed to each call (no ambient token)', async () => {
    const { client, calls } = makeClient(reply(200, rawTodo(1)))
    await client.todos.get('user-a-token', 1)
    await client.todos.get('user-b-token', 1)
    expect(calls.map((c) => c.headers['Authorization'])).toEqual(['Bearer user-a-token', 'Bearer user-b-token'])
  })

  it('refuses a missing or malformed token before any request, without echoing it', async () => {
    const { client, calls } = makeClient(reply(200, rawTodo(1)))
    await expect(client.todos.get('', 1)).rejects.toThrow(TypeError)
    const bad = 'abc def\r\nX-Injected: 1'
    const err = await client.todos.get(bad, 1).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TypeError)
    expect(String((err as Error).message)).not.toContain('abc')
    expect(() => client.todos.list('', 1)).toThrow(TypeError)
    expect(calls).toHaveLength(0)
  })

  it('validates construction options', () => {
    const base = { fetch: async () => ({ status: 200, headers: { get: () => null }, text: async () => '' }), limiter: countingLimiter() }
    expect(() => createBasecampClient({ ...base, accountId: 'abc' })).toThrow(TypeError)
    expect(() => createBasecampClient({ ...base, accountId: '12/../9' })).toThrow(TypeError)
    expect(() => createBasecampClient({ ...base, accountId: ACCOUNT, userAgent: ' ' })).toThrow(TypeError)
    expect(createBasecampClient({ ...base, accountId: String(ACCOUNT) }).baseUrl).toBe(BASE)
  })

  it('rejects ids that are not positive integers (no path injection)', async () => {
    const { client, calls } = makeClient(reply(200, rawTodo(1)))
    await expect(client.todos.get(TOKEN, 0)).rejects.toThrow(TypeError)
    await expect(client.todos.get(TOKEN, 1.5)).rejects.toThrow(TypeError)
    await expect(client.todos.get(TOKEN, Number('1/../2'))).rejects.toThrow(TypeError)
    expect(calls).toHaveLength(0)
  })

  it('accepts the platform fetch as its fetch (type-level)', () => {
    // Compiles only if the global `fetch` satisfies FetchLike.
    const options: BasecampClientOptions = { accountId: ACCOUNT, fetch: globalThis.fetch, limiter: countingLimiter() }
    expect(typeof options.fetch).toBe('function')
  })
})
