// diff(localRow, lastSynced, remoteState) → actions (spec §9.1).
//
// Three-way, field by field: a field that changed on one side only is copied
// to the other; a field that changed on both sides to different values is a
// conflict, resolved last-writer-wins (remote `updated_at` against the row's
// `localChangedAt`) and reported. No IO, no clock, no randomness.

import type {
  Assignee,
  AssignMode,
  BcType,
  FieldConflict,
  InboundAction,
  IsoDate,
  IsoDateTime,
  LocalTask,
  OutboundAction,
  RemoteTask,
  SubtaskPatch,
  SyncedBase,
  TaskUid,
  TodoWrite,
} from '@naf-sheets/shared'
import {
  bcIdsOf,
  isExternalOnly,
  mergeRemoteAssignees,
  sameAssigneeList,
  sameIdSet,
  validateAssignees,
  withSource,
} from './assignees'
import { computeAutoAssignees, isAutoAssignmentEcho, type AutoAssignSettings } from './auto-assign'
import { warning, type EngineWarning } from './errors'
import { isEcho, syncedFieldsOfBase, syncedFieldsOfRemote, type SyncedFields } from './hash'
import { sameHtml } from './html'
import { composeDescription, managedBlockForTask, sameManagedBlock, splitDescription, type Directory } from './managed-block'

/** The record could not be fetched because Basecamp no longer has it (404). */
export interface RemoteDeleted {
  type: 'deleted'
}

/** `null`: not fetched, or never created. */
export type RemoteState = RemoteTask | RemoteDeleted | null

export interface DiffContext {
  /** Names for the managed block (§8.2). */
  directory: Directory
  /**
   * `tasks.bc_recording_id`, saved right after a create succeeded (§9.1).
   * When set, the row is never created again, even without a base.
   */
  bcId?: number | null
  /** To-do: the list of the sheet the row is in now (`sheets.bc_todolist_id`). `null`/absent: local sheet. */
  listId?: number | null
  /**
   * To-do: the list it was in at the last sync. Tells a sheet move made here
   * from a list move made in Basecamp. Absent: assumed equal to `listId`, so a
   * list difference is read as a move made in Basecamp. `null`: unknown, so a
   * list difference is resolved last-writer-wins.
   */
  baseListId?: number | null
  /** Subtask: Basecamp id of the parent to-do, `null` while the parent is not created yet. */
  parentTodoId?: number | null
  /** To-do: its subtasks and the sheet settings, for automatic assignment (§8.1). */
  autoAssign?: { subtasks: readonly LocalTask[]; settings: AutoAssignSettings }
  /** The row is currently shown as deleted in Basecamp (§9.3.10). */
  deletedRemotely?: boolean
}

export interface DiffResult {
  /** In execution order: update, completion, position. */
  outbound: OutboundAction[]
  /** In application order: restore, move, field updates, block rewrite log. */
  inbound: InboundAction[]
  /**
   * Fields changed on both sides, already resolved (for `sync_log` and the cell alert).
   * For `assignees`, `localValue` is the row's `Assignee[]` and `remoteValue` Basecamp's ids.
   * Order conflicts are reported as `order_conflict` warnings (no 'position' field in the type).
   */
  conflicts: FieldConflict[]
  /**
   * New assignment mode of the to-do, or `null` when unchanged (§8.1).
   * Carried here because `update_row` cannot carry `assignMode` (see OPEN_QUESTIONS.md).
   */
  assignMode: AssignMode | null
  warnings: EngineWarning[]
}

type Winner = 'local' | 'remote'
type UpdateRowFields = Extract<InboundAction, { type: 'update_row' }>['fields']

/**
 * Last writer wins: the later of the row's local change and the record's
 * `updated_at`. No local timestamp, or an unreadable one, loses.
 * OPEN: equal timestamps go to Basecamp (spec gives no tie rule).
 */
export function lastWriter(localChangedAt: IsoDateTime | null, remoteUpdatedAt: IsoDateTime): Winner {
  if (localChangedAt === null) return 'remote'
  const l = Date.parse(localChangedAt)
  const r = Date.parse(remoteUpdatedAt)
  if (Number.isNaN(l)) return 'remote'
  if (Number.isNaN(r)) return 'local'
  return l > r ? 'local' : 'remote'
}

/** Values compared per field, from one side. */
interface View {
  title: string
  ids: number[]
  dueOn: IsoDate | null
  startsOn: IsoDate | null
  completed: boolean
  notes: string | null
  position: number
}

function viewOf(fields: SyncedFields): View {
  return {
    title: fields.title,
    ids: [...fields.bcAssigneeIds],
    dueOn: fields.dueOn,
    startsOn: fields.startsOn,
    completed: fields.completed,
    notes: fields.notesHtml,
    position: fields.position,
  }
}

const sameTitle = (a: string, b: string): boolean => a.trim() === b.trim()
const sameValue = <T>(a: T, b: T): boolean => a === b

type Decision = 'equal' | 'local' | 'remote' | 'conflict'

function decide<T>(l: T, b: T | undefined, r: T, hasBase: boolean, eq: (x: T, y: T) => boolean): Decision {
  if (eq(l, r)) return 'equal'
  if (!hasBase || b === undefined) return 'conflict'
  const localChanged = !eq(l, b)
  const remoteChanged = !eq(r, b)
  if (localChanged && !remoteChanged) return 'local'
  if (remoteChanged && !localChanged) return 'remote'
  return 'conflict'
}

function emptyResult(): DiffResult {
  return { outbound: [], inbound: [], conflicts: [], assignMode: null, warnings: [] }
}

/**
 * Diff one task row against its last synced base and the current Basecamp record.
 *
 * - No base, no record, no `ctx.bcId` → create (`create_todo` / `create_subtask`).
 *   Completion and any later position follow in the next diff, once the id exists.
 * - A record whose hash equals `base.hash` is unchanged since the last sync
 *   (our own write coming back): it produces no inbound action.
 * - To-do updates carry the complete state (`TodoWrite`); subtask updates only
 *   the changed fields. Completion goes out as `set_completion`, order as `reposition`.
 * - Archived, trashed or deleted records only mark the row (it is kept).
 */
export function diffTask(local: LocalTask, base: SyncedBase | null, remote: RemoteState, ctx: DiffContext): DiffResult {
  const result = emptyResult()
  const uid = local.uid
  const bcType: BcType = local.level === 0 ? 'todo' : 'subtask'
  const warn = (code: Parameters<typeof warning>[1]): void => {
    result.warnings.push(warning(uid, code))
  }

  // --- Gone or hidden in Basecamp: mark the row, change nothing else (§9.3.10).
  if (remote !== null && remote.type === 'deleted') {
    if ((base !== null || ctx.bcId != null) && !ctx.deletedRemotely) {
      result.inbound.push({ type: 'mark_deleted_remotely', uid, status: 'deleted' })
    }
    return result
  }
  if (remote !== null && remote.type === 'todo' && remote.status !== 'active') {
    if (!ctx.deletedRemotely) result.inbound.push({ type: 'mark_deleted_remotely', uid, status: remote.status })
    return result
  }

  // --- The row changed level or parent since it was linked: no safe mapping in Basecamp.
  // OPEN: indent/outdent and re-parenting of synced rows (see OPEN_QUESTIONS.md).
  const parentMoved =
    remote !== null && remote.type === 'subtask' && ctx.parentTodoId !== undefined && ctx.parentTodoId !== remote.todoId
  if ((base !== null && base.bcType !== bcType) || (remote !== null && remote.type !== bcType) || parentMoved) {
    warn('hierarchy_change_unsupported')
    return result
  }

  // --- What the row should be assigned now (§8.1), and whether it may be sent (§8.2).
  const autoMode = local.level === 0 && local.assignMode === 'auto'
  const auto = ctx.autoAssign
  const localAssignees: Assignee[] =
    autoMode && auto !== undefined && auto.settings.enabled
      ? computeAutoAssignees(local, auto.subtasks, auto.settings)
      : local.assignees
  const holdOutbound = validateAssignees(localAssignees) !== null
  if (holdOutbound) warn('invalid_local_assignees')

  // --- Create.
  if (remote === null && base === null) {
    if (ctx.bcId != null) {
      // Created before, but neither the base nor the record is at hand: never create twice.
      warn('remote_required')
      return result
    }
    if (autoMode && !sameAssigneeList(local.assignees, localAssignees)) {
      result.inbound.push({ type: 'update_row', uid, fields: { assignees: localAssignees } })
    }
    if (holdOutbound) return result
    const ids = bcIdsOf(localAssignees)
    if (bcType === 'todo') {
      if (ctx.listId == null) return result // a local sheet: nothing goes to Basecamp
      const block = managedBlockForTask({ ...local, assignees: localAssignees }, ctx.directory)
      if (block.missing.length > 0) warn('directory_incomplete')
      const write: TodoWrite = {
        content: local.title,
        descriptionHtml: composeDescription(local.notesHtml, block.missing.length > 0 ? null : block.html),
        assigneeIds: ids,
        completionSubscriberIds: [],
        dueOn: local.dueOn,
        startsOn: local.startsOn,
        notify: !autoMode && ids.length > 0,
      }
      result.outbound.push({ type: 'create_todo', uid, listId: ctx.listId, write, position: local.position })
    } else {
      if (ctx.parentTodoId == null) {
        warn('parent_not_synced')
        return result
      }
      result.outbound.push({
        type: 'create_subtask',
        uid,
        parentTodoId: ctx.parentTodoId,
        create: { title: local.title, dueOn: local.dueOn, assigneeIds: ids },
        position: local.position,
      })
    }
    return result
  }

  // --- Update: at least one of base / remote exists from here on.
  const bcId = base !== null ? base.bcId : (remote as RemoteTask).id
  const restore: InboundAction[] = remote !== null && ctx.deletedRemotely ? [{ type: 'restore_row', uid }] : []
  const echo = remote !== null && base !== null && isEcho(remote, base)

  const L: View = {
    title: local.title,
    ids: bcIdsOf(localAssignees),
    dueOn: local.dueOn,
    startsOn: bcType === 'todo' ? local.startsOn : null,
    completed: local.completed,
    notes: bcType === 'todo' ? local.notesHtml : null,
    position: local.position,
  }
  const B: View | null = base !== null ? viewOf(syncedFieldsOfBase(base)) : null
  // Unchanged since the base (echo) or not fetched: the remote side counts as the base.
  const R: View = remote !== null && !echo ? viewOf(syncedFieldsOfRemote(remote)) : (B as View)
  const hasBase = B !== null

  const field = <T>(
    name: FieldConflict['field'],
    l: T,
    b: T | undefined,
    r: T,
    eq: (x: T, y: T) => boolean,
    localValue: unknown,
    remoteValue: unknown,
  ): Winner | null => {
    const d = decide(l, b, r, hasBase, eq)
    if (d === 'equal') return null
    if (d !== 'conflict') return d
    if (remote === null) return 'local' // unreachable: without a record nothing changed remotely
    const winner = lastWriter(local.localChangedAt, remote.updatedAt)
    result.conflicts.push({
      uid,
      field: name,
      localValue,
      remoteValue,
      winner,
      localChangedAt: local.localChangedAt,
      remoteUpdatedAt: remote.updatedAt,
    })
    return winner
  }

  const titleW = field('title', L.title, B?.title, R.title, sameTitle, local.title, R.title)
  const dueW = field('dueOn', L.dueOn, B?.dueOn, R.dueOn, sameValue, L.dueOn, R.dueOn)
  const startsW = bcType === 'todo' ? field('startsOn', L.startsOn, B?.startsOn, R.startsOn, sameValue, L.startsOn, R.startsOn) : null
  const completedW = field('completed', L.completed, B?.completed, R.completed, sameValue, L.completed, R.completed)
  const notesW = bcType === 'todo' ? field('notesHtml', L.notes, B?.notes, R.notes, sameHtml, L.notes, R.notes) : null

  // --- Assignees. In auto mode a Basecamp change equal to the union is our echo;
  // any other Basecamp change is a human edit and switches to manual (§8.1).
  // OPEN: a Basecamp change that empties the list is also treated as manual (OPEN_QUESTIONS.md #2).
  let assigneeW: Winner | null
  let switchToManual = false
  if (autoMode) {
    const remoteChanged = remote !== null && !echo && !sameIdSet(R.ids, B !== null ? B.ids : L.ids)
    if (remoteChanged && !isAutoAssignmentEcho(R.ids, localAssignees)) {
      switchToManual = true
      assigneeW = 'remote'
      if (B !== null && !sameIdSet(L.ids, B.ids) && remote !== null) {
        result.conflicts.push({
          uid,
          field: 'assignees',
          localValue: localAssignees,
          remoteValue: R.ids,
          winner: 'remote',
          localChangedAt: local.localChangedAt,
          remoteUpdatedAt: remote.updatedAt,
        })
      }
    } else {
      assigneeW = sameIdSet(L.ids, R.ids) ? null : 'local'
    }
  } else {
    assigneeW = field('assignees', L.ids, B?.ids, R.ids, sameIdSet, localAssignees, R.ids)
  }

  let nextAssignees: Assignee[] = localAssignees
  if (assigneeW === 'remote') {
    nextAssignees = mergeRemoteAssignees(switchToManual ? withSource(localAssignees, 'manual') : localAssignees, R.ids, 'manual')
    if (isExternalOnly(nextAssignees)) warn('follower_removed_remotely')
  }
  if (switchToManual) result.assignMode = 'manual'
  const mergedIds = assigneeW === 'remote' ? R.ids : L.ids

  // --- Fields to apply to the sheet.
  const fields: UpdateRowFields = {}
  if (titleW === 'remote') fields.title = R.title
  if (!sameAssigneeList(local.assignees, nextAssignees)) fields.assignees = nextAssignees
  if (dueW === 'remote') fields.dueOn = R.dueOn
  if (startsW === 'remote') fields.startsOn = R.startsOn
  if (completedW === 'remote') fields.completed = R.completed
  if (notesW === 'remote') fields.notesHtml = R.notes

  const move: InboundAction[] = []
  const rewrite: InboundAction[] = []
  const updates: OutboundAction[] = []
  const completion: OutboundAction[] = []
  const order: OutboundAction[] = []

  // --- Content: full PUT for a to-do, partial PUT for a subtask.
  if (bcType === 'subtask') {
    const patch: SubtaskPatch = {}
    if (titleW === 'local') patch.title = local.title
    if (dueW === 'local') patch.dueOn = local.dueOn
    if (assigneeW === 'local') patch.assigneeIds = mergedIds
    if (Object.keys(patch).length > 0) updates.push({ type: 'update_subtask', uid, subtaskId: bcId, patch })
  } else {
    const remoteTodo = remote?.type === 'todo' ? remote : null
    const remoteSplit = remoteTodo !== null ? splitDescription(remoteTodo.descriptionHtml) : null
    const currentBlock = remoteSplit !== null ? remoteSplit.block : (base?.managedBlockHtml ?? null)
    const expected = managedBlockForTask(
      { level: 0, assignees: nextAssignees, freeColumnsForDescription: local.freeColumnsForDescription },
      ctx.directory,
    )
    let block: string | null
    if (expected.missing.length > 0) {
      warn('directory_incomplete')
      block = currentBlock // never write a block with names we do not have
    } else {
      block = expected.html
      // Edited in Basecamp: differs from what we last synced and from what we would write (§8.2).
      if (
        remoteSplit !== null &&
        !sameManagedBlock(remoteSplit.block, base?.managedBlockHtml ?? null) &&
        !sameManagedBlock(remoteSplit.block, block)
      ) {
        rewrite.push({ type: 'rewrite_managed_block', uid })
      }
    }
    const blockChanged = !sameManagedBlock(block, currentBlock)
    const contentChanged = [titleW, assigneeW, dueW, startsW, notesW].includes('local') || blockChanged
    if (contentChanged) {
      if (remoteTodo === null || remoteSplit === null) {
        // PUT clears what it does not carry, and the base has no completion subscribers.
        warn('remote_required')
      } else {
        const human = notesW === 'local' ? (local.notesHtml ?? '') : remoteSplit.human
        const added = mergedIds.filter((id) => !remoteTodo.assigneeIds.includes(id))
        const write: TodoWrite = {
          content: titleW === 'local' ? local.title : remoteTodo.content,
          descriptionHtml: composeDescription(human, block),
          assigneeIds: [...mergedIds],
          completionSubscriberIds: [...remoteTodo.completionSubscriberIds],
          dueOn: dueW === 'local' ? local.dueOn : remoteTodo.dueOn,
          startsOn: startsW === 'local' ? local.startsOn : remoteTodo.startsOn,
          // Automatic updates never notify (§8.1); a person's new assignment does.
          // OPEN: whether notify:true on PUT re-notifies existing assignees.
          notify: assigneeW === 'local' && !autoMode && added.length > 0,
        }
        updates.push({ type: 'update_todo', uid, todoId: bcId, write })
      }
    }
  }

  // --- Completion: its own endpoint, never inside the update (§9.2.5).
  if (completedW === 'local') completion.push({ type: 'set_completion', uid, bcType, bcId, completed: local.completed })

  // --- List (to-dos) and position (§9.2.6, §9.3.11). Positions are 1-based.
  let listMoved = false
  // OPEN: a row moved to a local (unsynced) sheet has no list: list changes are ignored (#10).
  if (bcType === 'todo' && ctx.listId != null) {
    const localList = ctx.listId
    const baseList = ctx.baseListId !== undefined ? ctx.baseListId : localList
    const remoteList = remote?.type === 'todo' ? remote.listId : baseList
    if (remoteList !== null && localList !== remoteList) {
      listMoved = true
      const localMoved = localList !== baseList
      const remoteMoved = remoteList !== baseList
      let w: Winner
      if (localMoved && !remoteMoved) w = 'local'
      else if (remoteMoved && !localMoved) w = 'remote'
      else {
        w = remote !== null ? lastWriter(local.localChangedAt, remote.updatedAt) : 'local'
        warn('order_conflict')
      }
      if (w === 'local') {
        order.push({ type: 'reposition', uid, bcType, bcId, position: local.position, listId: localList })
      } else {
        move.push({ type: 'move_row', uid, toListId: remoteList, position: R.position })
      }
    }
  }
  if (!listMoved) {
    const d = decide(L.position, B?.position, R.position, hasBase, sameValue)
    let w: Winner | null = null
    if (d === 'local' || d === 'remote') w = d
    if (d === 'conflict') {
      // FieldConflict has no 'position' field (see OPEN_QUESTIONS.md): reported as a warning.
      w = remote !== null ? lastWriter(local.localChangedAt, remote.updatedAt) : 'local'
      warn('order_conflict')
    }
    if (w === 'local') order.push({ type: 'reposition', uid, bcType, bcId, position: local.position })
    if (w === 'remote') fields.position = R.position
  }

  if (!holdOutbound) result.outbound.push(...updates, ...completion, ...order)
  const update: InboundAction[] = Object.keys(fields).length > 0 ? [{ type: 'update_row', uid, fields }] : []
  result.inbound.push(...restore, ...move, ...update, ...rewrite)
  return result
}

export interface NewRowPlacement {
  /** Identity of the new row; generated by the caller (the engine has no randomness). */
  uid: TaskUid
  sheetId: string
  /** Required for a subtask: the uid of the row of its to-do. */
  parentUid: TaskUid | null
}

/**
 * A record created in Basecamp becomes a new row (§9.3.5, §9.3.8). Any managed
 * block in its description (a copied to-do) is not taken as notes; the next
 * diff rewrites it from the row. A to-do without assignees starts in `auto` mode.
 */
export function inboundCreateRow(remote: RemoteTask, placement: NewRowPlacement): InboundAction {
  const assignees: Assignee[] = [...new Set(remote.assigneeIds)].map((id) => ({ kind: 'bc_person', bcPersonId: id, source: 'manual' }))
  if (remote.type === 'todo') {
    const { human } = splitDescription(remote.descriptionHtml)
    const task: LocalTask = {
      uid: placement.uid,
      sheetId: placement.sheetId,
      parentUid: null,
      level: 0,
      position: remote.position,
      title: remote.content,
      assignees,
      dueOn: remote.dueOn,
      startsOn: remote.startsOn,
      completed: remote.completed,
      notesHtml: human === '' ? null : human,
      freeColumnsForDescription: {},
      attachments: [],
      assignMode: assignees.length > 0 ? 'manual' : 'auto',
      localChangedAt: null,
    }
    return { type: 'create_row', task, remote }
  }
  if (placement.parentUid === null) throw new Error('inboundCreateRow: a subtask needs placement.parentUid')
  const task: LocalTask = {
    uid: placement.uid,
    sheetId: placement.sheetId,
    parentUid: placement.parentUid,
    level: 1,
    position: remote.position,
    title: remote.title,
    assignees,
    dueOn: remote.dueOn,
    startsOn: null,
    completed: remote.completed,
    notesHtml: null,
    freeColumnsForDescription: {},
    attachments: [],
    assignMode: 'auto',
    localChangedAt: null,
  }
  return { type: 'create_row', task, remote }
}
