// Platform members (spec §3, §12.1 item 8): the admin screen «أعضاء المنصة».
// naf-auth creates a member on their first sign-in through naf-id, as
// `viewer`; from then on a platform admin changes their role and active state
// here. Every error body is `ApiError` (./api.ts).

import type { IsoDateTime, PlatformRole } from './domain'

/**
 * The member's Basecamp identity, read from the people matching
 * (GET /api/admin/people-matches, apps/api/src/basecamp-link/people.ts):
 *
 *   auto     matched automatically by email
 *   manual   matched by an admin
 *   declined an admin recorded "no Basecamp person" (the email match never overrides it)
 *   none     not matched yet
 */
export type BasecampMatchState = 'auto' | 'manual' | 'declined' | 'none'

export interface PlatformMember {
  /** members.user_id = the `sub` from naf-id. */
  userId: string
  name: string | null
  email: string | null
  role: PlatformRole
  /** false: suspended here; naf-auth refuses every request of theirs. */
  active: boolean
  /** Last sign-in through naf-id (naf-auth writes it at each sign-in); null if unknown. */
  lastSeenAt: IsoDateTime | null
  /** First sign-in, when naf-auth created the member. */
  createdAt: IsoDateTime | null
  basecamp: {
    state: BasecampMatchState
    bcPersonId: number | null
    /** The Basecamp person's name from the account cache; null when unknown. */
    personName: string | null
  }
}

/** GET /api/admin/members (platform admin only): every member, active first, then by name. */
export interface PlatformMembersResponse {
  members: PlatformMember[]
}

/**
 * PUT /api/admin/members/:userId (platform admin only). At least one field.
 * Refused: changing one's own role or active state (409 `cannot_change_self`),
 * and demoting or suspending the last active admin (409 `last_active_admin`).
 */
export interface UpdatePlatformMemberRequest {
  role?: PlatformRole
  active?: boolean
}

/**
 * What naf-id was told (naf-auth `reportAccessChange`). The local change
 * stands whatever happened here.
 *
 *   sent        naf-id accepted the report
 *   failed      naf-id could not be reached or refused it; the change still applies here
 *   skipped     the member has no email, so naf-id cannot be told (it matches by email)
 *   not_needed  nothing changed
 */
export type NafIdReport = 'sent' | 'failed' | 'skipped' | 'not_needed'

/** PUT /api/admin/members/:userId → 200 */
export interface UpdatePlatformMemberResponse {
  member: PlatformMember
  /** false when the member already had the requested role and state. */
  changed: boolean
  nafIdReport: NafIdReport
}
