// Who a subtask is assigned to (owner decision 2-أ, 2026-11-15).
//
// The sheet is the reference for assignment: «القسم» holds a job title, the
// tab «المسميات» gives the name(s) behind each title, and the platform's own
// table maps each person's name as written there to a Basecamp person.
// A title may name several people, separated by « - » or «،»
// («فهد العتيبي - عمر العمار», as the tab is written since 2026-11-15).

import { cellText, type CellValue } from './cells'

/** Job title → the name text written for it in «المسميات». */
export type RoleNames = Map<string, string>

/** One person's name as written in «المسميات» → Basecamp person id (set in the platform). */
export type PeopleMap = Map<string, number>

/** The people a name cell lists: split on « - », «،» and «,»; blanks dropped. */
export function splitNames(text: string): string[] {
  return text
    .split(/\s+-\s+|،|,/)
    .map((n) => n.replace(/\s+/g, ' ').trim())
    .filter((n) => n !== '')
}

export interface RolesIssue {
  role: string
  names: string[]
}

/**
 * Reads «المسميات»: first row is the header, column A the title, column B the
 * name. A title listed twice with the same name is fine; an empty name gives
 * way to a written one; two different names are reported (`conflicts`) and
 * the first one is used.
 */
export function readRoles(rows: readonly (readonly CellValue[])[]): { roles: RoleNames; conflicts: RolesIssue[] } {
  const roles: RoleNames = new Map()
  const seen = new Map<string, Set<string>>()
  for (const row of rows.slice(1)) {
    const role = cellText(row[0])
    if (role === '') continue
    const name = cellText(row[1])
    if (!roles.has(role) || (roles.get(role) === '' && name !== '')) roles.set(role, name)
    if (name !== '') seen.set(role, (seen.get(role) ?? new Set()).add(name))
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
  const ids: number[] = []
  for (const person of splitNames(name)) {
    const id = people.get(person)
    if (id === undefined) return { ok: false, code: 'name_unmapped', role, name: person }
    if (!ids.includes(id)) ids.push(id)
  }
  return { ok: true, ids }
}
