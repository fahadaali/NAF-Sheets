// Pure helpers of «أعضاء المنصة» (src/screens/MembersScreen.tsx); unit-tested.

import type { PlatformMember } from '@naf-sheets/shared'
import { formatDateTime } from './format'
import { pathFor } from './routes'

/**
 * Why a member's role and state cannot be changed from this screen, or null.
 * The API enforces both on its own (409 `cannot_change_self` /
 * `last_active_admin`); the screen disables the controls and says why.
 */
export function memberLock(member: PlatformMember, selfId: string, members: readonly PlatformMember[]): 'self' | 'last_admin' | null {
  if (member.userId === selfId) return 'self'
  if (member.role === 'admin' && member.active && members.filter((m) => m.role === 'admin' && m.active).length <= 1) return 'last_admin'
  return null
}

/** `YYYY-MM-DD` with Latin digits (spec §12.2), in the browser's time zone; null when absent or invalid. */
export function lastSeenDay(iso: string | null, timeZone?: string): string | null {
  if (!iso) return null
  return formatDateTime(iso, timeZone)?.slice(0, 10) ?? null
}

/** The people-matching screen, focused on this member's row (`#match-<user id>`). */
export function peopleMatchHref(userId: string): string {
  return `${pathFor({ name: 'peopleMatches' })}#match-${encodeURIComponent(userId)}`
}
