// Error mapping (spec §9.2.9, Appendix A; bc-api README "Handling errors").
// Every error carries status, method, path and a machine code, and never the token.

import { describe, expect, it } from 'vitest'
import {
  BadRequestError,
  BasecampError,
  BasecampHttpError,
  ForbiddenError,
  LimitReachedError,
  UnauthorizedError,
  UnexpectedResponseError,
  ValidationError,
} from '../src/errors'
import { NormaliseError } from '../src/normalise'
import { makeClient, rawTodo, reply, TOKEN } from './helpers'

function leaksToken(err: unknown): boolean {
  const e = err as Error & { cause?: unknown }
  const parts = [e.message, e.stack, JSON.stringify(e), String(e), JSON.stringify((e as BasecampError).details ?? null)]
  if (e.cause instanceof Error) parts.push(e.cause.message)
  return parts.some((p) => typeof p === 'string' && p.includes(TOKEN))
}

describe('status → error class', () => {
  it('403 → ForbiddenError, keeping the documented `reason`', async () => {
    const body = { error: "Basecamp doesn't let agents do this.", reason: 'agent_not_permitted' }
    const { client, calls } = makeClient(reply(403, body))
    const err = await client.subtasks.deletePermanently(TOKEN, 7, {
      type: 'subtask', id: 7, todoId: 1, position: 1, title: 't', assigneeIds: [], dueOn: null, completed: false, updatedAt: '',
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ForbiddenError)
    expect(err).toMatchObject({ code: 'forbidden', status: 403, method: 'DELETE', path: '/subtasks/7.json', reason: 'agent_not_permitted', details: body, retryable: false })
    expect(calls).toHaveLength(1)
  })

  it('507 → LimitReachedError', async () => {
    const { client } = makeClient(reply(507, { error: 'The user limit for this account has been reached.' }))
    const err = await client.people.enroll(TOKEN, { people: [{ name: 'A', emailAddress: 'a@example.com' }], projectIds: [1], notify: true }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LimitReachedError)
    expect(err).toMatchObject({ code: 'limit_reached', status: 507, method: 'POST', path: '/account/enrollments/people.json', retryable: false })
  })

  it('422 → ValidationError with the documented error body', async () => {
    const body = { errors: [{ index: 1, messages: ['email_address is invalid'] }] }
    const { client } = makeClient(reply(422, body))
    const err = await client.people.enroll(TOKEN, { people: [{ name: 'A', emailAddress: 'a@example.com' }] }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ValidationError)
    expect(err).toMatchObject({ code: 'validation_failed', status: 422, details: body })
  })

  it('401 → UnauthorizedError (token expired: keep changes pending, spec §3)', async () => {
    const { client } = makeClient(reply(401))
    await expect(client.people.me(TOKEN)).rejects.toMatchObject({ name: 'UnauthorizedError', code: 'unauthorized', status: 401 })
    await expect(client.people.me(TOKEN)).rejects.toBeInstanceOf(UnauthorizedError)
  })

  it('400 → BadRequestError (e.g. a webhook URL Basecamp rejects)', async () => {
    const { client } = makeClient(reply(400, 'Bad Request'))
    const err = await client.webhooks.create(TOKEN, 1, { payloadUrl: 'https://h.example/x', types: ['Todo'] }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BadRequestError)
    expect(err).toMatchObject({ details: 'Bad Request', path: '/buckets/1/webhooks.json' })
  })

  it('an unexpected redirect is an error, never followed', async () => {
    const { client, calls } = makeClient(reply(302, undefined, { Location: 'https://elsewhere.example/' }))
    await expect(client.projects.get(TOKEN, 1)).rejects.toBeInstanceOf(BasecampHttpError)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.redirect).toBe('manual')
  })

  it('a 2xx that is not JSON is an UnexpectedResponseError', async () => {
    const { client } = makeClient(reply(200, '<html>'))
    await expect(client.todos.get(TOKEN, 1)).rejects.toMatchObject({ code: 'unexpected_response', path: '/todos/1.json' })
  })

  it('a body the normaliser rejects is an UnexpectedResponseError with the NormaliseError as cause', async () => {
    const { client } = makeClient(reply(200, rawTodo(1, { completed: 'yes' })))
    const err = await client.todos.get(TOKEN, 1).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UnexpectedResponseError)
    expect((err as Error).cause).toBeInstanceOf(NormaliseError)
    expect((err as Error).message).toContain('completed')
    expect(err).toMatchObject({ method: 'GET', path: '/todos/1.json', status: 200 })
  })

  it('a list item the normaliser rejects names the page it came from', async () => {
    const { client } = makeClient(reply(200, [rawTodo(1), rawTodo(2, { parent: { id: 9, type: 'Todoset' } })]))
    await expect(client.todos.list(TOKEN, 300, { completed: true }).all()).rejects.toMatchObject({
      code: 'unexpected_response',
      path: '/todolists/300/todos.json?completed=true',
    })
  })
})

describe('the token never appears in an error', () => {
  const statuses = [400, 401, 403, 404, 422, 429, 500, 501, 507, 302]
  for (const status of statuses) {
    it(`status ${status}`, async () => {
      const { client } = makeClient(reply(status, { error: 'x' }, status === 404 ? { Reason: 'Account Inactive' } : {}), {
        retry: { maxServerErrorAttempts: 1, maxRateLimitAttempts: 1 },
      })
      const err = await client.todos.get(TOKEN, 5).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(BasecampError)
      expect((err as BasecampError).message).toContain('GET /todos/5.json')
      expect(leaksToken(err)).toBe(false)
    })
  }

  it('network failure', async () => {
    const { client } = makeClient(new Error('socket hang up'))
    const err = await client.todos.get(TOKEN, 5).catch((e: unknown) => e)
    expect(leaksToken(err)).toBe(false)
  })
})
