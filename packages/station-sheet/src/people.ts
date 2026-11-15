// Who a subtask is assigned to (owner decision 2-أ, 2026-11-15).
//
// The sheet is the reference for assignment: «القسم» holds a job title, the
// tab «المسميات» gives the name(s) behind each title, and the platform's own
// table maps each name as written there («أبو عمار», «فهد وعمر») to Basecamp
// people. A name may stand for several people. Nothing here splits names.

import { cellText, type CellValue } from './cells'

/** Job title → the name text written for it in «المسميات». */
export type RoleNames = Map<string, string>

/** Name text as written in «المسميات» → Basecamp person ids (set in the platform). */
export type PeopleMap = Map<string, readonly number[]>

export interface RolesIssue {
  role: string
  names: string[]
}

/**
 * Reads «المسميات»: first row is the header, column A the title, column B the
 * name. A title listed twice with the same name is fine; with different names
 * it is reported and the first one is used.
 */
export function readRoles(rows: readonly (readonly CellValue[])[]): { roles: RoleNames; conflicts: RolesIssue[] } {
  const roles: RoleNames = new Map()
  const seen = new Map<string, Set<string>>()
  for (const row of rows.slice(1)) {
    const role = cellText(row[0])
    if (role === '') continue
    const name = cellText(row[1])
    if (!roles.has(role)) roles.set(role, name)
    seen.set(role, (seen.get(role) ?? new Set()).add(name))
  }
  const conflicts = [...seen].filter(([, names]) => names.size > 1).map(([role, names]) => ({ role, names: [...names] }))
  return { roles, conflicts }
}

export type AssigneeLookup =
  | { ok: true; ids: number[] }
  | { ok: false; code: 'role_unknown' | 'role_without_name' | 'name_unmapped'; role: string; name?: string }

/** Basecamp person ids for a job title. An empty title means nobody. */
export function assigneesForRole(roleCell: CellValue, roles: RoleNames, people: PeopleMap): AssigneeLookup {
  const role = cellText(roleCell)
  if (role === '') return { ok: true, ids: [] }
  if (!roles.has(role)) return { ok: false, code: 'role_unknown', role }
  const name = roles.get(role)!
  if (name === '') return { ok: false, code: 'role_without_name', role }
  const ids = people.get(name)
  if (ids === undefined) return { ok: false, code: 'name_unmapped', role, name }
  return { ok: true, ids: [...new Set(ids)] }
}
