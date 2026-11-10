// A stateful fake of the Basecamp 3/5 API for the sync tests. Nothing real
// is ever called: every request goes through `FakeBasecamp.fetch`, which
// records it and answers from in-memory records shaped like the documented
// responses (bc-api sections todos.md, subtasks.md, todolists.md,
// webhooks.md, people.md, recordings.md). Notably:
// - PUT /todos/{id}.json CLEARS every field it does not carry (todos.md);
// - PUT /subtasks/{id}.json is partial;
// - GET /todos/{id}.json has no `position` and only the first 100 `steps`;
// - lists paginate with `Link: <…>; rel="next"` and answer 304 to a matching `If-None-Match`.

export interface FakePerson {
  id: number
  name: string
  email_address: string
  admin?: boolean
}

export interface FakeTodo {
  id: number
  listId: number
  bucketId: number
  content: string
  description: string
  assigneeIds: number[]
  completionSubscriberIds: number[]
  dueOn: string | null
  startsOn: string | null
  completed: boolean
  status: 'active' | 'archived' | 'trashed'
  position: number
  updatedAt: string
  creatorId: number
}

export interface FakeSubtask {
  id: number
  todoId: number
  bucketId: number
  title: string
  assigneeIds: number[]
  dueOn: string | null
  completed: boolean
  position: number
  updatedAt: string
  creatorId: number
}

export interface FakeList {
  id: number
  projectId: number
  name: string
  status: 'active' | 'archived' | 'trashed'
}

export interface FakeWebhook {
  id: number
  projectId: number
  payloadUrl: string
  types: string[]
  active: boolean
}

/** A comment on a to-do (comments.md). */
export interface FakeComment {
  id: number
  todoId: number
  bucketId: number
  content: string
  creatorId: number
  createdAt: string
  status: 'active' | 'trashed'
}

/** A file uploaded with POST /attachments.json (attachments.md), by its attachable sgid. */
export interface FakeBlob {
  id: number
  sgid: string
  key: string
  filename: string
  contentType: string
  bytes: Uint8Array
  uploadedBy: number
}

export interface RecordedCall {
  method: string
  path: string
  query: URLSearchParams
  token: string
  body: unknown
  headers: Record<string, string>
}

interface Failure {
  match: (c: RecordedCall) => boolean
  status: number
  headers?: Record<string, string>
  body?: unknown
  times: number
}

let sequence = 0
export function uniqueId(): number {
  sequence += 1
  return Math.floor(Math.random() * 1e8) * 1000 + sequence
}

export class FakeBasecamp {
  readonly calls: RecordedCall[] = []
  readonly people = new Map<number, FakePerson>()
  readonly projects = new Map<number, { id: number; name: string; todosetId: number; peopleIds: Set<number> }>()
  readonly lists = new Map<number, FakeList>()
  readonly todos = new Map<number, FakeTodo>()
  readonly subtasks = new Map<number, FakeSubtask>()
  readonly webhooks = new Map<number, FakeWebhook>()
  /** Phase 5: comments by id, and uploaded files by sgid. */
  readonly comments = new Map<number, FakeComment>()
  readonly blobs = new Map<string, FakeBlob>()
  /** token → Basecamp person id (who the token belongs to). */
  readonly tokens = new Map<string, number>()
  /** Page size of list endpoints (Basecamp's is larger; small here to exercise `Link`). */
  pageSize = 50
  /** Basecamp's clock for `updated_at`; every write moves it on by one second. */
  clock = Date.now()
  private readonly failures: Failure[] = []
  /** Called (and awaited) right before a subtask is deleted, to observe what the platform stored first. */
  beforeSubtaskDelete: ((id: number) => Promise<void>) | null = null

  constructor(readonly accountId: number) {}

  get apiBase(): string {
    return `https://3.basecampapi.com/${this.accountId}`
  }

  // --- Setup -------------------------------------------------------------------

  person(name: string, options: { admin?: boolean } = {}): FakePerson {
    const p: FakePerson = { id: uniqueId(), name, email_address: `p${sequence}@naflaw.sa`, admin: options.admin ?? false }
    this.people.set(p.id, p)
    return p
  }

  token(personId: number): string {
    const t = `tok-${crypto.randomUUID()}`
    this.tokens.set(t, personId)
    return t
  }

  project(name: string, peopleIds: number[]): { id: number; todosetId: number } {
    const p = { id: uniqueId(), name, todosetId: uniqueId(), peopleIds: new Set(peopleIds) }
    this.projects.set(p.id, p)
    return p
  }

  list(projectId: number, name: string): FakeList {
    const l: FakeList = { id: uniqueId(), projectId, name, status: 'active' }
    this.lists.set(l.id, l)
    return l
  }

  tick(): string {
    this.clock += 1000
    return new Date(this.clock).toISOString()
  }

  addTodo(listId: number, fields: Partial<FakeTodo> & { content: string }): FakeTodo {
    const list = this.lists.get(listId) as FakeList
    const siblings = [...this.todos.values()].filter((t) => t.listId === listId)
    const t: FakeTodo = {
      id: uniqueId(),
      listId,
      bucketId: list.projectId,
      description: '',
      assigneeIds: [],
      completionSubscriberIds: [],
      dueOn: null,
      startsOn: null,
      completed: false,
      status: 'active',
      position: siblings.length + 1,
      updatedAt: this.tick(),
      creatorId: 0,
      ...fields,
    }
    this.todos.set(t.id, t)
    return t
  }

  addSubtask(todoId: number, fields: Partial<FakeSubtask> & { title: string }): FakeSubtask {
    const todo = this.todos.get(todoId) as FakeTodo
    const siblings = [...this.subtasks.values()].filter((s) => s.todoId === todoId)
    const s: FakeSubtask = {
      id: uniqueId(),
      todoId,
      bucketId: todo.bucketId,
      assigneeIds: [],
      dueOn: null,
      completed: false,
      position: siblings.length + 1,
      updatedAt: this.tick(),
      creatorId: 0,
      ...fields,
    }
    this.subtasks.set(s.id, s)
    todo.updatedAt = this.tick()
    return s
  }

  /** A comment on a to-do, as a person would add it in Basecamp. */
  addComment(todoId: number, content: string, creatorId = 1): FakeComment {
    const todo = this.todos.get(todoId) as FakeTodo
    const c: FakeComment = { id: uniqueId(), todoId, bucketId: todo.bucketId, content, creatorId, createdAt: this.tick(), status: 'active' }
    this.comments.set(c.id, c)
    return c
  }

  /** A file uploaded to Basecamp (not yet in any description); returns its sgid. */
  addBlob(filename: string, contentType: string, bytes: Uint8Array, uploadedBy = 1): FakeBlob {
    const id = uniqueId()
    const b: FakeBlob = { id, sgid: `BAh-sgid-${id}==--${hashText(filename)}`, key: `key${id}`, filename, contentType, bytes, uploadedBy }
    this.blobs.set(b.sgid, b)
    return b
  }

  storageUrl(b: FakeBlob): string {
    return `https://storage.3.basecamp.com/${this.accountId}/blobs/${b.key}/download/${encodeURIComponent(b.filename)}`
  }

  /** The documented element for a file, as a person attaching it in Basecamp would leave it (rich_text.md). */
  attachmentHtml(b: FakeBlob): string {
    return `<bc-attachment sgid="${b.sgid}" content-type="${b.contentType}" filename="${b.filename}"><figure><figcaption>${b.filename}</figcaption></figure></bc-attachment>`
  }

  commentsOf(todoId: number): FakeComment[] {
    return [...this.comments.values()].filter((c) => c.todoId === todoId && c.status === 'active').sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)
  }

  /** `description_attachments` (rich_text.md "Structured attachment metadata") of a description. */
  private descriptionAttachments(html: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = []
    for (const m of html.matchAll(/<bc-attachment\b[^>]*\ssgid="([^"]+)"/g)) {
      const b = this.blobs.get(m[1] as string)
      if (!b || out.some((x) => x['sgid'] === b.sgid)) continue
      out.push({ id: b.id, sgid: b.sgid, filename: b.filename, content_type: b.contentType, byte_size: b.bytes.byteLength, download_url: this.storageUrl(b) })
    }
    return out
  }

  /** The next `times` requests matching `match` answer `status`. */
  fail(match: (c: RecordedCall) => boolean, status: number, options: { headers?: Record<string, string>; body?: unknown; times?: number } = {}): void {
    this.failures.push({ match, status, headers: options.headers, body: options.body, times: options.times ?? 1 })
  }

  writes(): RecordedCall[] {
    return this.calls.filter((c) => c.method !== 'GET')
  }

  callsTo(method: string, pattern: RegExp): RecordedCall[] {
    return this.calls.filter((c) => c.method === method && pattern.test(c.path))
  }

  // --- Wire shapes ------------------------------------------------------------------

  private personRef(id: number): Record<string, unknown> {
    const p = this.people.get(id)
    return { id, name: p?.name ?? `شخص ${id}`, personable_type: 'User' }
  }

  rawTodo(t: FakeTodo, options: { position: boolean; steps: boolean }): Record<string, unknown> {
    const list = this.lists.get(t.listId)
    const subs = this.subtasksOf(t.id)
    const raw: Record<string, unknown> = {
      id: t.id,
      status: t.status,
      type: 'Todo',
      created_at: t.updatedAt,
      updated_at: t.updatedAt,
      title: t.content,
      content: t.content,
      description: t.description,
      parent: { id: t.listId, title: list?.name ?? '', type: 'Todolist', url: '', app_url: '' },
      bucket: { id: t.bucketId, name: 'مشروع', type: 'Project' },
      creator: this.personRef(t.creatorId || 1),
      completed: t.completed,
      starts_on: t.startsOn,
      due_on: t.dueOn,
      assignees: t.assigneeIds.map((id) => this.personRef(id)),
      completion_subscribers: t.completionSubscriberIds.map((id) => this.personRef(id)),
      subtasks_count: subs.length,
      subtasks_completed_count: subs.filter((s) => s.completed).length,
      subtasks_url: `${this.apiBase}/recordings/${t.id}/subtasks.json`,
      comments_count: this.commentsOf(t.id).length,
      description_attachments: this.descriptionAttachments(t.description),
      url: `${this.apiBase}/todos/${t.id}.json`,
      app_url: `https://3.basecamp.com/${this.accountId}/buckets/${t.bucketId}/todos/${t.id}`,
    }
    if (options.position) raw['position'] = t.position
    if (options.steps) raw['steps'] = subs.slice(0, 100).map((s) => this.rawSubtask(s))
    return raw
  }

  rawSubtask(s: FakeSubtask): Record<string, unknown> {
    return {
      id: s.id,
      status: 'active',
      type: 'Kanban::Step',
      created_at: s.updatedAt,
      updated_at: s.updatedAt,
      title: s.title,
      position: s.position,
      parent: { id: s.todoId, title: '', type: 'Todo', url: '', app_url: '' },
      bucket: { id: s.bucketId, name: 'مشروع', type: 'Project' },
      creator: this.personRef(s.creatorId || 1),
      completed: s.completed,
      due_on: s.dueOn,
      assignees: s.assigneeIds.map((id) => this.personRef(id)),
      url: '',
      app_url: '',
    }
  }

  subtasksOf(todoId: number): FakeSubtask[] {
    return [...this.subtasks.values()].filter((s) => s.todoId === todoId).sort((a, b) => a.position - b.position)
  }

  /** A webhook delivery body for `recording` (webhooks.md), as Basecamp would POST it. */
  delivery(kind: string, recording: { id: number; type: string; bucketId: number }, creatorId = 1): string {
    return JSON.stringify({
      id: uniqueId(),
      kind,
      details: {},
      created_at: new Date(this.clock).toISOString(),
      recording: { id: recording.id, status: 'active', type: recording.type, title: 'x', bucket: { id: recording.bucketId, name: 'مشروع', type: 'Project' } },
      creator: { id: creatorId, name: 'x' },
    })
  }

  // --- HTTP --------------------------------------------------------------------------

  /** Bodies of binary uploads, in order (phase 5). */
  readonly uploads: Array<{ name: string; contentType: string; contentLength: string; bytes: Uint8Array; token: string }> = []

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(new Headers(init.headers as HeadersInit).entries())
    const method = (init.method ?? 'GET').toUpperCase()
    const storage = `https://storage.3.basecamp.com/${this.accountId}/blobs/`
    if (url.startsWith(storage)) return this.download(url, method, headers)
    if (!url.startsWith(`${this.apiBase}/`)) throw new Error(`FakeBasecamp: unexpected request ${method} ${url}`)
    const u = new URL(url)
    const path = u.pathname.slice(`/${this.accountId}`.length)
    const token = (headers['authorization'] ?? '').replace(/^Bearer /, '')
    let body: unknown = null
    if (typeof init.body === 'string' && init.body !== '') body = JSON.parse(init.body)
    const call: RecordedCall = { method, path, query: u.searchParams, token, body, headers }
    this.calls.push(call)

    if (headers['user-agent'] !== 'NAF Comms (info@naflaw.sa)') return reply(400, { error: 'user agent' })
    // attachments.md: raw bytes with the file's own type and length (not JSON).
    if (method === 'POST' && path === '/attachments.json') {
      const failure = this.failures.find((f) => f.times > 0 && f.match(call))
      if (failure) {
        failure.times -= 1
        return reply(failure.status, failure.body ?? {}, failure.headers)
      }
      const me = this.tokens.get(token)
      if (me === undefined) return reply(401, { error: 'unauthorized' })
      const ct = headers['content-type'] ?? ''
      if (ct === '' || ct.startsWith('application/json')) return reply(415, {})
      const bytes = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer())
      if (String(bytes.byteLength) !== headers['content-length']) return reply(400, { error: 'length' })
      const name = u.searchParams.get('name') ?? ''
      this.uploads.push({ name, contentType: ct, contentLength: headers['content-length'] ?? '', bytes, token })
      const b = this.addBlob(name, ct, bytes, me)
      return reply(201, { id: b.id, attachable_sgid: b.sgid, sgid: b.sgid, filename: b.filename, content_type: ct, byte_size: bytes.byteLength, download_url: this.storageUrl(b) })
    }
    if ((method === 'POST' || method === 'PUT') && headers['content-type'] !== 'application/json; charset=utf-8') return reply(415, {})
    const failure = this.failures.find((f) => f.times > 0 && f.match(call))
    if (failure) {
      failure.times -= 1
      return reply(failure.status, failure.body ?? {}, failure.headers)
    }
    const me = this.tokens.get(token)
    if (me === undefined) return reply(401, { error: 'unauthorized' })
    return await this.route(call, me)
  }

  private paged(call: RecordedCall, items: unknown[]): Response {
    const page = Number(call.query.get('page') ?? '1')
    const slice = items.slice((page - 1) * this.pageSize, page * this.pageSize)
    const headers: Record<string, string> = { 'X-Total-Count': String(items.length) }
    if (page * this.pageSize < items.length) {
      const next = new URLSearchParams(call.query)
      next.set('page', String(page + 1))
      headers['Link'] = `<${this.apiBase}${call.path}?${next.toString()}>; rel="next"`
    }
    const etag = `"${hashText(JSON.stringify(slice) + (headers['Link'] ?? ''))}"`
    headers['ETag'] = etag
    if (call.headers['if-none-match'] === etag) return new Response(null, { status: 304, headers })
    return reply(200, slice, headers)
  }

  private async route(call: RecordedCall, me: number): Promise<Response> {
    const { method, path } = call
    const b = (call.body ?? {}) as Record<string, unknown>
    let m: RegExpExecArray | null

    // Projects
    if (method === 'POST' && path === '/projects.json') {
      const p = this.project(String(b['name']), [me])
      return reply(201, this.rawProject(p.id))
    }
    if ((m = /^\/projects\/(\d+)\.json$/.exec(path)) && method === 'GET') {
      const p = this.projects.get(Number(m[1]))
      return p && p.peopleIds.has(me) ? reply(200, this.rawProject(p.id)) : reply(404, {})
    }
    if ((m = /^\/projects\/(\d+)\/people\.json$/.exec(path)) && method === 'GET') {
      const p = this.projects.get(Number(m[1]))
      if (!p || !p.peopleIds.has(me)) return reply(404, {})
      return this.paged(call, [...p.peopleIds].map((id) => this.rawPerson(id)))
    }
    if ((m = /^\/projects\/(\d+)\/people\/users\.json$/.exec(path)) && method === 'PUT') {
      const p = this.projects.get(Number(m[1]))
      if (!p) return reply(404, {})
      const meP = this.people.get(me)
      if (!meP?.admin) return reply(403, { error: 'forbidden' })
      const granted = ((b['grant'] as number[]) ?? []).map((id) => {
        p.peopleIds.add(id)
        return this.rawPerson(id)
      })
      return reply(200, { granted, revoked: [] })
    }
    if (method === 'GET' && path === '/people.json') return this.paged(call, [...this.people.keys()].map((id) => this.rawPerson(id)))

    // Lists
    if ((m = /^\/todosets\/(\d+)\/todolists\.json$/.exec(path))) {
      const p = [...this.projects.values()].find((x) => x.todosetId === Number(m?.[1]))
      if (!p) return reply(404, {})
      if (method === 'POST') {
        const l = this.list(p.id, String(b['name']))
        return reply(201, this.rawList(l))
      }
      return this.paged(call, [...this.lists.values()].filter((l) => l.projectId === p.id && l.status === 'active').map((l) => this.rawList(l)))
    }
    if ((m = /^\/todolists\/(\d+)\.json$/.exec(path)) && method === 'GET') {
      const l = this.lists.get(Number(m[1]))
      return l ? reply(200, this.rawList(l)) : reply(404, {})
    }
    if ((m = /^\/todolists\/(\d+)\/todos\.json$/.exec(path))) {
      const listId = Number(m[1])
      if (!this.lists.has(listId)) return reply(404, {})
      if (method === 'POST') {
        const t = this.addTodo(listId, this.todoFields(b, true) as FakeTodo)
        t.creatorId = me
        return reply(201, this.rawTodo(t, { position: true, steps: true }))
      }
      const completed = call.query.get('completed') === 'true'
      const all = [...this.todos.values()]
        .filter((t) => t.listId === listId && t.status === 'active' && t.completed === completed)
        .sort((x, y) => x.position - y.position)
      return this.paged(
        call,
        all.map((t) => this.rawTodo(t, { position: true, steps: false })),
      )
    }

    // To-dos
    if ((m = /^\/todos\/(\d+)\.json$/.exec(path))) {
      const t = this.todos.get(Number(m[1]))
      if (!t) return reply(404, {})
      if (method === 'GET') return reply(200, this.rawTodo(t, { position: false, steps: true }))
      if (method === 'PUT') {
        // todos.md: every omitted field is cleared.
        Object.assign(t, this.todoFields(b, false))
        t.updatedAt = this.tick()
        return reply(200, this.rawTodo(t, { position: false, steps: true }))
      }
    }
    if ((m = /^\/todos\/(\d+)\/completion\.json$/.exec(path))) {
      const t = this.todos.get(Number(m[1]))
      if (!t) return reply(404, {})
      t.completed = method === 'POST'
      t.updatedAt = this.tick()
      return new Response(null, { status: 204 })
    }
    if ((m = /^\/todos\/(\d+)\/position\.json$/.exec(path)) && method === 'PUT') {
      const t = this.todos.get(Number(m[1]))
      if (!t) return reply(404, {})
      if (b['parent_id'] !== undefined) t.listId = Number(b['parent_id'])
      t.position = Number(b['position'])
      t.updatedAt = this.tick()
      return new Response(null, { status: 204 })
    }
    if ((m = /^\/recordings\/(\d+)\/status\/(trashed|active|archived)\.json$/.exec(path)) && method === 'PUT') {
      const t = this.todos.get(Number(m[1]))
      if (!t) return reply(404, {})
      t.status = m[2] as FakeTodo['status']
      t.updatedAt = this.tick()
      return new Response(null, { status: 204 })
    }

    // Subtasks
    if ((m = /^\/recordings\/(\d+)\/subtasks\.json$/.exec(path))) {
      const todoId = Number(m[1])
      if (!this.todos.has(todoId)) return reply(404, {})
      if (method === 'POST') {
        const s = this.addSubtask(todoId, {
          title: String(b['title']),
          assigneeIds: (b['assignee_ids'] as number[]) ?? [],
          dueOn: (b['due_on'] as string | undefined) ?? null,
          creatorId: me,
        })
        return reply(201, this.rawSubtask(s))
      }
      return this.paged(
        call,
        this.subtasksOf(todoId).map((s) => this.rawSubtask(s)),
      )
    }
    if ((m = /^\/subtasks\/(\d+)\.json$/.exec(path))) {
      const s = this.subtasks.get(Number(m[1]))
      if (!s) return reply(404, {})
      if (method === 'GET') return reply(200, this.rawSubtask(s))
      if (method === 'PUT') {
        // subtasks.md: partial.
        if ('title' in b) s.title = String(b['title'])
        if ('due_on' in b) s.dueOn = (b['due_on'] as string | null) ?? null
        if ('assignee_ids' in b) s.assigneeIds = b['assignee_ids'] as number[]
        s.updatedAt = this.tick()
        return reply(200, this.rawSubtask(s))
      }
      if (method === 'DELETE') {
        if (this.beforeSubtaskDelete) await this.beforeSubtaskDelete(s.id)
        this.subtasks.delete(s.id)
        return new Response(null, { status: 204 })
      }
    }
    if ((m = /^\/subtasks\/(\d+)\/completion\.json$/.exec(path))) {
      const s = this.subtasks.get(Number(m[1]))
      if (!s) return reply(404, {})
      s.completed = method === 'POST'
      s.updatedAt = this.tick()
      return new Response(null, { status: 204 })
    }
    if ((m = /^\/subtasks\/(\d+)\/position\.json$/.exec(path)) && method === 'PUT') {
      const s = this.subtasks.get(Number(m[1]))
      if (!s) return reply(404, {})
      s.position = Number(b['position'])
      return new Response(null, { status: 204 })
    }

    // Comments (comments.md)
    if ((m = /^\/recordings\/(\d+)\/comments\.json$/.exec(path))) {
      const todo = this.todos.get(Number(m[1]))
      if (!todo) return reply(404, {})
      const project = this.projects.get(todo.bucketId)
      if (project && !project.peopleIds.has(me)) return reply(404, {})
      if (method === 'POST') {
        if (todo.status === 'trashed') return reply(422, {})
        const c = this.addComment(todo.id, String(b['content'] ?? ''), me)
        return reply(201, this.rawComment(c))
      }
      return this.paged(call, this.commentsOf(todo.id).map((c) => this.rawComment(c)))
    }
    if ((m = /^\/comments\/(\d+)\.json$/.exec(path)) && method === 'GET') {
      const c = this.comments.get(Number(m[1]))
      return c ? reply(200, this.rawComment(c)) : reply(404, {})
    }

    // Webhooks
    if ((m = /^\/buckets\/(\d+)\/webhooks\.json$/.exec(path))) {
      const projectId = Number(m[1])
      if (!this.projects.has(projectId)) return reply(404, {})
      if (method === 'POST') {
        const h: FakeWebhook = { id: uniqueId(), projectId, payloadUrl: String(b['payload_url']), types: b['types'] as string[], active: true }
        this.webhooks.set(h.id, h)
        return reply(201, this.rawWebhook(h))
      }
      return this.paged(call, [...this.webhooks.values()].filter((h) => h.projectId === projectId).map((h) => this.rawWebhook(h)))
    }
    if ((m = /^\/webhooks\/(\d+)\.json$/.exec(path))) {
      const h = this.webhooks.get(Number(m[1]))
      if (!h) return reply(404, {})
      if (method === 'GET') return reply(200, this.rawWebhook(h))
      if (method === 'PUT') {
        h.payloadUrl = String(b['payload_url'])
        h.types = b['types'] as string[]
        h.active = b['active'] === true
        return reply(200, this.rawWebhook(h))
      }
    }
    return reply(404, {})
  }

  /** PUT clears omitted fields; POST leaves them empty. */
  private todoFields(b: Record<string, unknown>, create: boolean): Partial<FakeTodo> {
    void create
    return {
      content: String(b['content'] ?? ''),
      description: typeof b['description'] === 'string' ? (b['description'] as string) : '',
      assigneeIds: Array.isArray(b['assignee_ids']) ? (b['assignee_ids'] as number[]) : [],
      completionSubscriberIds: Array.isArray(b['completion_subscriber_ids']) ? (b['completion_subscriber_ids'] as number[]) : [],
      dueOn: typeof b['due_on'] === 'string' ? (b['due_on'] as string) : null,
      startsOn: typeof b['starts_on'] === 'string' ? (b['starts_on'] as string) : null,
    }
  }

  rawComment(c: FakeComment): Record<string, unknown> {
    const todo = this.todos.get(c.todoId)
    return {
      id: c.id,
      status: c.status,
      type: 'Comment',
      created_at: c.createdAt,
      updated_at: c.createdAt,
      title: `Re: ${todo?.content ?? ''}`,
      content: c.content,
      content_attachments: this.descriptionAttachments(c.content),
      parent: { id: c.todoId, title: todo?.content ?? '', type: 'Todo', url: '', app_url: '' },
      bucket: { id: c.bucketId, name: 'مشروع', type: 'Project' },
      creator: { ...this.personRef(c.creatorId), avatar_url: `${this.apiBase}/people/${c.creatorId}/avatar` },
      url: `${this.apiBase}/comments/${c.id}.json`,
      app_url: `https://3.basecamp.com/${this.accountId}/buckets/${c.bucketId}/todos/${c.todoId}#__recording_${c.id}`,
    }
  }

  /** GET of a stored file: the token is required; recorded like any call. */
  private download(url: string, method: string, headers: Record<string, string>): Response {
    const token = (headers['authorization'] ?? '').replace(/^Bearer /, '')
    const u = new URL(url)
    this.calls.push({ method, path: u.pathname, query: u.searchParams, token, body: null, headers })
    if (method !== 'GET') return reply(405, {})
    const me = this.tokens.get(token)
    if (me === undefined) return reply(401, { error: 'unauthorized' })
    const key = /\/blobs\/([^/]+)\//.exec(u.pathname)?.[1]
    const b = [...this.blobs.values()].find((x) => x.key === key)
    if (!b) return reply(404, {})
    return new Response(b.bytes, { status: 200, headers: { 'content-type': b.contentType, 'content-length': String(b.bytes.byteLength) } })
  }

  private rawProject(id: number): Record<string, unknown> {
    const p = this.projects.get(id) as { id: number; name: string; todosetId: number }
    return {
      id: p.id,
      status: 'active',
      name: p.name,
      description: null,
      dock: [{ id: p.todosetId, title: 'To-dos', name: 'todoset', enabled: true, position: 1, url: '', app_url: '' }],
      url: '',
      app_url: '',
      created_at: '',
      updated_at: '',
    }
  }

  private rawList(l: FakeList): Record<string, unknown> {
    return {
      id: l.id,
      status: l.status,
      type: 'Todolist',
      title: l.name,
      name: l.name,
      description: '',
      completed: false,
      parent: { id: 0, title: '', type: 'Todoset', url: '', app_url: '' },
      bucket: { id: l.projectId, name: 'مشروع', type: 'Project' },
      todos_url: '',
      url: '',
      app_url: '',
      created_at: '',
      updated_at: '',
    }
  }

  private rawPerson(id: number): Record<string, unknown> {
    const p = this.people.get(id)
    return { id, name: p?.name ?? `شخص ${id}`, personable_type: 'User', email_address: p?.email_address ?? null, admin: p?.admin ?? false, client: false }
  }

  private rawWebhook(h: FakeWebhook): Record<string, unknown> {
    return { id: h.id, active: h.active, payload_url: h.payloadUrl, types: h.types, url: '', app_url: '', created_at: '', updated_at: '' }
  }
}

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } })
}

function hashText(text: string): string {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return (h >>> 0).toString(16)
}
