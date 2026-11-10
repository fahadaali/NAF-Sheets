// Automatic assignment of a to-do from its subtasks (spec §8.1).
//
// A to-do in `auto` mode is assigned the de-duplicated union of its subtasks'
// assignees (Basecamp people, externals and followers). Assigning it by hand,
// in the sheet or in Basecamp, switches it to `manual`; emptying its cell
// switches it back to `auto` and recomputes at once.

import type { Assignee, AssignMode, LocalTask } from '@naf-sheets/shared'
import { bcIdsOf, normalizeAssignees, sameIdSet, validateAssignees, withSource } from './assignees'
import { ok, type Result } from './errors'

export interface AutoAssignSettings {
  /** Sheet setting «الإسناد التلقائي للمهام الرئيسية» — on by default. */
  enabled: boolean
  /** Sheet setting «استبعد مسؤولي المهام الفرعية المنجزة» — off by default. */
  excludeCompletedSubtasks: boolean
}

export const DEFAULT_AUTO_ASSIGN_SETTINGS: Readonly<AutoAssignSettings> = { enabled: true, excludeCompletedSubtasks: false }

/**
 * Union of the assignees of `parent`'s subtasks, without duplicates, in order of
 * first appearance (subtasks by position). Entries carry `source: 'auto'`.
 * A person who is a direct assignee anywhere is a direct assignee of the
 * parent; a person who is only ever a follower stays a follower.
 * Externals copied to the parent do not trigger another e-mail
 * (`notifyEmail: false`): they were notified when assigned to the subtask,
 * the same reasoning as `notify: false` in Basecamp (§8.1). OPEN: confirm (#8).
 * Subtasks of other parents in `subtasks` are ignored.
 */
export function computeAutoAssignees(
  parent: Pick<LocalTask, 'uid'>,
  subtasks: readonly LocalTask[],
  settings: AutoAssignSettings,
): Assignee[] {
  const children = subtasks
    .filter((s) => s.parentUid === parent.uid && s.level === 1)
    .filter((s) => !(settings.excludeCompletedSubtasks && s.completed))
    .sort((a, b) => a.position - b.position)

  const order: Array<{ kind: 'person'; id: number } | { kind: 'external'; id: string }> = []
  const people = new Map<number, 'bc_person' | 'follower'>()
  const externals = new Set<string>()
  for (const child of children) {
    for (const a of child.assignees) {
      if (a.kind === 'external') {
        if (!externals.has(a.externalContactId)) {
          externals.add(a.externalContactId)
          order.push({ kind: 'external', id: a.externalContactId })
        }
        continue
      }
      const previous = people.get(a.bcPersonId)
      if (previous === undefined) {
        people.set(a.bcPersonId, a.kind)
        order.push({ kind: 'person', id: a.bcPersonId })
      } else if (previous === 'follower' && a.kind === 'bc_person') {
        people.set(a.bcPersonId, 'bc_person')
      }
    }
  }

  const union: Assignee[] = order.map((entry) => {
    if (entry.kind === 'external') {
      return { kind: 'external', externalContactId: entry.id, source: 'auto', notifyEmail: false }
    }
    return { kind: people.get(entry.id) ?? 'bc_person', bcPersonId: entry.id, source: 'auto' }
  })
  return normalizeAssignees(union)
}

/** What the to-do should be assigned now: the union in `auto` mode with the setting on, else its own list. */
export function effectiveAssignees(
  parent: LocalTask,
  subtasks: readonly LocalTask[],
  settings: AutoAssignSettings,
): Assignee[] {
  if (parent.level === 0 && parent.assignMode === 'auto' && settings.enabled) {
    return computeAutoAssignees(parent, subtasks, settings)
  }
  return parent.assignees
}

export interface AssignmentState {
  assignMode: AssignMode
  assignees: Assignee[]
}

/**
 * «اجعله تلقائياً», and what an emptied cell does: back to `auto`, recomputed at
 * once. With the sheet setting off nothing is computed and the cell stays empty.
 */
export function makeAutomatic(
  parent: Pick<LocalTask, 'uid'>,
  subtasks: readonly LocalTask[],
  settings: AutoAssignSettings,
): AssignmentState {
  return { assignMode: 'auto', assignees: settings.enabled ? computeAutoAssignees(parent, subtasks, settings) : [] }
}

export interface AssigneeEditOptions {
  subtasks?: readonly LocalTask[]
  settings?: AutoAssignSettings
  /** When given, followers must be in it (§8.2: «من أعضاء المشروع»). */
  projectMemberIds?: ReadonlySet<number>
}

/**
 * A person edits the assignee cell of `task` (sheet side).
 * - The set is normalised (duplicates, orphan followers) and validated: an
 *   external-only set without a follower is refused (§8.2), nothing changes.
 * - To-do: a non-empty set → `manual`; an empty set → `auto`, recomputed.
 * - Subtask: the mode is irrelevant and kept.
 */
export function applyAssigneeEdit(
  task: LocalTask,
  next: readonly Assignee[],
  options: AssigneeEditOptions = {},
): Result<AssignmentState> {
  const assignees = normalizeAssignees(withSource(next, 'manual'))
  const error = validateAssignees(assignees, options.projectMemberIds)
  if (error) return { ok: false, error }
  if (task.level === 1) return ok({ assignMode: task.assignMode, assignees })
  if (assignees.length === 0) {
    return ok(makeAutomatic(task, options.subtasks ?? [], options.settings ?? DEFAULT_AUTO_ASSIGN_SETTINGS))
  }
  return ok({ assignMode: 'manual', assignees })
}

/**
 * Loop prevention (§8.1): a Basecamp assignment change on an `auto` to-do that
 * equals the computed union is the platform's own update coming back; any
 * other change is a human edit and switches the to-do to `manual`.
 */
export function isAutoAssignmentEcho(remoteIds: readonly number[], union: readonly Assignee[]): boolean {
  return sameIdSet(remoteIds, bcIdsOf(union))
}
