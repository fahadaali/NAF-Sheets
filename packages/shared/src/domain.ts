// Shared domain contract for NAF Sheets (spec: docs/spec.md §2, §6, §8, §9).
//
// This file is the boundary between packages: the sync engine produces
// `OutboundAction`s and `InboundAction`s from these shapes; the API executes
// them with the Basecamp client and the workbook room. Change it deliberately:
// every package compiles against it.

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Calendar date as Basecamp sends it: `YYYY-MM-DD`. */
export type IsoDate = string
/** Timestamp in ISO 8601 with offset, as Basecamp sends `updated_at`. */
export type IsoDateTime = string
/** Stable identity of a task row, kept in the hidden `__uid` column (§6.1). */
export type TaskUid = string

export type PlatformRole = 'admin' | 'editor' | 'viewer'
export type WorkbookMemberRole = 'editor' | 'viewer'
export type WorkbookSource = 'blank' | 'template' | 'gsheets'
export type SheetSyncMode = 'synced' | 'local'

/** What a sheet column maps to (§6.2 column_mappings.field). */
export type MappedField = 'title' | 'assignees' | 'due_on' | 'starts_on' | 'completed' | 'notes' | 'attachments' | 'free'

/** 0 = to-do (main row), 1 = subtask. Basecamp 5 allows exactly one level of subtasks (§8). */
export type TaskLevel = 0 | 1
export type BcType = 'todo' | 'subtask'
export type AssignMode = 'auto' | 'manual'
export type SyncState = 'synced' | 'pending' | 'error' | 'conflict' | 'unlinked'

// ---------------------------------------------------------------------------
// Assignees (§8.1, §8.2)
// ---------------------------------------------------------------------------

export type AssigneeSource = 'manual' | 'auto'

export type Assignee =
  /** A person in Basecamp; goes to `assignee_ids`. */
  | { kind: 'bc_person'; bcPersonId: number; source: AssigneeSource }
  /** Someone outside Basecamp; never sent as an assignee, written in the managed block. */
  | { kind: 'external'; externalContactId: string; source: AssigneeSource; notifyEmail: boolean }
  /** Internal follower required when only externals are assigned; sent in `assignee_ids`. */
  | { kind: 'follower'; bcPersonId: number; source: AssigneeSource }

export interface ExternalContact {
  id: string
  name: string
  organization: string | null
  email: string | null
  phone: string | null
}

// ---------------------------------------------------------------------------
// Local side: a task row as the platform holds it
// ---------------------------------------------------------------------------

export interface AttachmentRef {
  id: string
  filename: string
  /** Set once uploaded to Basecamp (bc-attachment sgid). */
  bcSgid: string | null
  origin: 'local' | 'basecamp'
}

export interface LocalTask {
  uid: TaskUid
  sheetId: string
  parentUid: TaskUid | null
  level: TaskLevel
  /** 1-based order among siblings: within the sheet for level 0, within the parent for level 1. */
  position: number
  title: string
  assignees: Assignee[]
  dueOn: IsoDate | null
  /** Level 0 only; subtasks keep it locally (§8 table). */
  startsOn: IsoDate | null
  completed: boolean
  /** Human-written part of the description (HTML), level 0 only. Never contains the managed block. */
  notesHtml: string | null
  /** Free columns whose mapping says "append to the description" (§7.3 step 4): header → value. */
  freeColumnsForDescription: Record<string, string>
  attachments: AttachmentRef[]
  /** Level 0 only (§8.1). */
  assignMode: AssignMode
  /** When the platform last changed any synced field of this row. */
  localChangedAt: IsoDateTime | null
}

// ---------------------------------------------------------------------------
// Remote side: Basecamp records normalised (Appendix A)
// ---------------------------------------------------------------------------

export type RecordingStatus = 'active' | 'archived' | 'trashed'

export interface RemoteTodo {
  type: 'todo'
  id: number
  /** The to-do list (sheet) it belongs to: `parent.id`. */
  listId: number
  bucketId: number
  position: number
  content: string
  /** Full description HTML as Basecamp returns it, managed block included. */
  descriptionHtml: string
  assigneeIds: number[]
  completionSubscriberIds: number[]
  dueOn: IsoDate | null
  startsOn: IsoDate | null
  completed: boolean
  status: RecordingStatus
  updatedAt: IsoDateTime
  subtasksCount: number
  subtasksCompletedCount: number
  creatorId: number | null
}

export interface RemoteSubtask {
  type: 'subtask'
  id: number
  /** The to-do it belongs to: `parent.id`. */
  todoId: number
  position: number
  title: string
  assigneeIds: number[]
  dueOn: IsoDate | null
  completed: boolean
  updatedAt: IsoDateTime
}

export type RemoteTask = RemoteTodo | RemoteSubtask

/** Values of the synced fields at the last successful sync, per task (3-way diff base). */
export interface SyncedBase {
  uid: TaskUid
  bcType: BcType
  bcId: number
  title: string
  bcAssigneeIds: number[]
  dueOn: IsoDate | null
  startsOn: IsoDate | null
  completed: boolean
  notesHtml: string | null
  managedBlockHtml: string | null
  position: number
  /** Remote `updated_at` seen at that sync. */
  remoteUpdatedAt: IsoDateTime
  /** Hash of the synced fields as last written/read; echo suppression (§9.1). */
  hash: string
}

// ---------------------------------------------------------------------------
// Actions: produced by @naf-sheets/sync-engine, executed by the API
// ---------------------------------------------------------------------------

/**
 * Body of `POST /todolists/{id}/todos.json` and `PUT /todos/{id}.json`.
 * PUT clears every omitted field, so this type has no optional fields:
 * an update always carries the complete state (§9.2.4).
 */
export interface TodoWrite {
  content: string
  descriptionHtml: string
  assigneeIds: number[]
  completionSubscriberIds: number[]
  dueOn: IsoDate | null
  startsOn: IsoDate | null
  notify: boolean
}

export interface SubtaskCreate {
  title: string
  dueOn: IsoDate | null
  assigneeIds: number[]
}

/** `PUT /subtasks/{id}.json` is partial: only changed fields; `null` clears a date. */
export type SubtaskPatch = Partial<{ title: string; dueOn: IsoDate | null; assigneeIds: number[] }>

export type OutboundAction =
  | { type: 'create_todo'; uid: TaskUid; listId: number; write: TodoWrite; position: number }
  | { type: 'update_todo'; uid: TaskUid; todoId: number; write: TodoWrite }
  | { type: 'create_subtask'; uid: TaskUid; parentTodoId: number; create: SubtaskCreate; position: number }
  | { type: 'update_subtask'; uid: TaskUid; subtaskId: number; patch: SubtaskPatch }
  | { type: 'set_completion'; uid: TaskUid; bcType: BcType; bcId: number; completed: boolean }
  /** Position is 1-based. `listId` moves a to-do to another list in the same project. */
  | { type: 'reposition'; uid: TaskUid; bcType: BcType; bcId: number; position: number; listId?: number }
  /** To-dos go to the trash (recoverable). */
  | { type: 'trash_todo'; uid: TaskUid; todoId: number }
  /** Subtask deletion is permanent in Basecamp: the full record travels with the action (§9.2.7). */
  | { type: 'delete_subtask'; uid: TaskUid; subtaskId: number; snapshot: RemoteSubtask }

export type InboundAction =
  | { type: 'create_row'; task: LocalTask; remote: RemoteTask }
  | { type: 'update_row'; uid: TaskUid; fields: Partial<Pick<LocalTask, 'title' | 'assignees' | 'dueOn' | 'startsOn' | 'completed' | 'notesHtml' | 'position'>> }
  /** Shown struck through and grey; removed from the sheet only by a user (§9.3.10). */
  | { type: 'mark_deleted_remotely'; uid: TaskUid; status: Exclude<RecordingStatus, 'active'> | 'deleted' }
  | { type: 'restore_row'; uid: TaskUid }
  | { type: 'move_row'; uid: TaskUid; toListId: number | null; position: number }
  /** The managed block was edited in Basecamp: rewrite it from the platform and log it (§8.2). */
  | { type: 'rewrite_managed_block'; uid: TaskUid }

/** A field changed on both sides since the last sync (§9.1): last writer wins, and it is logged. */
export interface FieldConflict {
  uid: TaskUid
  field: 'title' | 'assignees' | 'dueOn' | 'startsOn' | 'completed' | 'notesHtml'
  localValue: unknown
  remoteValue: unknown
  winner: 'local' | 'remote'
  localChangedAt: IsoDateTime | null
  remoteUpdatedAt: IsoDateTime
}
