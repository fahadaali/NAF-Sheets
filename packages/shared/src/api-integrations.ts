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
/** PUT /api/admin/people-matches/:userId */
export interface PutPeopleMatchRequest {
  bcPersonId: number | null
}

// ---------------------------------------------------------------------------
// Linking wizard (§7.3)
// ---------------------------------------------------------------------------

export type ProjectChoice =
  | { mode: 'existing'; projectId: number }
  | { mode: 'create'; name: string }
  | { mode: 'none' }

export type HierarchyRule =
  | { mode: 'flat' }
  /** A numbering column such as 1, 1.1, 1.2 (§7.3 step 5). */
  | { mode: 'numbering'; columnKey: string }
  /** Leading indentation in the title cell. */
  | { mode: 'indent' }

export interface ColumnPlan {
  /** Column letter in the sheet, e.g. "A". */
  columnKey: string
  field: MappedField
  /** Free columns only: append to the managed block of the description (§7.3 step 4). */
  appendToDescription?: boolean
}

export interface SheetPlan {
  sheetId: string
  mode: 'existing' | 'new' | 'local'
  /** Required when mode is `existing`. */
  todolistId?: number
  /** 1-based (§7.3 step 3). */
  headerRow: number
  columns: ColumnPlan[]
  /** Values of the status column that mean "completed" (§7.3 step 6). */
  completedValues?: string[]
  hierarchy: HierarchyRule
  /** When linking to a list that already has to-dos (§7.3 step 8). Nothing in Basecamp is ever deleted. */
  existingTasks: 'create_all' | 'match_by_title'
  /** Text found in the assignee column → Basecamp person id, or null to leave unassigned (§7.3 step 7). */
  assigneeMatches: Record<string, number | null>
}

export interface LinkPlan {
  project: ProjectChoice
  sheets: SheetPlan[]
}

/** POST /api/workbooks/:id/link/preview — computes, changes nothing. */
export interface LinkPreviewResponse {
  sheets: Array<{
    sheetId: string
    todosToCreate: number
    subtasksToCreate: number
    /** `match_by_title` only: pairs proposed for manual review before committing. */
    proposedMatches: Array<{ rowNumber: number; title: string; todoId: number; todoTitle: string }>
    /** Assignee texts with no confident Basecamp match (fuzzy match below threshold). */
    unmatchedAssignees: Array<{ text: string; candidates: Array<{ bcPersonId: number; name: string; score: number }> }>
    warnings: string[]
  }>
}

/** POST /api/workbooks/:id/link — commits the plan; starts sync ("بدء المزامنة", §7.3 step 9). */
export interface LinkWorkbookResponse {
  bcProjectId: number | null
  sheets: Array<{ sheetId: string; bcTodolistId: number | null; queuedTasks: number }>
}

// ---------------------------------------------------------------------------
// Google Sheets import (§7.2)
// ---------------------------------------------------------------------------

/**
 * Navigation (not fetch):
 *   GET /auth/google/start?next=/path   → 302 to Google consent (narrowest scope, §7.2/§14)
 *   GET /auth/google/callback           → 302 to `next`
 */
export interface GoogleLinkResponse {
  state: 'unlinked' | 'active' | 'expired'
  email: string | null
}

/** POST /api/import/gsheets */
export interface ImportGsheetsRequest {
  /** A Google Sheets URL or a bare spreadsheet id. */
  source: string
  /** Defaults to the spreadsheet's own title. */
  title?: string
}
export interface ImportGsheetsResponse {
  workbookId: string
  reportId: string
}

/**
 * GET /api/workbooks/:id/import-report
 * `report` is `ImportReport` from @naf-sheets/gsheets-import, stored as JSON
 * (shared cannot depend on that package; import the type from it directly).
 */
export interface ImportReportResponse {
  reportId: string
  createdAt: string
  report: unknown
}
