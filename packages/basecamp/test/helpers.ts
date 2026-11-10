// Test doubles: a scripted fake `fetch`, a fake clock and an in-memory cache.

import { createBasecampClient, type BasecampClientOptions } from '../src/client'
import type { CacheEntry, ConditionalCache, FetchInit, FetchLike, FetchResponse } from '../src/http'
import type { RateLimiter } from '../src/limiter'

/** A recognisable token: tests assert it never leaks into errors or cache keys. */
export const TOKEN = 'tok-SECRET-9f8e7d'
export const ACCOUNT = 195539477
export const BASE = `https://3.basecampapi.com/${ACCOUNT}`

export interface Reply {
  status: number
  /** Object/array → JSON text; string → sent as-is; undefined → empty body. */
  body?: unknown
  headers?: Record<string, string>
  /** Raw bytes for `body` of a streamed answer (downloads). */
  bytes?: Uint8Array
}

export interface Call {
  url: string
  /** URL relative to BASE (query included). */
  path: string
  method: string
  headers: Record<string, string>
  rawBody: string | ArrayBuffer | ReadableStream<Uint8Array> | undefined
  /** Parsed JSON body, when the body is a string. */
  json: unknown
  redirect: string
}

export type Responder = (call: Call, index: number) => Reply | Error

export function reply(status: number, body?: unknown, headers?: Record<string, string>): Reply {
  return { status, body, headers }
}

function toResponse(r: Reply): FetchResponse {
  const headers = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
  const text = r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
  const bytes = r.bytes
  return {
    status: r.status,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    text: async () => text,
    body: bytes ? new Response(bytes).body : new Response(text).body,
  }
}

/**
 * A fake `fetch`. Give it a list (served in order; the last one repeats) or
 * a function of the call. An `Error` reply is thrown, like a network failure.
 */
export function fakeFetch(script: Reply | Error | Array<Reply | Error> | Responder) {
  const calls: Call[] = []
  const fetch: FetchLike = async (url: string, init: FetchInit) => {
    const index = calls.length
    const json = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
    const call: Call = {
      url,
      path: url.startsWith(BASE) ? url.slice(BASE.length) : url,
      method: init.method,
      headers: { ...init.headers },
      rawBody: init.body,
      json,
      redirect: init.redirect,
    }
    calls.push(call)
    let r: Reply | Error | undefined
    if (typeof script === 'function') r = script(call, index)
    else if (Array.isArray(script)) r = script[Math.min(index, script.length - 1)]
    else r = script
    if (r === undefined) throw new Error('fake fetch has no reply')
    if (r instanceof Error) throw r
    return toResponse(r)
  }
  return { fetch, calls }
}

export function fakeClock(start = 1_000_000) {
  const clock = {
    t: start,
    sleeps: [] as number[],
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.sleeps.push(ms)
      clock.t += ms
    },
  }
  return clock
}

/** A limiter that never waits but counts what it was asked. */
export function countingLimiter() {
  const limiter = {
    acquired: 0,
    pauses: [] as number[],
    acquire: async () => {
      limiter.acquired += 1
    },
    pauseFor: (ms: number) => {
      limiter.pauses.push(ms)
    },
  }
  return limiter satisfies RateLimiter
}

export function memoryCache() {
  const store = new Map<string, CacheEntry>()
  const cache: ConditionalCache & { store: Map<string, CacheEntry> } = {
    store,
    get: async (key) => store.get(key) ?? null,
    put: async (key, entry) => {
      // Round-trip through JSON, as KV would.
      store.set(key, JSON.parse(JSON.stringify(entry)) as CacheEntry)
    },
  }
  return cache
}

export function makeClient(script: Parameters<typeof fakeFetch>[0], overrides: Partial<BasecampClientOptions> = {}) {
  const { fetch, calls } = fakeFetch(script)
  const clock = fakeClock()
  const limiter = countingLimiter()
  const client = createBasecampClient({
    accountId: ACCOUNT,
    fetch,
    limiter,
    sleep: clock.sleep,
    now: clock.now,
    ...overrides,
  })
  return { client, calls, clock, limiter }
}

/** A complete `RemoteSubtask`-shaped raw subtask, for responses that are not under test. */
export function rawSubtask(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    status: 'active',
    type: 'Kanban::Step',
    created_at: '2026-11-01T10:00:00.000Z',
    updated_at: '2026-11-01T10:00:00.000Z',
    title: 'Subtask',
    position: 1,
    parent: { id: 500, title: 'Parent', type: 'Todo', url: `${BASE}/todos/500.json`, app_url: '' },
    bucket: { id: 900, name: 'Project', type: 'Project' },
    completed: false,
    due_on: null,
    assignees: [],
    url: `${BASE}/subtasks/${id}.json`,
    app_url: '',
    ...over,
  }
}

/** A complete raw to-do. */
export function rawTodo(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    status: 'active',
    type: 'Todo',
    created_at: '2026-11-01T10:00:00.000Z',
    updated_at: '2026-11-01T10:00:00.000Z',
    title: 'Task',
    content: 'Task',
    description: '',
    position: 1,
    parent: { id: 300, title: 'List', type: 'Todolist', url: `${BASE}/todolists/300.json`, app_url: '' },
    bucket: { id: 900, name: 'Project', type: 'Project' },
    creator: { id: 77, name: 'Creator', personable_type: 'User' },
    completed: false,
    starts_on: null,
    due_on: null,
    assignees: [],
    completion_subscribers: [],
    subtasks_count: 0,
    subtasks_completed_count: 0,
    url: `${BASE}/todos/${id}.json`,
    app_url: '',
    ...over,
  }
}
