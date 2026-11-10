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
// A base also keeps the to-do's list and completion subscribers; they are not
// part of the hash (a list move is diffed on its own, and subscribers are not
// synced to the sheet, only preserved by a full PUT).
//
// Basecamp's single-record GET carries no position (`position: null`). A
// position is never compared with an unknown one: an echo check takes the
// base's, and a base built from such a record keeps the last known position.

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
  /** 1-based; `null` when Basecamp did not send it (a record from the single-record GET). */
  position: number | null
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

export function syncedFieldsOfBase(base: SyncedBase): SyncedFields & { position: number } {
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

/**
 * The remote state is what the base already holds: our own write coming back,
 * or nothing new. A record without a position (single-record GET) is compared
 * with the base's position, never read as a move.
 */
export function isEcho(remote: RemoteTask, base: SyncedBase): boolean {
  if (remote.type !== base.bcType || remote.id !== base.bcId) return false
  const fields = syncedFieldsOfRemote(remote)
  return hashSyncedFields({ ...fields, position: fields.position ?? base.position }) === base.hash
}

/** What a base keeps besides the hashed fields. */
interface BaseExtras {
  listId: number | null
  completionSubscriberIds: readonly number[]
}

const SUBTASK_EXTRAS: BaseExtras = { listId: null, completionSubscriberIds: [] }

function todoExtras(remote: RemoteTodo): BaseExtras {
  return { listId: remote.listId, completionSubscriberIds: remote.completionSubscriberIds }
}

/**
 * Basecamp's position, or the last one known for the record. Throws when
 * neither exists: a base must never invent a position (0 is not one).
 */
function knownPosition(position: number | null, lastKnown: number | undefined, caller: string): number {
  if (position !== null) return position
  if (lastKnown !== undefined) return lastKnown
  throw new TypeError(`${caller}: the record has no position (single-record GET); pass the last known position`)
}

function baseOf(
  uid: TaskUid,
  bcId: number,
  fields: SyncedFields & { position: number },
  extras: BaseExtras,
  remoteUpdatedAt: string,
): SyncedBase {
  const isTodo = fields.bcType === 'todo'
  return {
    uid,
    bcType: fields.bcType,
    bcId,
    title: fields.title,
    bcAssigneeIds: sortedUniqueIds(fields.bcAssigneeIds),
    dueOn: fields.dueOn,
    startsOn: isTodo ? fields.startsOn : null,
    completed: fields.completed,
    notesHtml: isTodo ? fields.notesHtml : null,
    managedBlockHtml: isTodo ? fields.managedBlockHtml : null,
    position: fields.position,
    listId: isTodo ? extras.listId : null,
    completionSubscriberIds: isTodo ? [...extras.completionSubscriberIds] : [],
    remoteUpdatedAt,
    hash: hashSyncedFields(fields),
  }
}

/**
 * Base after reading a record: the inbound actions for it were applied, or a
 * row was first linked. `lastKnownPosition` is used only when the record has
 * no position (single-record GET): pass the previous base's position, or the
 * row's own when there is no base yet or the record changed list.
 */
export function baseFromRemote(uid: TaskUid, remote: RemoteTask, lastKnownPosition?: number): SyncedBase {
  const fields = syncedFieldsOfRemote(remote)
  const position = knownPosition(fields.position, lastKnownPosition, 'baseFromRemote')
  return baseOf(uid, remote.id, { ...fields, position }, remote.type === 'todo' ? todoExtras(remote) : SUBTASK_EXTRAS, remote.updatedAt)
}

/**
 * Base after `create_todo` / `update_todo` succeeded: the values we sent, with
 * the id, completion, list, completion subscribers, position and `updated_at`
 * of Basecamp's response. Keeping what we sent (not what came back) means a
 * sanitiser that rewrites our markup produces at most one inbound refresh,
 * never a write loop. `lastKnownPosition` as in `baseFromRemote`: the previous
 * base's after an update, the action's position after a create.
 */
export function baseAfterTodoWrite(uid: TaskUid, response: RemoteTodo, write: TodoWrite, lastKnownPosition?: number): SyncedBase {
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
      position: knownPosition(response.position, lastKnownPosition, 'baseAfterTodoWrite'),
    },
    todoExtras(response),
    response.updatedAt,
  )
}

/**
 * Base after `create_subtask` / `update_subtask` succeeded: sent fields win
 * over the response's. `lastKnownPosition` as in `baseAfterTodoWrite`.
 */
export function baseAfterSubtaskWrite(
  uid: TaskUid,
  response: RemoteSubtask,
  sent: SubtaskCreate | SubtaskPatch,
  lastKnownPosition?: number,
): SyncedBase {
  const fields = syncedFieldsOfRemote(response)
  return baseOf(
    uid,
    response.id,
    {
      ...fields,
      title: sent.title ?? fields.title,
      dueOn: sent.dueOn !== undefined ? sent.dueOn : fields.dueOn,
      bcAssigneeIds: sent.assigneeIds ?? fields.bcAssigneeIds,
      position: knownPosition(fields.position, lastKnownPosition, 'baseAfterSubtaskWrite'),
    },
    SUBTASK_EXTRAS,
    response.updatedAt,
  )
}

/**
 * Base after `set_completion` or `reposition` (Basecamp answers 204 with no
 * record). A `reposition` that moved the to-do to another list also sets `listId`.
 */
export function baseWith(base: SyncedBase, changes: Partial<Pick<SyncedBase, 'completed' | 'position' | 'listId'>>): SyncedBase {
  const { listId, ...fields } = changes
  return baseOf(
    base.uid,
    base.bcId,
    { ...syncedFieldsOfBase(base), ...fields },
    { listId: listId !== undefined ? listId : base.listId, completionSubscriberIds: base.completionSubscriberIds },
    base.remoteUpdatedAt,
  )
}
