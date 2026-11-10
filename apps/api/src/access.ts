// Who may do what (spec §3). Authentication is central (naf-id), permissions
// are local: the platform role in `members.role` caps every workbook role.
//
//   admin  → everything, every workbook
//   editor → creates workbooks; edits the ones they own or are an editor of
//   viewer → read-only in every route, whatever the workbook says

import type { PlatformRole, WorkbookMemberRole, WorkbookSummary } from '@naf-sheets/shared'

export type WorkbookAccess = WorkbookSummary['access']

export interface Caller {
  id: string
  role: PlatformRole
}

/**
 * The caller's effective access to one workbook, or `null` when they have
 * none — routes answer `null` with 404, never 403, so a workbook's existence
 * is not revealed to people outside it.
 *
 * A platform viewer is capped at 'viewer' even on a workbook they own or
 * edit (e.g. after being demoted).
 */
export function resolveAccess(caller: Caller, ownerId: string, memberRole: WorkbookMemberRole | null): WorkbookAccess | null {
  if (caller.role === 'admin') return 'admin'
  const granted: WorkbookAccess | null = ownerId === caller.id ? 'owner' : memberRole
  if (granted === null) return null
  return caller.role === 'viewer' ? 'viewer' : granted
}

export function canCreateWorkbooks(caller: Caller): boolean {
  return caller.role === 'admin' || caller.role === 'editor'
}

export function canWrite(access: WorkbookAccess): boolean {
  return access === 'admin' || access === 'owner' || access === 'editor'
}

export function canManageMembers(access: WorkbookAccess): boolean {
  return access === 'admin' || access === 'owner'
}
