// Conditional GET (spec §9.4, Appendix A-1; bc-api README "Using HTTP caching").

import { describe, expect, it } from 'vitest'
import { UnexpectedResponseError } from '../src/errors'
import { BASE, makeClient, memoryCache, rawTodo, reply, TOKEN } from './helpers'

describe('ETag / Last-Modified', () => {
  it('stores the ETag, sends If-None-Match next time, and returns the cached list on 304', async () => {
    const cache = memoryCache()
    const { client, calls } = makeClient([reply(200, [rawTodo(1), rawTodo(2)], { ETag: 'W/"abc"' }), reply(304, undefined, { ETag: 'W/"abc"' })], { cache })

    const first = await client.todos.listIfChanged(TOKEN, 300, { cacheScope: 'service' })
    expect(first.notModified).toBe(false)
    expect(first.data.map((t) => t.id)).toEqual([1, 2])
    expect(calls[0]?.headers['If-None-Match']).toBeUndefined()

    const second = await client.todos.listIfChanged(TOKEN, 300, { cacheScope: 'service' })
    expect(calls[1]?.headers['If-None-Match']).toBe('W/"abc"')
    expect(second).toEqual({ notModified: true, data: first.data })
  })

  it('stores Last-Modified and sends If-Modified-Since', async () => {
    const cache = memoryCache()
    const lm = 'Tue, 10 Nov 2026 02:00:00 GMT'
    const { client, calls } = makeClient([reply(200, rawTodo(5), { 'Last-Modified': lm }), reply(304)], { cache })
    const a = await client.http.getIfChanged(TOKEN, '/todos/5.json', 'service')
    const b = await client.http.getIfChanged(TOKEN, '/todos/5.json', 'service')
    expect(a.notModified).toBe(false)
    expect(calls[1]?.headers['If-Modified-Since']).toBe(lm)
    expect(b).toEqual({ notModified: true, data: a.data })
  })

  it('a changed resource (200 after a cached copy) replaces the cache entry', async () => {
    const cache = memoryCache()
    const { client, calls } = makeClient(
      [reply(200, [rawTodo(1)], { ETag: '"v1"' }), reply(200, [rawTodo(1, { content: 'changed' })], { ETag: '"v2"' }), reply(304)],
      { cache },
    )
    await client.todos.listIfChanged(TOKEN, 300, { cacheScope: 'service' })
    const changed = await client.todos.listIfChanged(TOKEN, 300, { cacheScope: 'service' })
    expect(changed.notModified).toBe(false)
    expect(changed.data[0]?.content).toBe('changed')
    const same = await client.todos.listIfChanged(TOKEN, 300, { cacheScope: 'service' })
    expect(calls[2]?.headers['If-None-Match']).toBe('"v2"')
    expect(same.data[0]?.content).toBe('changed')
  })

  it('keeps the completed list and the pending list apart', async () => {
    const cache = memoryCache()
    const { client, calls } = makeClient(reply(200, [], { ETag: '"e"' }), { cache })
    await client.todos.listIfChanged(TOKEN, 300, { cacheScope: 'service' })
    await client.todos.listIfChanged(TOKEN, 300, { cacheScope: 'service', completed: true })
    expect(calls[1]?.path).toBe('/todolists/300/todos.json?completed=true')
    expect(calls[1]?.headers['If-None-Match']).toBeUndefined()
  })

  it('is opt-in per call: a plain list sends no validators even with a cache', async () => {
    const cache = memoryCache()
    const { client, calls } = makeClient(reply(200, [rawTodo(1)], { ETag: '"e"' }), { cache })
    await client.todos.list(TOKEN, 300).all()
    await client.todos.list(TOKEN, 300).all()
    expect(calls.every((c) => c.headers['If-None-Match'] === undefined)).toBe(true)
    expect(cache.store.size).toBe(0)
  })

  it('separates scopes, and never puts the token in a key', async () => {
    const cache = memoryCache()
    const { client, calls } = makeClient(reply(200, [], { ETag: '"e"' }), { cache })
    await client.todos.listIfChanged(TOKEN, 300, { cacheScope: 'service' })
    await client.todos.listIfChanged(TOKEN, 300, { cacheScope: 'user:42' })
    expect(calls[1]?.headers['If-None-Match']).toBeUndefined()
    expect([...cache.store.keys()]).toEqual([`basecamp:service:${BASE}/todolists/300/todos.json`, `basecamp:user:42:${BASE}/todolists/300/todos.json`])
    expect(JSON.stringify([...cache.store])).not.toContain(TOKEN)
  })

  it('refuses a conditional call without a scope', async () => {
    const { client, calls } = makeClient(reply(200, []), { cache: memoryCache() })
    await expect(client.todos.listIfChanged(TOKEN, 300, { cacheScope: '' })).rejects.toThrow(/cacheScope/)
    expect(calls).toHaveLength(0)
  })

  it('a 304 with nothing cached is an UnexpectedResponseError', async () => {
    const { client } = makeClient(reply(304), { cache: memoryCache() })
    await expect(client.http.getIfChanged(TOKEN, '/todos/5.json', 'service')).rejects.toBeInstanceOf(UnexpectedResponseError)
  })

  it('without a cache, a conditional call is a plain GET', async () => {
    const { client, calls } = makeClient(reply(200, [rawTodo(1)], { ETag: '"e"' }))
    const r = await client.todos.listIfChanged(TOKEN, 300, { cacheScope: 'service' })
    const again = await client.todos.listIfChanged(TOKEN, 300, { cacheScope: 'service' })
    expect(r.notModified).toBe(false)
    expect(again.notModified).toBe(false)
    expect(calls[1]?.headers['If-None-Match']).toBeUndefined()
  })
})

describe('conditional GET over several pages', () => {
  const page1 = `${BASE}/todolists/300/todos.json`
  const page2 = `${BASE}/todolists/300/todos.json?page=2`

  it('is notModified only when every page answers 304, following the cached next link', async () => {
    const cache = memoryCache()
    const { client, calls } = makeClient(
      [
        reply(200, [rawTodo(1)], { ETag: '"p1"', Link: `<${page2}>; rel="next"` }),
        reply(200, [rawTodo(2)], { ETag: '"p2"' }),
        reply(304), // page 1: the 304 carries no Link; the cached one is followed
        reply(304), // page 2
      ],
      { cache },
    )
    await client.todos.listIfChanged(TOKEN, 300, { cacheScope: 'service' })
    const again = await client.todos.listIfChanged(TOKEN, 300, { cacheScope: 'service' })
    expect(calls.map((c) => c.url)).toEqual([page1, page2, page1, page2])
    expect(calls[3]?.headers['If-None-Match']).toBe('"p2"')
    expect(again.notModified).toBe(true)
    expect(again.data.map((t) => t.id)).toEqual([1, 2])
  })

  it('a change on a later page makes the whole list modified', async () => {
    const cache = memoryCache()
    const { client } = makeClient(
      [
        reply(200, [rawTodo(1)], { ETag: '"p1"', Link: `<${page2}>; rel="next"` }),
        reply(200, [rawTodo(2)], { ETag: '"p2"' }),
        reply(304),
        reply(200, [rawTodo(2, { content: 'edited' })], { ETag: '"p2b"' }),
      ],
      { cache },
    )
    await client.todos.listIfChanged(TOKEN, 300, { cacheScope: 'service' })
    const again = await client.todos.listIfChanged(TOKEN, 300, { cacheScope: 'service' })
    expect(again.notModified).toBe(false)
    expect(again.data.map((t) => t.content)).toEqual(['Task', 'edited'])
  })
})
