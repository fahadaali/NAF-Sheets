// Pagination (spec §9.4; bc-api README "Pagination"): follow Link rel="next"
// verbatim, never build page URLs.

import { describe, expect, it } from 'vitest'
import { UnexpectedResponseError } from '../src/errors'
import { parseNextLink, parseTotalCount } from '../src/pagination'
import { BASE, makeClient, rawSubtask, rawTodo, reply, TOKEN } from './helpers'

describe('Link rel="next"', () => {
  it('follows the next URL exactly as given and collects every page in order', async () => {
    // Deliberately odd URLs: a client that rebuilt them would not produce these.
    const p2 = `${BASE}/todolists/300/todos.json?page=2&cursor=a%2Fb`
    const p3 = `${BASE}/todolists/300/todos.json?cursor=zz&page=3`
    const { client, calls } = makeClient([
      reply(200, [rawTodo(1), rawTodo(2)], { Link: `<${p2}>; rel="next"`, 'X-Total-Count': '4' }),
      reply(200, [rawTodo(3)], { Link: `<${p3}>; rel="next"` }),
      reply(200, [rawTodo(4)], { Link: '' }),
    ])
    const all = await client.todos.list(TOKEN, 300).all()
    expect(all.map((t) => t.id)).toEqual([1, 2, 3, 4])
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/todolists/300/todos.json`, p2, p3])
    expect(calls.every((c) => c.headers['Authorization'] === `Bearer ${TOKEN}`)).toBe(true)
  })

  it('is an async iterator, lazy, and restartable', async () => {
    const p2 = `${BASE}/recordings/500/subtasks.json?page=2`
    const { client, calls } = makeClient((call) =>
      call.url === p2 ? reply(200, [rawSubtask(2)]) : reply(200, [rawSubtask(1)], { Link: `<${p2}>; rel="next"` }),
    )
    const paged = client.subtasks.list(TOKEN, 500)
    expect(calls).toHaveLength(0)
    const ids: number[] = []
    for await (const s of paged) ids.push(s.id)
    expect(ids).toEqual([1, 2])
    expect(await paged.all()).toHaveLength(2)
    expect(calls).toHaveLength(4)
  })

  it('stops early when the consumer stops iterating', async () => {
    const p2 = `${BASE}/people.json?page=2`
    const { client, calls } = makeClient(reply(200, [{ id: 1, name: 'A' }, { id: 2, name: 'B' }], { Link: `<${p2}>; rel="next"` }))
    for await (const person of client.people.listAll(TOKEN)) {
      expect(person.id).toBe(1)
      break
    }
    expect(calls).toHaveLength(1)
  })

  it('exposes pages with X-Total-Count', async () => {
    const { client } = makeClient(reply(200, [{ id: 1, name: 'A' }], { 'X-Total-Count': '1' }))
    const pages = []
    for await (const page of client.people.listProject(TOKEN, 9).pages()) pages.push(page)
    expect(pages).toEqual([{ items: [{ id: 1, name: 'A' }], totalCount: 1 }])
  })

  it('never follows a next link outside this account (it would receive the token)', async () => {
    for (const evil of ['https://evil.example/195539477/x.json', 'https://3.basecampapi.com/1955394770/todos.json', 'http://3.basecampapi.com/195539477/x.json']) {
      const { client, calls } = makeClient(reply(200, [rawTodo(1)], { Link: `<${evil}>; rel="next"` }))
      await expect(client.todos.list(TOKEN, 300).all()).rejects.toBeInstanceOf(UnexpectedResponseError)
      expect(calls.map((c) => c.url)).toEqual([`${BASE}/todolists/300/todos.json`])
    }
  })

  it('stops a next link that loops back', async () => {
    const self = `${BASE}/todolists/300/todos.json`
    const { client, calls } = makeClient(reply(200, [rawTodo(1)], { Link: `<${self}>; rel="next"` }))
    await expect(client.todos.list(TOKEN, 300).all()).rejects.toThrow(/does not terminate/)
    expect(calls).toHaveLength(1)
  })

  it('rejects a page that is not an array', async () => {
    const { client } = makeClient(reply(200, { id: 1 }))
    await expect(client.comments.list(TOKEN, 1).all()).rejects.toThrow(/JSON array/)
  })
})

describe('parseNextLink / parseTotalCount', () => {
  it('reads the documented form', () => {
    expect(parseNextLink('<https://3.basecampapi.com/999999999/message_boards/3/messages.json?page=4>; rel="next"')).toBe(
      'https://3.basecampapi.com/999999999/message_boards/3/messages.json?page=4',
    )
  })

  it('handles several links, bare rel and rel lists', () => {
    expect(parseNextLink('<https://a/1>; rel="prev", <https://a/3>; rel="next"')).toBe('https://a/3')
    expect(parseNextLink('<https://a/3>; rel=next')).toBe('https://a/3')
    expect(parseNextLink('<https://a/3>; title="x"; rel="next last"')).toBe('https://a/3')
    expect(parseNextLink('<https://a/3>; REL="Next"')).toBe('https://a/3')
  })

  it('returns null when there is no next page', () => {
    expect(parseNextLink(null)).toBeNull()
    expect(parseNextLink('')).toBeNull()
    expect(parseNextLink('<https://a/1>; rel="prev"')).toBeNull()
    expect(parseNextLink('<https://a/1>; rel="nextish"')).toBeNull()
  })

  it('reads X-Total-Count', () => {
    expect(parseTotalCount('42')).toBe(42)
    expect(parseTotalCount(null)).toBeNull()
    expect(parseTotalCount('many')).toBeNull()
  })
})
