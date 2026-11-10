// Retries (spec §9.2.9, Appendix A-1; bc-api README "Handling errors"):
// 429 waits Retry-After; 500/502/503/504 back off exponentially, at most 5
// attempts; 404 is never retried; nothing else is retried.

import type { TodoWrite } from '@naf-sheets/shared'
import { describe, expect, it } from 'vitest'
import {
  AccountInactiveError,
  LimitReachedError,
  NetworkError,
  NotFoundError,
  RateLimitedError,
  ServerError,
} from '../src/errors'
import { parseRetryAfter } from '../src/http'
import { makeClient, rawTodo, reply, TOKEN } from './helpers'

const write: TodoWrite = { content: 'T', descriptionHtml: '', assigneeIds: [1], completionSubscriberIds: [], dueOn: null, startsOn: null, notify: false }

describe('429 Too Many Requests', () => {
  it('waits Retry-After seconds, then retries the same request', async () => {
    const { client, calls, clock, limiter } = makeClient([reply(429, undefined, { 'Retry-After': '3' }), reply(200, rawTodo(5))])
    const todo = await client.todos.update(TOKEN, 5, write)
    expect(todo.id).toBe(5)
    expect(clock.sleeps).toEqual([3000])
    expect(calls).toHaveLength(2)
    expect(calls[1]?.rawBody).toBe(calls[0]?.rawBody)
    expect(calls[1]?.headers).toEqual(calls[0]?.headers)
    // Every caller sharing the limiter is held for the same time.
    expect(limiter.pauses).toEqual([3000])
    expect(limiter.acquired).toBe(2)
  })

  it('accepts Retry-After as an HTTP date', async () => {
    const { client, clock } = makeClient((_call, i) =>
      i === 0 ? reply(429, undefined, { 'Retry-After': new Date(clock.now() + 7000).toUTCString() }) : reply(200, rawTodo(5)),
    )
    await client.todos.get(TOKEN, 5)
    expect(clock.sleeps).toEqual([7000])
    expect(parseRetryAfter('0', 0)).toBe(0)
    expect(parseRetryAfter(new Date(0).toUTCString(), 5000)).toBe(0)
    expect(parseRetryAfter('soon', 0)).toBeNull()
    expect(parseRetryAfter(null, 0)).toBeNull()
  })

  it('falls back to exponential backoff when Retry-After is missing', async () => {
    const { client, clock } = makeClient([reply(429), reply(429), reply(200, rawTodo(5))])
    await client.todos.get(TOKEN, 5)
    expect(clock.sleeps).toEqual([1000, 2000])
  })

  it('does not sleep in-process for a Retry-After longer than the limit; throws it for the queue', async () => {
    const { client, calls, clock } = makeClient([reply(429, { error: 'slow down' }, { 'Retry-After': '120' })])
    const err = await client.todos.get(TOKEN, 5).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitedError)
    expect(err).toMatchObject({ code: 'rate_limited', status: 429, retryAfterMs: 120_000, retryable: true, attempts: 1 })
    expect(clock.sleeps).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('gives up after the 429 attempt cap', async () => {
    const { client, calls, clock } = makeClient(reply(429, undefined, { 'Retry-After': '1' }))
    const err = await client.todos.get(TOKEN, 5).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitedError)
    expect(calls).toHaveLength(5)
    expect(clock.sleeps).toEqual([1000, 1000, 1000, 1000])
  })

  it('on the client-users endpoint, a 429 without Retry-After is the account user limit: not retried', async () => {
    const { client, calls, clock } = makeClient([reply(429, { errors: [] })])
    const err = await client.people.updateClientUsers(TOKEN, 1, { create: [{ emailAddress: 'c@example.com' }] }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LimitReachedError)
    expect(calls).toHaveLength(1)
    expect(clock.sleeps).toEqual([])
  })

  it('on the client-users endpoint, a 429 with Retry-After is still a rate limit', async () => {
    const { client, calls } = makeClient([reply(429, undefined, { 'Retry-After': '2' }), reply(200, { granted: [], revoked: [] })])
    await client.people.updateClientUsers(TOKEN, 1, { revoke: [2] })
    expect(calls).toHaveLength(2)
  })
})

describe('5xx', () => {
  it('retries 503 with backoff and succeeds', async () => {
    const { client, calls, clock } = makeClient([reply(503), reply(200, rawTodo(5))])
    await client.todos.get(TOKEN, 5)
    expect(calls).toHaveLength(2)
    expect(clock.sleeps).toEqual([1000])
  })

  it('retries 500, 502 and 504', async () => {
    const { client, calls, clock } = makeClient([reply(500), reply(502), reply(504), reply(200, rawTodo(5))])
    await client.todos.get(TOKEN, 5)
    expect(calls).toHaveLength(4)
    expect(clock.sleeps).toEqual([1000, 2000, 4000])
  })

  it('makes at most 5 attempts, doubling the wait, then throws a retryable ServerError', async () => {
    const { client, calls, clock, limiter } = makeClient(reply(500, { error: 'boom' }))
    const err = await client.todos.update(TOKEN, 5, write).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ServerError)
    expect(err).toMatchObject({ code: 'server_error', status: 500, attempts: 5, retryable: true, method: 'PUT', path: '/todos/5.json', details: { error: 'boom' } })
    expect(calls).toHaveLength(5)
    expect(clock.sleeps).toEqual([1000, 2000, 4000, 8000])
    expect(limiter.acquired).toBe(5)
  })

  it('caps the backoff', async () => {
    const { client, clock } = makeClient(reply(503), { retry: { maxServerErrorAttempts: 4, baseBackoffMs: 10_000, maxBackoffMs: 15_000 } })
    await client.todos.get(TOKEN, 5).catch(() => undefined)
    expect(clock.sleeps).toEqual([10_000, 15_000, 15_000])
  })

  it('does not retry a 5xx the docs do not list as retryable (501)', async () => {
    const { client, calls } = makeClient(reply(501))
    const err = await client.todos.get(TOKEN, 5).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ServerError)
    expect(err).toMatchObject({ retryable: false, attempts: 1 })
    expect(calls).toHaveLength(1)
  })

  it('does not retry 507 (limit reached)', async () => {
    const { client, calls } = makeClient(reply(507, { error: 'The webhook limit for this account has been reached.' }))
    await expect(client.webhooks.create(TOKEN, 1, { payloadUrl: 'https://h.example/x', types: ['Todo'] })).rejects.toBeInstanceOf(LimitReachedError)
    expect(calls).toHaveLength(1)
  })
})

describe('404 and network failures are never retried', () => {
  it('throws NotFoundError after one attempt', async () => {
    const { client, calls, clock } = makeClient(reply(404))
    const err = await client.todos.get(TOKEN, 5).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NotFoundError)
    expect(err).toMatchObject({ code: 'not_found', status: 404, retryable: false, reason: null })
    expect(calls).toHaveLength(1)
    expect(clock.sleeps).toEqual([])
  })

  it('throws the distinct AccountInactiveError for "Reason: Account Inactive"', async () => {
    const { client, calls } = makeClient(reply(404, undefined, { Reason: 'Account Inactive' }))
    const err = await client.todos.get(TOKEN, 5).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AccountInactiveError)
    expect(err).not.toBeInstanceOf(NotFoundError)
    expect(err).toMatchObject({ code: 'account_inactive', status: 404, retryable: false, path: '/todos/5.json' })
    expect(calls).toHaveLength(1)
  })

  it('keeps other Reason values on a plain NotFoundError', async () => {
    const { client } = makeClient(reply(404, undefined, { reason: 'Something Else' }))
    await expect(client.todos.get(TOKEN, 5)).rejects.toMatchObject({ code: 'not_found', reason: 'Something Else' })
  })

  it('wraps a failing fetch in a NetworkError without retrying', async () => {
    const { client, calls } = makeClient(new Error('connect ECONNRESET'))
    const err = await client.todos.get(TOKEN, 5).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NetworkError)
    expect(err).toMatchObject({ code: 'network_error', status: null, retryable: true })
    expect(calls).toHaveLength(1)
  })
})
