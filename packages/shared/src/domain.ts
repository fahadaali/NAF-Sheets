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
  /**
   * `tasks.bc_recording_id`: the Basecamp id, saved right after a create
   * succeeded (§9.1). `null` while the row has never reached Basecamp.
   * A row with an id is never created again.
   */
  bcId: number | null
  /** The record is archived, trashed or deleted in Basecamp; the row is shown struck through (§9.3.10). */
  deletedRemotely: boolean
}

// ---------------------------------------------------------------------------
// Remote side: Basecamp records normalised (Appendix A)
// ---------------------------------------------------------------------------

export type RecordingStatus = 'active' | 'archived' | 'trashed'

/**
 * One file of a to-do's description (phase 5, spec §10), from
 * `description_attachments` (bc-api rich_text.md "Structured attachment
 * metadata"). Only `sgid` is required; Basecamp's other fields are null when
 * they are missing or of an unexpected type.
 */
export interface RemoteAttachment {
  /** The `sgid` of the `<bc-attachment>` element in the description. */
  sgid: string
  id: number | null
  filename: string | null
  contentType: string | null
  byteSize: number | null
  downloadUrl: string | null
}

export interface RemoteTodo {
  type: 'todo'
  id: number
  /** The to-do list (sheet) it belongs to: `parent.id`. */
  listId: number
  bucketId: number
  /** 1-based order in its list. `null` when Basecamp did not send it: the single-record GET has none. */
  position: number | null
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
  /**
   * Phase 5: `comments_count` (the to-do's comment counter, spec §9.3.5).
   * Absent when Basecamp did not send the key, null when it was not a count.
   * Not a synced field: never part of the hash or the diff.
   */
  commentsCount?: number | null
  /**
   * Phase 5: `description_attachments` (spec §10, inbound). Absent when
   * Basecamp did not send the key. Not part of the hash or the diff: the
   * `<bc-attachment>` elements themselves travel inside `descriptionHtml`.
   */
  descriptionAttachments?: RemoteAttachment[]
}

export interface RemoteSubtask {
  type: 'subtask'
  id: number
  /** The to-do it belongs to: `parent.id`. */
  todoId: number
  /** 1-based order within its to-do. `null` when Basecamp did not send it (optional in the official schema). */
  position: number | null
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
  /**
   * 1-based position last known in Basecamp. A read without a position
   * (single-record GET) keeps the one known before; never compared with an
   * unknown remote position.
   */
  position: number
  /** To-do: its list (`parent.id`) at that sync, to tell a sheet move from a Basecamp move (§9.2.6, §9.3.11). `null` for a subtask. */
  listId: number | null
  /**
   * To-do: `completion_subscriber_ids` at that sync, so a full PUT can be
   * built from this base when the record is not fetched (§9.2.4). `[]` for a subtask.
   */
  completionSubscriberIds: number[]
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
  /**
   * Undo of `trash_todo`: the same to-do comes back from the trash with its
   * subtasks; it is never created again (§16 scenario 3).
   */
  | { type: 'untrash_todo'; uid: TaskUid; todoId: number }
  /** Subtask deletion is permanent in Basecamp: the full record travels with the action (§9.2.7). */
  | { type: 'delete_subtask'; uid: TaskUid; subtaskId: number; snapshot: RemoteSubtask }

export type InboundAction =
  | { type: 'create_row'; task: LocalTask; remote: RemoteTask }
  /**
   * `assignMode`: a Basecamp edit switched the to-do to manual assignment (§8.1).
   * `attachments`: the file names the attachments cell shows (phase 5, §10);
   * written by the API from D1, never produced by the sync engine.
   */
  | {
      type: 'update_row'
      uid: TaskUid
      fields: Partial<Pick<LocalTask, 'title' | 'assignees' | 'dueOn' | 'startsOn' | 'completed' | 'notesHtml' | 'position' | 'assignMode' | 'attachments'>>
    }
  /** Shown struck through and grey; removed from the sheet only by a user (§9.3.10). */
  | { type: 'mark_deleted_remotely'; uid: TaskUid; status: Exclude<RecordingStatus, 'active'> | 'deleted' }
  | { type: 'restore_row'; uid: TaskUid }
  /**
   * The to-do was moved to another list in Basecamp (§9.3.11). `position: null`:
   * Basecamp did not say where (single-record GET); place the row at the end
   * of the target sheet, and reconciliation's list read corrects it.
   */
  | { type: 'move_row'; uid: TaskUid; toListId: number | null; position: number | null }
  /**
   * The managed block was edited in Basecamp: rewrite it from the platform and
   * log it (§8.2). `editedBlockHtml` is the block as found in Basecamp, for
   * `sync_log`; `''` when it was deleted there.
   */
  | { type: 'rewrite_managed_block'; uid: TaskUid; editedBlockHtml: string }

/**
 * A field changed on both sides since the last sync (§9.1): last writer wins, and it is logged.
 * `position` is the 1-based order; `listId` the to-do list (the sheet's, against Basecamp's).
 */
export interface FieldConflict {
  uid: TaskUid
  field: 'title' | 'assignees' | 'dueOn' | 'startsOn' | 'completed' | 'notesHtml' | 'position' | 'listId'
  localValue: unknown
  remoteValue: unknown
  winner: 'local' | 'remote'
  localChangedAt: IsoDateTime | null
  remoteUpdatedAt: IsoDateTime
}
