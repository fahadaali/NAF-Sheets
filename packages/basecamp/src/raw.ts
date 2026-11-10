// Wire shapes returned by Basecamp (snake_case, as documented in
// github.com/basecamp/bc-api sections/*.md, read 2026-11-10).
//
// Only the fields the platform reads are typed; every object may carry more.
// To-dos and subtasks are normalised into the shared `RemoteTodo` /
// `RemoteSubtask` (normalise.ts); the other resources are returned as-is.

export type RawRecordingStatus = 'active' | 'archived' | 'trashed'

/** The minimal parent reference every recording carries. */
export interface RawParentRef {
  id: number
  title: string
  type: string
  url: string
  app_url: string
}

export interface RawBucketRef {
  id: number
  name: string
  type: string
}

/**
 * A person (people.md "Get person"). `personable_type` is an open set
 * (User, Agent, Integration, Tombstone, …): never reject an unknown value.
 * `email_address` is redacted unless the caller is an admin/owner or the person.
 */
export interface RawPerson {
  id: number
  name: string
  personable_type?: string
  email_address?: string | null
  attachable_sgid?: string
  title?: string | null
  admin?: boolean
  owner?: boolean
  client?: boolean
  employee?: boolean
  avatar_url?: string
  company?: { id: number; name: string }
  [key: string]: unknown
}

/** todos.md "Get to-dos" / "Get a to-do". */
export interface RawTodo {
  id: number
  status: RawRecordingStatus
  type: 'Todo'
  created_at: string
  updated_at: string
  title: string
  content: string
  description: string
  description_attachments?: RawRichTextAttachment[]
  /** Present in list responses; absent from the documented single to-do example. */
  position?: number
  parent: RawParentRef
  bucket: RawBucketRef
  creator?: RawPerson
  completed: boolean
  starts_on: string | null
  due_on: string | null
  assignees: RawPerson[]
  completion_subscribers: RawPerson[]
  subtasks_count: number
  subtasks_completed_count: number
  subtasks_url?: string
  /** First 100 subtasks only, read-only; use the subtasks endpoint for all of them. */
  steps?: RawSubtask[]
  comments_count?: number
  url: string
  app_url: string
  [key: string]: unknown
}

/** subtasks.md: wire type `Kanban::Step`. */
export interface RawSubtask {
  id: number
  status: RawRecordingStatus
  type: 'Kanban::Step'
  created_at: string
  updated_at: string
  title: string
  position?: number
  parent: RawParentRef
  bucket: RawBucketRef
  creator?: RawPerson
  completed: boolean
  due_on: string | null
  assignees: RawPerson[]
  url: string
  app_url: string
  [key: string]: unknown
}

/** rich_text.md "Structured attachment metadata". */
export interface RawRichTextAttachment {
  id: number
  sgid: string
  filename: string
  content_type: string
  byte_size: number
  download_url: string
  [key: string]: unknown
}

/** projects.md "Get a project": one entry of `dock`. */
export interface RawDockItem {
  id: number
  title: string
  name: string
  enabled: boolean
  position: number | null
  url: string
  app_url: string
  [key: string]: unknown
}

export interface RawProject {
  id: number
  status: RawRecordingStatus
  name: string
  description: string | null
  clients_enabled?: boolean
  dock: RawDockItem[]
  url: string
  app_url: string
  created_at: string
  updated_at: string
  [key: string]: unknown
}

/** todolists.md "Get to-do lists" / "Get a to-do list". */
export interface RawTodolist {
  id: number
  status: RawRecordingStatus
  type: 'Todolist'
  title: string
  name: string
  description: string
  completed: boolean
  completed_ratio?: string
  position?: number
  parent: RawParentRef
  bucket: RawBucketRef
  creator?: RawPerson
  todos_url: string
  url: string
  app_url: string
  created_at: string
  updated_at: string
  [key: string]: unknown
}

/** webhooks.md "Get webhooks" / "Get a webhook". */
export interface RawWebhook {
  id: number
  active: boolean
  payload_url: string
  types: string[]
  url: string
  app_url: string
  created_at: string
  updated_at: string
  /** Only on `GET /webhooks/{id}.json`: up to 25 most recent deliveries, newest first. */
  recent_deliveries?: unknown[]
  [key: string]: unknown
}

/**
 * Body Basecamp POSTs to a webhook's payload URL (webhooks.md introduction).
 * It carries no signature and no `description` / `completed` / `assignees`:
 * always fetch the record (spec §9.3.2, §9.3.4).
 */
export interface RawWebhookEvent {
  id: number
  kind: string
  details: Record<string, unknown> | null
  created_at: string
  recording: {
    id: number
    status: RawRecordingStatus
    type: string
    title: string
    parent?: RawParentRef
    bucket: RawBucketRef
    creator?: RawPerson
    content?: string
    [key: string]: unknown
  }
  creator: RawPerson
  /** Present when an agent acted on the creator's behalf. */
  performed_by?: RawPerson
  /** Present on `*_copied` events. */
  copy?: { id: number; url: string; app_url: string; bucket: { id: number } }
  [key: string]: unknown
}

/** comments.md "Get comments" / "Get a comment". */
export interface RawComment {
  id: number
  status: RawRecordingStatus
  type: 'Comment'
  content: string
  content_attachments?: RawRichTextAttachment[]
  parent: RawParentRef
  bucket: RawBucketRef
  creator: RawPerson
  created_at: string
  updated_at: string
  url: string
  app_url: string
  [key: string]: unknown
}

/** attachments.md "Create an attachment". */
export interface RawAttachment {
  id?: number
  attachable_sgid: string
  sgid?: string
  filename?: string
  content_type?: string
  byte_size?: number
  download_url?: string
  [key: string]: unknown
}

/** people.md "Update who can access a project" / "Add and remove clients on a project". */
export interface RawProjectAccessResult {
  granted: RawPerson[]
  revoked: RawPerson[]
}

/** people.md "Enroll people": one entry per requested person, in request order. */
export type RawEnrollment = RawPerson & { status: 'created' | 'existing' }
