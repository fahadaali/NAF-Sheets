// Assignee sets (spec §8.2): Basecamp people, external contacts (platform
// only) and internal followers (sent to Basecamp so an external-only task is
// never unassigned there).

import type { Assignee, AssigneeSource } from '@naf-sheets/shared'
import { engineError, type EngineError } from './errors'
import { sortedUniqueIds } from './hash'

/** What goes to Basecamp's `assignee_ids`: people and followers, never externals. Sorted, unique. */
export function bcIdsOf(assignees: readonly Assignee[]): number[] {
  const ids: number[] = []
  for (const a of assignees) if (a.kind !== 'external') ids.push(a.bcPersonId)
  return sortedUniqueIds(ids)
}

export function sameIdSet(a: readonly number[], b: readonly number[]): boolean {
  const x = sortedUniqueIds(a)
  const y = sortedUniqueIds(b)
  return x.length === y.length && x.every((id, i) => id === y[i])
}

export function hasExternal(assignees: readonly Assignee[]): boolean {
  return assignees.some((a) => a.kind === 'external')
}

/** Every assignee is external and no internal person (direct or follower) is assigned. */
export function isExternalOnly(assignees: readonly Assignee[]): boolean {
  return hasExternal(assignees) && assignees.every((a) => a.kind === 'external')
}

function personKey(a: Assignee): string {
  return a.kind === 'external' ? `external:${a.externalContactId}` : `person:${a.bcPersonId}`
}

/**
 * De-duplicates and applies §8.2's follower rules, keeping first-appearance order:
 * - one entry per person; a direct assignment beats a follower entry;
 * - with no external left, followers become ordinary assignees.
 */
export function normalizeAssignees(assignees: readonly Assignee[]): Assignee[] {
  const byKey = new Map<string, Assignee>()
  for (const a of assignees) {
    const key = personKey(a)
    const previous = byKey.get(key)
    if (previous === undefined || (previous.kind === 'follower' && a.kind === 'bc_person')) byKey.set(key, a)
  }
  const list = [...byKey.values()]
  if (hasExternal(list)) return list
  return list.map((a) => (a.kind === 'follower' ? { kind: 'bc_person', bcPersonId: a.bcPersonId, source: a.source } : a))
}

/**
 * §8.2: an assignment made only of external contacts needs an internal
 * follower; a follower must be a project member (when the member list is given).
 */
export function validateAssignees(assignees: readonly Assignee[], projectMemberIds?: ReadonlySet<number>): EngineError | null {
  if (isExternalOnly(assignees)) return engineError('external_requires_follower')
  if (projectMemberIds) {
    for (const a of assignees) {
      if (a.kind === 'follower' && !projectMemberIds.has(a.bcPersonId)) return engineError('follower_not_project_member')
    }
  }
  return null
}

/**
 * Applies Basecamp's `assignee_ids` to a local assignee list:
 * - externals are platform-only and are never removed;
 * - people and followers not in `remoteIds` are removed;
 * - a returning follower keeps its follower role; new ids become `bc_person` with `source`.
 */
export function mergeRemoteAssignees(local: readonly Assignee[], remoteIds: readonly number[], source: AssigneeSource): Assignee[] {
  const remote = new Set(remoteIds)
  const kept = local.filter((a) => a.kind === 'external' || remote.has(a.bcPersonId))
  const present = new Set<number>()
  for (const a of kept) if (a.kind !== 'external') present.add(a.bcPersonId)
  const added: Assignee[] = []
  for (const id of remoteIds) {
    if (present.has(id)) continue
    present.add(id)
    added.push({ kind: 'bc_person', bcPersonId: id, source })
  }
  return [...kept, ...added]
}

export function withSource(assignees: readonly Assignee[], source: AssigneeSource): Assignee[] {
  return assignees.map((a) => ({ ...a, source }))
}

function canonical(a: Assignee): string {
  switch (a.kind) {
    case 'bc_person':
      return `bc_person:${a.bcPersonId}:${a.source}`
    case 'follower':
      return `follower:${a.bcPersonId}:${a.source}`
    case 'external':
      return `external:${a.externalContactId}:${a.source}:${a.notifyEmail ? 1 : 0}`
  }
}

/** Same people, kinds, sources and e-mail flags, in any order. */
export function sameAssigneeList(a: readonly Assignee[], b: readonly Assignee[]): boolean {
  const x = a.map(canonical).sort()
  const y = b.map(canonical).sort()
  return x.length === y.length && x.every((v, i) => v === y[i])
}
