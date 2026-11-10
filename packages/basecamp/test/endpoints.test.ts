// Paths, bodies and response handling of the remaining endpoints, checked
// against the bc-api sections cited in src/client.ts. Responses are the
// docs' own examples (fixtures/docs-examples.ts).

import { describe, expect, it } from 'vitest'
import { findTodosetId, NAF_WEBHOOK_TYPES } from '../src/client'
import { NotFoundError, RateLimitedError, ServerError, UnexpectedResponseError } from '../src/errors'
import {
  createAttachmentExample,
  enrollPeopleExample,
  getCommentExample,
  getProjectExample,
  getTodolistExample,
  getWebhookExample,
  listCommentsExample,
  listPeopleExample,
  listProjectsExample,
  listTodolistsExample,
  listWebhooksExample,
  updateProjectAccessExample,
} from './fixtures/docs-examples'
import { ACCOUNT, BASE, makeClient, reply, TOKEN } from './helpers'

describe('projects (projects.md)', () => {
  it('gets a project and finds its enabled to-do set in the dock', async () => {
    const { client, calls } = makeClient(reply(200, getProjectExample))
    const project = await client.projects.get(TOKEN, 2085958504)
    expect(calls[0]?.path).toBe('/projects/2085958504.json')
    expect(project.name).toBe('The Leto Laptop')
    expect(findTodosetId(project)).toBe(1069479830)
    expect(await client.projects.getTodosetId(TOKEN, 2085958504)).toBe(1069479830)
  })

  it('returns null when the to-do set is turned off, and refuses two enabled ones', () => {
    const tool = (id: number, enabled: boolean) => ({ id, title: 'To-dos', name: 'todoset', enabled, position: 2, url: '', app_url: '' })
    expect(findTodosetId({ dock: [tool(1, false)] })).toBeNull()
    expect(findTodosetId({ dock: [] })).toBeNull()
    expect(() => findTodosetId({ dock: [tool(1, true), tool(2, true)] })).toThrow(/more than one/)
  })

  it('lists projects, optionally by status', async () => {
    const { client, calls } = makeClient(reply(200, listProjectsExample))
    const all = await client.projects.list(TOKEN).all()
    await client.projects.list(TOKEN, { status: 'archived' }).all()
    expect(all[0]?.id).toBe(2085958504)
    expect(calls.map((c) => c.path)).toEqual(['/projects.json', '/projects.json?status=archived'])
  })

  it('creates a project with a name and optional description', async () => {
    const { client, calls } = makeClient(reply(201, getProjectExample))
    await client.projects.create(TOKEN, { name: 'حملة', description: 'وصف' })
    await client.projects.create(TOKEN, { name: 'Only name' })
    expect(calls.map((c) => [c.method, c.path, c.json])).toEqual([
      ['POST', '/projects.json', { name: 'حملة', description: 'وصف' }],
      ['POST', '/projects.json', { name: 'Only name' }],
    ])
    await expect(client.projects.create(TOKEN, { name: ' ' })).rejects.toThrow(TypeError)
  })
})

describe('to-do lists (todolists.md)', () => {
  it('lists the lists of a to-do set, optionally archived or trashed', async () => {
    const { client, calls } = makeClient(reply(200, listTodolistsExample))
    const lists = await client.todolists.list(TOKEN, 1069479829).all()
    await client.todolists.list(TOKEN, 1069479829, { status: 'trashed' }).all()
    expect(lists[0]).toMatchObject({ id: 1069480012, name: 'Strategy ideas' })
    expect(calls.map((c) => c.path)).toEqual(['/todosets/1069479829/todolists.json', '/todosets/1069479829/todolists.json?status=trashed'])
  })

  it('creates a list under the to-do set with name and description', async () => {
    const { client, calls } = makeClient(reply(201, getTodolistExample))
    const list = await client.todolists.create(TOKEN, 1069479829, { name: 'ورقة 1', descriptionHtml: '<div>x</div>' })
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/todosets/1069479829/todolists.json', json: { name: 'ورقة 1', description: '<div>x</div>' } })
    expect(list.id).toBe(1069479863)
  })

  it('gets one list', async () => {
    const { client, calls } = makeClient(reply(200, getTodolistExample))
    expect((await client.todolists.get(TOKEN, 1069479863)).todos_url).toContain('/todolists/1069479863/todos.json')
    expect(calls[0]?.path).toBe('/todolists/1069479863.json')
  })
})

describe('webhooks (webhooks.md): create and list are bucket-scoped, the rest flat', () => {
  it('creates with payload_url and the platform types under /buckets/{project}', async () => {
    const { client, calls } = makeClient(reply(201, getWebhookExample))
    const hook = await client.webhooks.create(TOKEN, 2085958505, { payloadUrl: 'https://sheets.naflaw.sa/webhooks/basecamp/s3cr3t', types: NAF_WEBHOOK_TYPES })
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/buckets/2085958505/webhooks.json',
      json: { payload_url: 'https://sheets.naflaw.sa/webhooks/basecamp/s3cr3t', types: ['Todo', 'Todolist', 'Kanban::Step', 'Comment', 'Upload'] },
    })
    expect(hook.id).toBe(1051369971)
  })

  it('refuses a non-HTTPS payload URL and empty types before sending', async () => {
    const { client, calls } = makeClient(reply(201, getWebhookExample))
    await expect(client.webhooks.create(TOKEN, 1, { payloadUrl: 'http://x.example/h', types: ['Todo'] })).rejects.toThrow(/HTTPS/)
    await expect(client.webhooks.create(TOKEN, 1, { payloadUrl: 'https://x.example/h', types: [] })).rejects.toThrow(/types/)
    expect(calls).toHaveLength(0)
  })

  it('lists under /buckets/{project}, gets/updates/deletes flat', async () => {
    const { client, calls } = makeClient((call) =>
      call.method === 'DELETE' ? reply(204) : call.path.startsWith('/buckets/') ? reply(200, listWebhooksExample) : reply(200, getWebhookExample),
    )
    const hooks = await client.webhooks.list(TOKEN, 2085958505).all()
    const one = await client.webhooks.get(TOKEN, 1051369971)
    await client.webhooks.update(TOKEN, 1051369971, { payloadUrl: 'https://h.example/x', types: ['Todo', 'Kanban::Step'], active: true })
    await client.webhooks.delete(TOKEN, 1051369971)
    expect(hooks[0]?.active).toBe(true)
    expect(one.recent_deliveries).toHaveLength(1)
    expect(calls.map((c) => [c.method, c.path, c.json])).toEqual([
      ['GET', '/buckets/2085958505/webhooks.json', undefined],
      ['GET', '/webhooks/1051369971.json', undefined],
      ['PUT', '/webhooks/1051369971.json', { payload_url: 'https://h.example/x', types: ['Todo', 'Kanban::Step'], active: true }],
      ['DELETE', '/webhooks/1051369971.json', undefined],
    ])
  })

  it('always sends payload_url, types and active on update', async () => {
    const { client, calls } = makeClient(reply(200, getWebhookExample))
    await client.webhooks.update(TOKEN, 3, { payloadUrl: 'https://h.example/x', types: ['Todo'], active: false })
    expect(Object.keys(calls[0]?.json as object).sort()).toEqual(['active', 'payload_url', 'types'])
    await expect(client.webhooks.update(TOKEN, 3, { payloadUrl: 'https://h.example/x', types: ['Todo'] } as never)).rejects.toThrow(/active/)
  })
})

describe('people (people.md)', () => {
  it('reads project people, all people and my profile', async () => {
    const { client, calls } = makeClient((call) => (call.path === '/my/profile.json' ? reply(200, { id: 1049715913, name: 'Victor Cooper' }) : reply(200, listPeopleExample)))
    const project = await client.people.listProject(TOKEN, 2085958505).all()
    const all = await client.people.listAll(TOKEN).all()
    const me = await client.people.me(TOKEN)
    expect(project[0]?.personable_type).toBe('User')
    expect(all).toHaveLength(1)
    expect(me.id).toBe(1049715913)
    expect(calls.map((c) => c.path)).toEqual(['/projects/2085958505/people.json', '/people.json', '/my/profile.json'])
  })

  it('grants, revokes and creates project access with PUT /projects/{id}/people/users.json', async () => {
    const { client, calls } = makeClient(reply(200, updateProjectAccessExample))
    const r = await client.people.updateProjectAccess(TOKEN, 1, {
      grant: [1049715915],
      revoke: [1049715944],
      create: [{ name: 'Victor Copper', emailAddress: 'victor@hanchodesign.com', title: 'Prankster', companyName: 'Hancho Design' }],
    })
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      path: '/projects/1/people/users.json',
      json: {
        grant: [1049715915],
        revoke: [1049715944],
        create: [{ name: 'Victor Copper', email_address: 'victor@hanchodesign.com', title: 'Prankster', company_name: 'Hancho Design' }],
      },
    })
    expect(r.granted.map((p) => p.id)).toEqual([1049715915, 1049715956])
    expect(r.revoked.map((p) => p.id)).toEqual([1049715944])
  })

  it('sends only what is asked, and refuses an empty change', async () => {
    const { client, calls } = makeClient(reply(200, { granted: [], revoked: [] }))
    await client.people.updateProjectAccess(TOKEN, 1, { grant: [5], revoke: [] })
    expect(calls[0]?.json).toEqual({ grant: [5] })
    await expect(client.people.updateProjectAccess(TOKEN, 1, {})).rejects.toThrow(/at least one/)
    await expect(client.people.updateProjectAccess(TOKEN, 1, { grant: [] })).rejects.toThrow(/at least one/)
  })

  it('enrolls people in the account with POST /account/enrollments/people.json', async () => {
    const { client, calls } = makeClient(reply(201, enrollPeopleExample))
    const r = await client.people.enroll(TOKEN, {
      people: [{ name: 'Victor Copper', emailAddress: 'victor@hanchodesign.com' }, { name: 'Amy Rivera', emailAddress: 'amy@honchodesign.com' }],
      projectIds: [1049715914],
      notify: true,
    })
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/account/enrollments/people.json',
      json: {
        people: [
          { name: 'Victor Copper', email_address: 'victor@hanchodesign.com' },
          { name: 'Amy Rivera', email_address: 'amy@honchodesign.com' },
        ],
        project_ids: [1049715914],
        notify: true,
      },
    })
    expect(r.map((p) => p.status)).toEqual(['created', 'existing'])
    await expect(client.people.enroll(TOKEN, { people: [] })).rejects.toThrow(/at least one/)
  })

  it('manages client users with PUT /projects/{id}/people/client_users.json', async () => {
    const { client, calls } = makeClient(reply(200, { granted: [], revoked: [] }))
    await client.people.updateClientUsers(TOKEN, 7, { create: [{ emailAddress: 'annie@springfield.example.com', name: 'Annie Bryan' }] })
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      path: '/projects/7/people/client_users.json',
      json: { create: [{ email_address: 'annie@springfield.example.com', name: 'Annie Bryan' }] },
    })
  })
})

describe('comments (comments.md)', () => {
  it('lists and creates comments on a recording', async () => {
    const { client, calls } = makeClient((call) => (call.method === 'GET' ? reply(200, listCommentsExample) : reply(201, getCommentExample)))
    const list = await client.comments.list(TOKEN, 1069479842).all()
    const created = await client.comments.create(TOKEN, 1069479842, '<div>تم</div>')
    expect(list[0]?.content).toContain('Great job')
    expect(created.id).toBe(1069479852)
    expect(calls.map((c) => [c.method, c.path, c.json])).toEqual([
      ['GET', '/recordings/1069479842/comments.json', undefined],
      ['POST', '/recordings/1069479842/comments.json', { content: '<div>تم</div>' }],
    ])
    await expect(client.comments.create(TOKEN, 1, '')).rejects.toThrow(TypeError)
  })

  it('phase 5: gets one comment (its parent is the commented recording); another type is unexpected', async () => {
    const { client, calls } = makeClient(reply(200, getCommentExample))
    const comment = await client.comments.get(TOKEN, 1069479852)
    expect(calls[0]?.path).toBe('/comments/1069479852.json')
    expect(comment.parent.id).toBe(1069479842)
    const other = makeClient(reply(200, { ...(getCommentExample as object), type: 'Message' }))
    await expect(other.client.comments.get(TOKEN, 1)).rejects.toBeInstanceOf(UnexpectedResponseError)
  })
})

describe('attachments (attachments.md)', () => {
  it('uploads raw bytes with the file type, its length and ?name=, and returns the sgid', async () => {
    const { client, calls } = makeClient(reply(201, createAttachmentExample))
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])
    const r = await client.attachments.upload(TOKEN, { name: 'تقرير v2.pdf', contentType: 'application/pdf', data: bytes })
    expect(r.attachableSgid).toBe((createAttachmentExample as { attachable_sgid: string }).attachable_sgid)
    const call = calls[0]
    expect(call?.method).toBe('POST')
    expect(call?.path).toBe(`/attachments.json?name=${encodeURIComponent('تقرير v2.pdf')}`)
    expect(call?.headers['Content-Type']).toBe('application/pdf')
    expect(call?.headers['Content-Length']).toBe('4')
    expect(call?.headers['Authorization']).toBe(`Bearer ${TOKEN}`)
    expect(call?.rawBody).toBeInstanceOf(ArrayBuffer)
    expect([...new Uint8Array(call?.rawBody as ArrayBuffer)]).toEqual([0x25, 0x50, 0x44, 0x46])
  })

  it('accepts an ArrayBuffer and validates inputs', async () => {
    const { client, calls } = makeClient(reply(201, createAttachmentExample))
    await client.attachments.upload(TOKEN, { name: 'a.png', contentType: 'image/png', data: new Uint8Array([1, 2]).buffer })
    expect(calls[0]?.headers['Content-Length']).toBe('2')
    await expect(client.attachments.upload(TOKEN, { name: '', contentType: 'image/png', data: new ArrayBuffer(1) })).rejects.toThrow(/name/)
    await expect(client.attachments.upload(TOKEN, { name: 'a', contentType: 'png', data: new ArrayBuffer(1) })).rejects.toThrow(/contentType/)
  })

  it('a response without attachable_sgid is an UnexpectedResponseError', async () => {
    const { client } = makeClient(reply(201, { id: 1 }))
    await expect(client.attachments.upload(TOKEN, { name: 'a.png', contentType: 'image/png', data: new ArrayBuffer(1) })).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    )
  })
})

describe('attachments, phase 5: a stored file streamed, and downloads', () => {
  const streamOf = (bytes: number[]) => new Response(new Uint8Array(bytes)).body as ReadableStream<Uint8Array>

  it('streams a stored file with its exact length, and opens it again for a retried attempt', async () => {
    let opened = 0
    const { client, calls } = makeClient([reply(503, {}), reply(201, createAttachmentExample)])
    const r = await client.attachments.upload(TOKEN, {
      name: 'خطة.pdf',
      contentType: 'application/pdf',
      data: { byteLength: 3, open: () => (opened++, streamOf([1, 2, 3])) },
    })
    expect(r.attachableSgid).toBe((createAttachmentExample as { attachable_sgid: string }).attachable_sgid)
    expect(opened).toBe(2)
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.headers['Content-Length']).toBe('3')
      expect(call.headers['Content-Type']).toBe('application/pdf')
      expect(call.rawBody).toBeInstanceOf(ReadableStream)
    }
    expect([...new Uint8Array(await new Response(calls[1]?.rawBody as ReadableStream).arrayBuffer())]).toEqual([1, 2, 3])
    await expect(client.attachments.upload(TOKEN, { name: 'a', contentType: 'text/plain', data: { byteLength: -1, open: () => streamOf([]) } })).rejects.toThrow(/byteLength/)
  })

  it('downloads a file of this account with the token, and follows a redirect without it', async () => {
    const storage = `https://storage.3.basecamp.com/${ACCOUNT}/blobs/k1/download/plan.pdf`
    const signed = 'https://bc-blobs.example/plan.pdf?sig=1'
    const { client, calls, limiter } = makeClient((call) =>
      call.url === storage ? reply(302, undefined, { Location: signed }) : { status: 200, bytes: new Uint8Array([7, 8]), headers: { 'Content-Type': 'application/pdf', 'Content-Length': '2' } },
    )
    const file = await client.attachments.download(TOKEN, storage)
    expect(file.contentType).toBe('application/pdf')
    expect(file.contentLength).toBe(2)
    expect([...new Uint8Array(await new Response(file.body).arrayBuffer())]).toEqual([7, 8])
    expect(calls.map((c) => [c.url, c.headers['Authorization'] ?? null, c.redirect])).toEqual([
      [storage, `Bearer ${TOKEN}`, 'manual'],
      [signed, null, 'manual'],
    ])
    expect(calls.every((c) => c.headers['User-Agent'] === 'NAF Comms (info@naflaw.sa)')).toBe(true)
    expect(limiter.acquired).toBe(2)
  })

  it('refuses a URL outside the account before any request, and maps failures', async () => {
    const { client, calls } = makeClient((call) =>
      call.url.endsWith('/gone.pdf') ? reply(404, {}) : call.url.endsWith('/busy.pdf') ? reply(429, {}, { 'Retry-After': '3' }) : call.url.endsWith('/down.pdf') ? reply(503, {}) : reply(302, undefined, { Location: 'http://plain.example/x' }),
    )
    for (const url of ['https://evil.example/x.pdf', `https://storage.3.basecamp.com/999/blobs/x.pdf`, `http://storage.3.basecamp.com/${ACCOUNT}/x.pdf`, 'not a url']) {
      await expect(client.attachments.download(TOKEN, url)).rejects.toThrow(TypeError)
    }
    expect(calls).toHaveLength(0)
    await expect(client.attachments.download(TOKEN, `${BASE}/blobs/gone.pdf`)).rejects.toBeInstanceOf(NotFoundError)
    const limited = await client.attachments.download(TOKEN, `${BASE}/blobs/busy.pdf`).catch((e: unknown) => e)
    expect(limited).toBeInstanceOf(RateLimitedError)
    expect((limited as RateLimitedError).retryAfterMs).toBe(3000)
    await expect(client.attachments.download(TOKEN, `${BASE}/blobs/down.pdf`)).rejects.toBeInstanceOf(ServerError)
    // A redirect to plain HTTP is refused.
    await expect(client.attachments.download(TOKEN, `${BASE}/blobs/moved.pdf`)).rejects.toBeInstanceOf(UnexpectedResponseError)
    for (const c of calls) expect(String(c.headers['Authorization'] ?? '')).not.toContain('evil')
  })
})

describe('generic access', () => {
  it('GETs any path relative to the account, and refuses absolute or protocol-relative ones', async () => {
    const { client, calls } = makeClient(reply(200, { id: 1 }))
    await client.http.get(TOKEN, '/todosets/1.json')
    expect(calls[0]?.path).toBe('/todosets/1.json')
    await expect(client.http.get(TOKEN, 'https://evil.example/x')).rejects.toThrow(TypeError)
    await expect(client.http.get(TOKEN, '//evil.example/x')).rejects.toThrow(TypeError)
    expect(() => client.http.paginate(TOKEN, 'x')).toThrow(TypeError)
  })
})
