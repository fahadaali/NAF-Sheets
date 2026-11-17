// REST contract for wave 2: Basecamp account linking (spec §3), the linking
// wizard (§7.3) and Google Sheets import (§7.2). Shared by apps/api and apps/web.
// Page navigations (OAuth start/callback) are listed in comments; they return
// redirects, not JSON. Every JSON error is `ApiError` (./api).

import type { MappedField } from './domain'

// ---------------------------------------------------------------------------
// Basecamp: per-user account link (§3 "every edit appears under its author")
// ---------------------------------------------------------------------------

/**
 * Navigation (not fetch):
 *   GET /auth/basecamp/start?next=/path   → 302 to Launchpad authorisation
 *   GET /auth/basecamp/callback           → 302 to `next` (validated like naf-auth's safeNext)
 */
export type BasecampLinkState = 'unlinked' | 'active' | 'expired' | 'revoked'

/** GET /api/basecamp/link */
export interface BasecampLinkResponse {
  state: BasecampLinkState
  bcPersonId: number | null
  bcAccountId: number | null
  /** Basecamp name of the linked person, for "linked as …". */
  name: string | null
}

/** POST /api/basecamp/link/revoke — the stored token is discarded; the row is kept with state `revoked`. */
export interface RevokeBasecampLinkResponse {
  state: 'revoked'
}

export interface BcPerson {
  id: number
  name: string
  /** Basecamp hides emails from non-admins; null when hidden. */
  email: string | null
  avatarUrl: string | null
  /** Open set in Basecamp (User, Agent, Integration, Tombstone…): never assume it is closed. */
  personableType: string
  client: boolean
}

/** GET /api/basecamp/projects */
export interface BasecampProjectsResponse {
  projects: Array<{ id: number; name: string; description: string | null }>
}

/** GET /api/basecamp/projects/:projectId/todolists */
export interface BasecampTodolistsResponse {
  todolists: Array<{ id: number; name: string; completedRatio: string | null }>
}

/** GET /api/basecamp/projects/:projectId/people — from bc_people_cache, refreshed when older than 10 minutes (§9.5). */
export interface BasecampPeopleResponse {
  people: BcPerson[]
  refreshedAt: string
}

/** Admin: naf-id members ↔ Basecamp people (§3 manual matching screen). GET /api/admin/people-matches */
export interface PeopleMatchesResponse {
  matches: Array<{
    userId: string
    name: string | null
    email: string | null
    bcPersonId: number | null
    /** How the current match was made. */
    source: 'email' | 'manual' | null
  }>
  people: BcPerson[]
}
