// Typed Basecamp 5 client (spec §3, §9.2–§9.5, §10, Appendix A).
//
// Every method takes the access token of the person on whose behalf it runs
// as its first argument. There is no ambient token: writes go out with the
// acting user's own token (spec §3); the service token is passed explicitly by
// the few background callers allowed to use it (webhooks, read-only
// reconciliation, member caches).
//
// Each endpoint was checked against github.com/basecamp/bc-api (master,
// sections/<name>.md, read 2026-11-10); the section is cited above each one.

import type { IsoDate, RemoteSubtask, RemoteTodo, SubtaskCreate, SubtaskPatch, TodoWrite } from '@naf-sheets/shared'
import {
  type Conditional,
  type ConditionalCache,
  DEFAULT_RETRY_POLICY,
  type FetchLike,
  HttpCore,
  type RetryPolicy,
} from './http'
import { defaultSleep, type RateLimiter } from './limiter'
import { normaliseSubtask, normaliseTodo } from './normalise'
import type { Paged } from './pagination'
import type {
  RawAttachment,
  RawComment,
  RawEnrollment,
  RawPerson,
  RawProject,
  RawProjectAccessResult,
  RawTodo,
  RawTodolist,
  RawWebhook,
} from './raw'

/** Spec §9.2.10: without a User-Agent naming the app and a contact, Basecamp answers 400. */
export const DEFAULT_USER_AGENT = 'NAF Comms (info@naflaw.sa)'

/** Webhook types the platform subscribes to (spec §9.3.1). Subtasks arrive as `Kanban::Step`. */
export const NAF_WEBHOOK_TYPES = ['Todo', 'Todolist', 'Kanban::Step', 'Comment', 'Upload'] as const

/** Every type webhooks.md lists. */
export type WebhookType =
  | 'Comment'
  | 'Client::Approval::Response'
  | 'Client::Forward'
  | 'Client::Reply'
  | 'CloudFile'
  | 'Document'
  | 'GoogleDocument'
  | 'Inbox::Forward'
  | 'Kanban::Card'
  | 'Kanban::Step'
  | 'Message'
  | 'Question'
  | 'Question::Answer'
  | 'Schedule::Entry'
  | 'Todo'
  | 'Todolist'
  | 'Upload'
  | 'Vault'

export interface BasecampClientOptions {
  accountId: number | string
  /** The platform `fetch`, or a fake in tests. The client does no other IO. */
  fetch: FetchLike
  /** Defaults to `DEFAULT_USER_AGENT`. */
  userAgent?: string
  /** One limiter per Worker isolate, shared by every client built there. */
  limiter: RateLimiter
  /** Enables conditional GET for calls that pass a `cacheScope`. */
  cache?: ConditionalCache
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  retry?: Partial<RetryPolicy>
}

export interface TodoListFilter {
  /** `?completed=true`: only completed to-dos. Without it Basecamp returns pending ones only. */
  completed?: boolean
  /** `?status=archived|trashed`: archived or trashed to-dos, pending and completed. */
  status?: 'archived' | 'trashed'
}

export interface NewPerson {
  name: string
  emailAddress: string
  title?: string
  companyName?: string
}

export interface ProjectAccessChange {
  grant?: number[]
  revoke?: number[]
  create?: NewPerson[]
}

export interface EnrollmentRequest {
  people: NewPerson[]
  projectIds?: number[]
  /** Basecamp's default is true (invitation emails). */
  notify?: boolean
}

export interface NewClient {
  emailAddress: string
  name?: string
  title?: string
  companyName?: string
}

export interface ClientUsersChange {
  grant?: number[]
  revoke?: number[]
  create?: NewClient[]
}

export interface WebhookCreate {
  /** Must be HTTPS. */
  payloadUrl: string
  types: readonly WebhookType[]
}

/**
 * OPEN: webhooks.md does not say whether `PUT /webhooks/{id}.json` is partial,
 * so every field is required and always sent (see OPEN_QUESTIONS.md).
 */
export interface WebhookUpdate {
  payloadUrl: string
  types: readonly WebhookType[]
  active: boolean
}

export interface AttachmentUpload {
  /** File name, sent as `?name=`. */
  name: string
  /** The file's own media type (attachments.md requires it; not JSON). */
  contentType: string
  data: ArrayBuffer | Uint8Array
}

export type BasecampClient = ReturnType<typeof createBasecampClient>

// ---------------------------------------------------------------------------
// Request bodies (pure, exported for tests and for hashing what is sent)
// ---------------------------------------------------------------------------

/**
 * Body of `POST /todolists/{id}/todos.json` and `PUT /todos/{id}.json`.
 * The PUT clears every omitted field (todos.md "Update a to-do"), so all six
 * synced fields are always present; null dates are sent as null.
 * OPEN: the docs say omission clears a field but never show `"due_on": null`
 * on this endpoint; the live test must confirm null is accepted. See OPEN_QUESTIONS.md.
 */
export function todoWriteBody(write: TodoWrite): Record<string, unknown> {
  assertCompleteTodoWrite(write)
  return {
    content: write.content,
    description: write.descriptionHtml,
    assignee_ids: [...write.assigneeIds],
    completion_subscriber_ids: [...write.completionSubscriberIds],
    due_on: write.dueOn,
    starts_on: write.startsOn,
    notify: write.notify,
  }
}

/** Body of `POST /recordings/{id}/subtasks.json` (subtasks.md "Create a subtask"). */
export function subtaskCreateBody(create: SubtaskCreate): Record<string, unknown> {
  if (typeof create.title !== 'string' || create.title === '') throw new TypeError('subtask title is required')
  const body: Record<string, unknown> = { title: create.title, assignee_ids: ids('assigneeIds', create.assigneeIds) }
  if (create.dueOn !== null) body['due_on'] = isoDate('dueOn', create.dueOn)
  return body
}

/**
 * Body of `PUT /subtasks/{id}.json`, a partial update (subtasks.md "Update a
 * subtask"): only the fields present in the patch are sent. `dueOn: null`
 * clears the date; `assigneeIds: []` removes every assignee.
 */
export function subtaskPatchBody(patch: SubtaskPatch): Record<string, unknown> {
  const allowed = new Set(['title', 'dueOn', 'assigneeIds'])
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new TypeError(`subtasks have no field ${JSON.stringify(key)}`)
  }
  const body: Record<string, unknown> = {}
  if (patch.title !== undefined) {
    if (typeof patch.title !== 'string' || patch.title === '') throw new TypeError('subtask title cannot be blank')
    body['title'] = patch.title
  }
  if (patch.dueOn !== undefined) body['due_on'] = patch.dueOn === null ? null : isoDate('dueOn', patch.dueOn)
  if (patch.assigneeIds !== undefined) body['assignee_ids'] = ids('assigneeIds', patch.assigneeIds)
  if (Object.keys(body).length === 0) throw new TypeError('empty subtask patch: nothing to update')
  return body
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export function createBasecampClient(options: BasecampClientOptions) {
  const http = new HttpCore({
    accountId: options.accountId,
    fetch: options.fetch,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    limiter: options.limiter,
    cache: options.cache,
    sleep: options.sleep ?? defaultSleep,
    now: options.now ?? Date.now,
    retry: { ...DEFAULT_RETRY_POLICY, ...options.retry },
  })

  const recordings = {
    // recordings.md "Trash a recording": PUT /recordings/{id}/status/trashed.json → 204. Recoverable.
    trash: async (token: string, recordingId: number): Promise<void> =>
      http.none(token, { method: 'PUT', target: `/recordings/${id('recordingId', recordingId)}/status/trashed.json` }),
    // recordings.md "Archive a recording": PUT /recordings/{id}/status/archived.json → 204.
    archive: async (token: string, recordingId: number): Promise<void> =>
      http.none(token, { method: 'PUT', target: `/recordings/${id('recordingId', recordingId)}/status/archived.json` }),
    // recordings.md "Unarchive a recording": PUT /recordings/{id}/status/active.json → 204.
    // OPEN: documented as "unarchive"; that it also restores from the trash is
    // documented only for projects. See OPEN_QUESTIONS.md.
    restore: async (token: string, recordingId: number): Promise<void> =>
      http.none(token, { method: 'PUT', target: `/recordings/${id('recordingId', recordingId)}/status/active.json` }),
  }

  const projects = {
    // projects.md "Get all projects": GET /projects.json (paginated), optional ?status=.
    list: (token: string, filter: { status?: 'active' | 'archived' | 'trashed' } = {}): Paged<RawProject> =>
      http.paged(token, '/projects.json', { status: filter.status }, asObject<RawProject>),
    // projects.md "Get a project": GET /projects/{id}.json; tools are in `dock`.
    get: async (token: string, projectId: number): Promise<RawProject> =>
      http.parse(token, { method: 'GET', target: `/projects/${id('projectId', projectId)}.json` }, asObject<RawProject>),
    // projects.md "Create a project": POST /projects.json → 201; 507 when the account's project limit is reached.
    create: async (token: string, input: { name: string; description?: string }): Promise<RawProject> => {
      if (typeof input.name !== 'string' || input.name.trim() === '') throw new TypeError('project name is required')
      const json: Record<string, unknown> = { name: input.name }
      if (input.description !== undefined) json['description'] = input.description
      return http.parse(token, { method: 'POST', target: '/projects.json', json }, asObject<RawProject>)
    },
    /** The project's enabled to-do set from `dock` (README "The dock"), or null when it is off. */
    findTodosetId,
    getTodosetId: async (token: string, projectId: number): Promise<number | null> =>
      findTodosetId(await projects.get(token, projectId)),
  }

  const todolists = {
    // todolists.md "Get to-do lists": GET /todosets/{id}/todolists.json (paginated), optional ?status=.
    list: (token: string, todosetId: number, filter: { status?: 'archived' | 'trashed' } = {}): Paged<RawTodolist> =>
      http.paged(token, `/todosets/${id('todosetId', todosetId)}/todolists.json`, { status: filter.status }, asObject<RawTodolist>),
    // todolists.md "Get a to-do list": GET /todolists/{id}.json.
    get: async (token: string, todolistId: number): Promise<RawTodolist> =>
      http.parse(token, { method: 'GET', target: `/todolists/${id('todolistId', todolistId)}.json` }, asObject<RawTodolist>),
    // todolists.md "Create a to-do list": POST /todosets/{id}/todolists.json → 201; `name` required.
    create: async (token: string, todosetId: number, input: { name: string; descriptionHtml?: string }): Promise<RawTodolist> => {
      if (typeof input.name !== 'string' || input.name.trim() === '') throw new TypeError('to-do list name is required')
      const json: Record<string, unknown> = { name: input.name }
      if (input.descriptionHtml !== undefined) json['description'] = input.descriptionHtml
      return http.parse(token, { method: 'POST', target: `/todosets/${id('todosetId', todosetId)}/todolists.json`, json }, asObject<RawTodolist>)
    },
  }

  const todos = {
    // todos.md "Get to-dos": GET /todolists/{id}/todos.json (paginated). Without
    // parameters: active, pending only; ?completed=true; ?status=archived|trashed.
    list: (token: string, todolistId: number, filter: TodoListFilter = {}): Paged<RemoteTodo> =>
      http.paged(token, `/todolists/${id('todolistId', todolistId)}/todos.json`, todoQuery(filter), normaliseTodo),
    /**
     * Same list with conditional GET per page (spec §9.4). `cacheScope` keeps
     * cached copies apart per caller identity (e.g. "service"); never a token.
     */
    listIfChanged: async (
      token: string,
      todolistId: number,
      options: TodoListFilter & { cacheScope: string },
    ): Promise<Conditional<RemoteTodo[]>> => {
      return http.collectIfChanged(token, `/todolists/${id('todolistId', todolistId)}/todos.json`, options.cacheScope, todoQuery(options), normaliseTodo)
    },
    // todos.md "Get a to-do": GET /todos/{id}.json.
    get: async (token: string, todoId: number): Promise<RemoteTodo> =>
      http.parse(token, { method: 'GET', target: `/todos/${id('todoId', todoId)}.json` }, normaliseTodo),
    /** The full wire shape (description_attachments, steps, subtasks_url…). */
    getRaw: async (token: string, todoId: number): Promise<RawTodo> =>
      http.parse(token, { method: 'GET', target: `/todos/${id('todoId', todoId)}.json` }, asObject<RawTodo>),
    // todos.md "Create a to-do": POST /todolists/{id}/todos.json → 201; 422 if the list is trashed.
    create: async (token: string, todolistId: number, write: TodoWrite): Promise<RemoteTodo> =>
      http.parse(token, { method: 'POST', target: `/todolists/${id('todolistId', todolistId)}/todos.json`, json: todoWriteBody(write) }, normaliseTodo),
    // todos.md "Update a to-do": PUT /todos/{id}.json → 200. Omitted fields are
    // CLEARED, so `write` is a complete `TodoWrite` (no optional fields) and
    // every field is sent.
    update: async (token: string, todoId: number, write: TodoWrite): Promise<RemoteTodo> =>
      http.parse(token, { method: 'PUT', target: `/todos/${id('todoId', todoId)}.json`, json: todoWriteBody(write) }, normaliseTodo),
    // todos.md "Complete a to-do": POST /todos/{id}/completion.json → 204.
    complete: async (token: string, todoId: number): Promise<void> =>
      http.none(token, { method: 'POST', target: `/todos/${id('todoId', todoId)}/completion.json` }),
    // todos.md "Uncomplete a to-do": DELETE /todos/{id}/completion.json → 204.
    uncomplete: async (token: string, todoId: number): Promise<void> =>
      http.none(token, { method: 'DELETE', target: `/todos/${id('todoId', todoId)}/completion.json` }),
    /**
     * todos.md "Reposition a to-do": PUT /todos/{id}/position.json → 204.
     * `position` is 1-based. `toTodolistId` moves it into another list of the
     * same project (keeps its id); another project answers 422.
     */
    reposition: async (token: string, todoId: number, position: number, toTodolistId?: number): Promise<void> => {
      const json: Record<string, unknown> = { position: oneBased(position) }
      if (toTodolistId !== undefined) json['parent_id'] = id('toTodolistId', toTodolistId)
      return http.none(token, { method: 'PUT', target: `/todos/${id('todoId', todoId)}/position.json`, json })
    },
    /** Moves the to-do to the trash, recoverable (todos.md "Trash a to-do" → recordings.md). */
    trash: async (token: string, todoId: number): Promise<void> => recordings.trash(token, todoId),
    /**
     * Brings a trashed to-do back, with its subtasks (the `untrash_todo` action,
     * spec §16 scenario 3): PUT /recordings/{id}/status/active.json → 204.
     * OPEN: documented as "unarchive"; restoring from the trash with it is
     * documented only for projects. See OPEN_QUESTIONS.md #10.
     */
    untrash: async (token: string, todoId: number): Promise<void> => recordings.restore(token, todoId),
  }

  const subtasks = {
    // subtasks.md "Get a recording's subtasks": GET /recordings/{id}/subtasks.json (paginated, position order).
    list: (token: string, todoId: number): Paged<RemoteSubtask> =>
      http.paged(token, `/recordings/${id('todoId', todoId)}/subtasks.json`, undefined, normaliseSubtask),
    // subtasks.md "Get a subtask": GET /subtasks/{id}.json.
    get: async (token: string, subtaskId: number): Promise<RemoteSubtask> =>
      http.parse(token, { method: 'GET', target: `/subtasks/${id('subtaskId', subtaskId)}.json` }, normaliseSubtask),
    // subtasks.md "Create a subtask": POST /recordings/{id}/subtasks.json → 201.
    create: async (token: string, todoId: number, create: SubtaskCreate): Promise<RemoteSubtask> =>
      http.parse(token, { method: 'POST', target: `/recordings/${id('todoId', todoId)}/subtasks.json`, json: subtaskCreateBody(create) }, normaliseSubtask),
    // subtasks.md "Update a subtask": PUT /subtasks/{id}.json → 200, partial.
    update: async (token: string, subtaskId: number, patch: SubtaskPatch): Promise<RemoteSubtask> =>
      http.parse(token, { method: 'PUT', target: `/subtasks/${id('subtaskId', subtaskId)}.json`, json: subtaskPatchBody(patch) }, normaliseSubtask),
    // subtasks.md "Complete a subtask": POST /subtasks/{id}/completion.json → 204.
    complete: async (token: string, subtaskId: number): Promise<void> =>
      http.none(token, { method: 'POST', target: `/subtasks/${id('subtaskId', subtaskId)}/completion.json` }),
    // subtasks.md "Uncomplete a subtask": DELETE /subtasks/{id}/completion.json → 204.
    uncomplete: async (token: string, subtaskId: number): Promise<void> =>
      http.none(token, { method: 'DELETE', target: `/subtasks/${id('subtaskId', subtaskId)}/completion.json` }),
    // subtasks.md "Reposition a subtask": PUT /subtasks/{id}/position.json → 204, 1-based, within its to-do.
    reposition: async (token: string, subtaskId: number, position: number): Promise<void> =>
      http.none(token, { method: 'PUT', target: `/subtasks/${id('subtaskId', subtaskId)}/position.json`, json: { position: oneBased(position) } }),
    /**
     * subtasks.md "Delete a subtask": DELETE /subtasks/{id}.json → 204.
     * PERMANENT: there is no trash for subtasks (spec §9.2.7). The caller must
     * pass the snapshot it saved before deleting; it is checked, not sent.
     * 403 where deleting is limited to admins and the creator.
     */
    deletePermanently: async (token: string, subtaskId: number, snapshot: RemoteSubtask): Promise<void> => {
      const sid = id('subtaskId', subtaskId)
      if (!snapshot || snapshot.type !== 'subtask' || snapshot.id !== sid) {
        throw new TypeError('a snapshot of this subtask must be saved before it is permanently deleted')
      }
      return http.none(token, { method: 'DELETE', target: `/subtasks/${sid}.json` })
    },
  }

  const webhooks = {
    // webhooks.md "Get webhooks": GET /buckets/{project_id}/webhooks.json (project-scoped only).
    list: (token: string, projectId: number): Paged<RawWebhook> =>
      http.paged(token, `/buckets/${id('projectId', projectId)}/webhooks.json`, undefined, asObject<RawWebhook>),
    // webhooks.md "Create a webhook": POST /buckets/{project_id}/webhooks.json → 201;
    // 400 for a non-HTTPS URL; 507 at the account's webhook limit.
    create: async (token: string, projectId: number, input: WebhookCreate): Promise<RawWebhook> =>
      http.parse(token, {
          method: 'POST',
          target: `/buckets/${id('projectId', projectId)}/webhooks.json`,
          json: { payload_url: httpsUrl(input.payloadUrl), types: webhookTypes(input.types) },
        }, asObject<RawWebhook>),
    // webhooks.md "Get a webhook": GET /webhooks/{id}.json, with up to 25 recent deliveries.
    get: async (token: string, webhookId: number): Promise<RawWebhook> =>
      http.parse(token, { method: 'GET', target: `/webhooks/${id('webhookId', webhookId)}.json` }, asObject<RawWebhook>),
    // webhooks.md "Update a webhook": PUT /webhooks/{id}.json → 200. Also re-activates (spec §9.3.3).
    update: async (token: string, webhookId: number, input: WebhookUpdate): Promise<RawWebhook> => {
      if (typeof input.active !== 'boolean') throw new TypeError('webhook update needs `active`')
      return http.parse(token, {
          method: 'PUT',
          target: `/webhooks/${id('webhookId', webhookId)}.json`,
          json: { payload_url: httpsUrl(input.payloadUrl), types: webhookTypes(input.types), active: input.active },
        }, asObject<RawWebhook>)
    },
    // webhooks.md "Destroy a webhook": DELETE /webhooks/{id}.json → 204.
    delete: async (token: string, webhookId: number): Promise<void> =>
      http.none(token, { method: 'DELETE', target: `/webhooks/${id('webhookId', webhookId)}.json` }),
  }

  const people = {
    // people.md "Get people on a project": GET /projects/{id}/people.json.
    listProject: (token: string, projectId: number): Paged<RawPerson> =>
      http.paged(token, `/projects/${id('projectId', projectId)}/people.json`, undefined, asObject<RawPerson>),
    // people.md "Get all people": GET /people.json. Emails are redacted unless the caller is an admin/owner.
    listAll: (token: string): Paged<RawPerson> => http.paged(token, '/people.json', undefined, asObject<RawPerson>),
    // people.md "Get my personal info": GET /my/profile.json.
    me: async (token: string): Promise<RawPerson> =>
      http.parse(token, { method: 'GET', target: '/my/profile.json' }, asObject<RawPerson>),
    // people.md "Update who can access a project": PUT /projects/{id}/people/users.json.
    updateProjectAccess: async (token: string, projectId: number, change: ProjectAccessChange): Promise<RawProjectAccessResult> =>
      http.parse(token, {
          method: 'PUT',
          target: `/projects/${id('projectId', projectId)}/people/users.json`,
          json: accessBody(change.grant, change.revoke, change.create?.map(newPersonBody)),
        }, asAccessResult),
    // people.md "Enroll people": POST /account/enrollments/people.json → 201, all-or-nothing;
    // 403 without people-management rights; 422 per-entry errors; 507 at the user limit.
    enroll: async (token: string, request: EnrollmentRequest): Promise<RawEnrollment[]> => {
      if (!Array.isArray(request.people) || request.people.length === 0) throw new TypeError('enroll needs at least one person')
      const json: Record<string, unknown> = { people: request.people.map(newPersonBody) }
      if (request.projectIds !== undefined) json['project_ids'] = ids('projectIds', request.projectIds)
      if (request.notify !== undefined) json['notify'] = request.notify
      return http.parse(token, { method: 'POST', target: '/account/enrollments/people.json', json }, asEnrollments)
    },
    // people.md "Add and remove clients on a project": PUT /projects/{id}/people/client_users.json.
    // 403 when clients are not enabled on the project (the platform never enables them itself, spec §8.2).
    // The docs give 429 for "would exceed the user limit": a 429 without
    // Retry-After is thrown as LimitReachedError, not retried. OPEN: see OPEN_QUESTIONS.md.
    updateClientUsers: async (token: string, projectId: number, change: ClientUsersChange): Promise<RawProjectAccessResult> =>
      http.parse(token, {
          method: 'PUT',
          target: `/projects/${id('projectId', projectId)}/people/client_users.json`,
          json: accessBody(change.grant, change.revoke, change.create?.map(newClientBody)),
          on429: 'retry-only-with-retry-after',
        }, asAccessResult),
  }

  const comments = {
    // comments.md "Get comments": GET /recordings/{id}/comments.json (paginated, active only).
    list: (token: string, recordingId: number): Paged<RawComment> =>
      http.paged(token, `/recordings/${id('recordingId', recordingId)}/comments.json`, undefined, asObject<RawComment>),
    // comments.md "Create a comment": POST /recordings/{id}/comments.json → 201; 422 if the recording is trashed.
    create: async (token: string, recordingId: number, contentHtml: string): Promise<RawComment> => {
      if (typeof contentHtml !== 'string' || contentHtml.trim() === '') throw new TypeError('comment content is required')
      return http.parse(token, { method: 'POST', target: `/recordings/${id('recordingId', recordingId)}/comments.json`, json: { content: contentHtml } }, asObject<RawComment>)
    },
  }

  const attachments = {
    /**
     * attachments.md "Create an attachment": POST /attachments.json?name=… with
     * the raw bytes, the file's own Content-Type and Content-Length → 201 with
     * `attachable_sgid`, which goes into a `<bc-attachment sgid="…">` tag
     * (rich_text.md). OPEN: the spec's JSON Content-Type rule cannot apply
     * here; the docs win for this one endpoint. See OPEN_QUESTIONS.md.
     */
    upload: async (token: string, file: AttachmentUpload): Promise<{ attachableSgid: string; attachment: RawAttachment }> => {
      if (typeof file.name !== 'string' || file.name.trim() === '') throw new TypeError('attachment name is required')
      if (typeof file.contentType !== 'string' || !/^[\w.+-]+\/[\w.+-]+/.test(file.contentType)) {
        throw new TypeError('attachment contentType must be a media type such as image/png')
      }
      const data = file.data instanceof Uint8Array ? new Uint8Array(file.data).buffer : file.data
      const attachment = await http.parse(
        token,
        { method: 'POST', target: '/attachments.json', query: { name: file.name }, binary: { data, contentType: file.contentType } },
        asAttachment,
      )
      return { attachableSgid: attachment.attachable_sgid, attachment }
    },
  }

  return {
    baseUrl: http.baseUrl,
    projects,
    todolists,
    todos,
    subtasks,
    recordings,
    webhooks,
    people,
    comments,
    attachments,
    /** Generic access for endpoints not wrapped above. Paths are relative to the account. */
    http: {
      get: async (token: string, path: string, query?: Record<string, string | undefined>): Promise<unknown> =>
        http.json(token, { method: 'GET', target: relativePath(path), query }),
      getIfChanged: async (token: string, path: string, cacheScope: string, query?: Record<string, string | undefined>): Promise<Conditional<unknown>> =>
        http.getIfChanged(token, relativePath(path), cacheScope, query),
      paginate: (token: string, path: string, query?: Record<string, string | undefined>): Paged<unknown> =>
        http.paged(token, relativePath(path), query, (x) => x),
      collectIfChanged: async (token: string, path: string, cacheScope: string, query?: Record<string, string | undefined>): Promise<Conditional<unknown[]>> =>
        http.collectIfChanged(token, relativePath(path), cacheScope, query, (x) => x),
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The id of the project's enabled to-do set (`dock` entry named `todoset`).
 * Null when the tool is turned off. OPEN: the docs say exactly one per
 * project; more than one enabled is refused rather than guessed.
 */
export function findTodosetId(project: Pick<RawProject, 'dock'>): number | null {
  const dock = Array.isArray(project.dock) ? project.dock : []
  const enabled = dock.filter((tool) => tool && tool.name === 'todoset' && tool.enabled === true)
  if (enabled.length > 1) throw new TypeError('project has more than one enabled to-do set')
  const tool = enabled[0]
  return tool ? id('dock.todoset.id', tool.id) : null
}

function todoQuery(filter: TodoListFilter): Record<string, string | undefined> {
  if (filter.status !== undefined && filter.status !== 'archived' && filter.status !== 'trashed') {
    throw new TypeError('status must be archived or trashed')
  }
  return { completed: filter.completed === true ? 'true' : undefined, status: filter.status }
}

function assertCompleteTodoWrite(w: TodoWrite): void {
  if (typeof w !== 'object' || w === null) throw new TypeError('to-do write is required')
  if (typeof w.content !== 'string' || w.content.trim() === '') throw new TypeError('to-do content is required and cannot be blank')
  if (typeof w.descriptionHtml !== 'string') throw new TypeError('to-do write must carry descriptionHtml (use "" for none)')
  ids('assigneeIds', w.assigneeIds)
  ids('completionSubscriberIds', w.completionSubscriberIds)
  if (w.dueOn !== null) isoDate('dueOn', w.dueOn)
  if (w.startsOn !== null) isoDate('startsOn', w.startsOn)
  if (typeof w.notify !== 'boolean') throw new TypeError('to-do write must carry notify')
}

function id(name: string, value: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`)
  }
  return value
}

function ids(name: string, values: readonly number[]): number[] {
  if (!Array.isArray(values)) throw new TypeError(`${name} must be an array (use [] for none)`)
  return values.map((v, i) => id(`${name}[${i}]`, v))
}

function oneBased(position: number): number {
  if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 1) {
    throw new TypeError('position is 1-based: an integer >= 1')
  }
  return position
}

function isoDate(name: string, value: IsoDate): IsoDate {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError(`${name} must be YYYY-MM-DD or null`)
  return value
}

function httpsUrl(url: string): string {
  if (typeof url !== 'string' || !/^https:\/\/[^\s/]+/.test(url)) throw new TypeError('webhook payload URL must be HTTPS')
  return url
}

function webhookTypes(types: readonly WebhookType[]): string[] {
  if (!Array.isArray(types) || types.length === 0) throw new TypeError('webhook types must be a non-empty array')
  return [...types]
}

function relativePath(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw new TypeError('path must be relative to the account, starting with "/"')
  }
  return path
}

function asObject<T>(value: unknown): T {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Basecamp returned something other than a JSON object')
  }
  return value as T
}

function asEnrollments(value: unknown): RawEnrollment[] {
  if (!Array.isArray(value)) throw new TypeError('enrollment response must be a JSON array')
  return value.map(asObject<RawEnrollment>)
}

function asAttachment(value: unknown): RawAttachment {
  const a = asObject<RawAttachment>(value)
  if (typeof a.attachable_sgid !== 'string' || a.attachable_sgid === '') throw new TypeError('attachment response has no attachable_sgid')
  return a
}

function asAccessResult(value: unknown): RawProjectAccessResult {
  const r = asObject<Partial<RawProjectAccessResult>>(value)
  return { granted: Array.isArray(r.granted) ? r.granted : [], revoked: Array.isArray(r.revoked) ? r.revoked : [] }
}

function accessBody(grant?: number[], revoke?: number[], create?: Record<string, unknown>[]): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (grant !== undefined && grant.length > 0) body['grant'] = ids('grant', grant)
  if (revoke !== undefined && revoke.length > 0) body['revoke'] = ids('revoke', revoke)
  if (create !== undefined && create.length > 0) body['create'] = create
  if (Object.keys(body).length === 0) throw new TypeError('at least one of grant, revoke or create is required')
  return body
}

function newPersonBody(p: NewPerson): Record<string, unknown> {
  if (typeof p.name !== 'string' || p.name.trim() === '') throw new TypeError('name is required')
  if (typeof p.emailAddress !== 'string' || !p.emailAddress.includes('@')) throw new TypeError('emailAddress is required')
  const body: Record<string, unknown> = { name: p.name, email_address: p.emailAddress }
  if (p.title !== undefined) body['title'] = p.title
  if (p.companyName !== undefined) body['company_name'] = p.companyName
  return body
}

function newClientBody(c: NewClient): Record<string, unknown> {
  if (typeof c.emailAddress !== 'string' || !c.emailAddress.includes('@')) throw new TypeError('emailAddress is required')
  const body: Record<string, unknown> = { email_address: c.emailAddress }
  if (c.name !== undefined) body['name'] = c.name
  if (c.title !== undefined) body['title'] = c.title
  if (c.companyName !== undefined) body['company_name'] = c.companyName
  return body
}
