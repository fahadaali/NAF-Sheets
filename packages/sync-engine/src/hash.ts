// Hash of the synced fields (spec §9.1, echo suppression) and the helpers
// that build a `SyncedBase` after a read or a write.
//
// The hash is taken over a canonical form of the fields, normalised exactly as
// the diff compares them, so "equal hash" and "no field differs" agree:
// - assignee ids as a sorted set;
// - titles trimmed;
// - the human description whitespace-insensitive (normalizeHtml);
// - the managed block by its visible text (htmlToComparableText);
// - subtasks carry no start date, notes or block (§8 table).

import type {
  BcType,
  IsoDate,
  RemoteSubtask,
  RemoteTask,
  RemoteTodo,
  SubtaskCreate,
  SubtaskPatch,
  SyncedBase,
  TaskUid,
  TodoWrite,
} from '@naf-sheets/shared'
import { htmlToComparableText, normalizeHtml } from './html'
import { splitDescription } from './managed-block'
import { sha256Hex } from './sha256'

/** Bump when the canonical form changes; old hashes then simply stop matching (safe). */
export const HASH_VERSION = 'v1'

export interface SyncedFields {
  bcType: BcType
  title: string
  bcAssigneeIds: readonly number[]
  dueOn: IsoDate | null
  startsOn: IsoDate | null
  completed: boolean
  /** Human part of the description; to-dos only. */
  notesHtml: string | null
  /** Managed block; to-dos only. */
  managedBlockHtml: string | null
  position: number
}

export function sortedUniqueIds(ids: readonly number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b)
}

/** Deterministic, synchronous hash of the synced fields: `v1:<sha-256 hex>`. */
export function hashSyncedFields(fields: SyncedFields): string {
  const isTodo = fields.bcType === 'todo'
  const canonical = JSON.stringify([
    fields.bcType,
    fields.title.trim(),
    sortedUniqueIds(fields.bcAssigneeIds),
    fields.dueOn ?? null,
    isTodo ? (fields.startsOn ?? null) : null,
    fields.completed,
    isTodo ? normalizeHtml(fields.notesHtml) : '',
    isTodo ? htmlToComparableText(fields.managedBlockHtml) : '',
    fields.position,
  ])
  return `${HASH_VERSION}:${sha256Hex(canonical)}`
}

function emptyToNull(html: string): string | null {
  return html === '' ? null : html
}

export function syncedFieldsOfRemote(remote: RemoteTask): SyncedFields {
  if (remote.type === 'subtask') {
    return {
      bcType: 'subtask',
      title: remote.title,
      bcAssigneeIds: sortedUniqueIds(remote.assigneeIds),
      dueOn: remote.dueOn,
      startsOn: null,
      completed: remote.completed,
      notesHtml: null,
      managedBlockHtml: null,
      position: remote.position,
    }
  }
  const { human, block } = splitDescription(remote.descriptionHtml)
  return {
    bcType: 'todo',
    title: remote.content,
    bcAssigneeIds: sortedUniqueIds(remote.assigneeIds),
    dueOn: remote.dueOn,
    startsOn: remote.startsOn,
    completed: remote.completed,
    notesHtml: emptyToNull(human),
    managedBlockHtml: block,
    position: remote.position,
  }
}

export function syncedFieldsOfBase(base: SyncedBase): SyncedFields {
  return {
    bcType: base.bcType,
    title: base.title,
    bcAssigneeIds: base.bcAssigneeIds,
    dueOn: base.dueOn,
    startsOn: base.startsOn,
    completed: base.completed,
    notesHtml: base.notesHtml,
    managedBlockHtml: base.managedBlockHtml,
    position: base.position,
  }
}

/** The remote state is what the base already holds: our own write coming back, or nothing new. */
export function isEcho(remote: RemoteTask, base: SyncedBase): boolean {
  return remote.type === base.bcType && remote.id === base.bcId && hashSyncedFields(syncedFieldsOfRemote(remote)) === base.hash
}

function baseOf(uid: TaskUid, bcId: number, fields: SyncedFields, remoteUpdatedAt: string): SyncedBase {
  return {
    uid,
    bcType: fields.bcType,
    bcId,
    title: fields.title,
    bcAssigneeIds: sortedUniqueIds(fields.bcAssigneeIds),
    dueOn: fields.dueOn,
    startsOn: fields.bcType === 'todo' ? fields.startsOn : null,
    completed: fields.completed,
    notesHtml: fields.bcType === 'todo' ? fields.notesHtml : null,
    managedBlockHtml: fields.bcType === 'todo' ? fields.managedBlockHtml : null,
    position: fields.position,
    remoteUpdatedAt,
    hash: hashSyncedFields(fields),
  }
}

/** Base after reading a record: the inbound actions for it were applied, or a row was first linked. */
export function baseFromRemote(uid: TaskUid, remote: RemoteTask): SyncedBase {
  return baseOf(uid, remote.id, syncedFieldsOfRemote(remote), remote.updatedAt)
}

/**
 * Base after `create_todo` / `update_todo` succeeded: the values we sent, with
 * the id, completion, position and `updated_at` of Basecamp's response.
 * Keeping what we sent (not what came back) means a sanitiser that rewrites
 * our markup produces at most one inbound refresh, never a write loop.
 */
export function baseAfterTodoWrite(uid: TaskUid, response: RemoteTodo, write: TodoWrite): SyncedBase {
  const { human, block } = splitDescription(write.descriptionHtml)
  return baseOf(
    uid,
    response.id,
    {
      bcType: 'todo',
      title: write.content,
      bcAssigneeIds: write.assigneeIds,
      dueOn: write.dueOn,
      startsOn: write.startsOn,
      completed: response.completed,
      notesHtml: emptyToNull(human),
      managedBlockHtml: block,
      position: response.position,
    },
    response.updatedAt,
  )
}

/** Base after `create_subtask` / `update_subtask` succeeded: sent fields win over the response's. */
export function baseAfterSubtaskWrite(uid: TaskUid, response: RemoteSubtask, sent: SubtaskCreate | SubtaskPatch): SyncedBase {
  const fields = syncedFieldsOfRemote(response)
  return baseOf(
    uid,
    response.id,
    {
      ...fields,
      title: sent.title ?? fields.title,
      dueOn: sent.dueOn !== undefined ? sent.dueOn : fields.dueOn,
      bcAssigneeIds: sent.assigneeIds ?? fields.bcAssigneeIds,
    },
    response.updatedAt,
  )
}

/** Base after `set_completion` or `reposition` (Basecamp answers 204 with no record). */
export function baseWith(base: SyncedBase, changes: Partial<Pick<SyncedBase, 'completed' | 'position'>>): SyncedBase {
  return baseOf(base.uid, base.bcId, { ...syncedFieldsOfBase(base), ...changes }, base.remoteUpdatedAt)
}
