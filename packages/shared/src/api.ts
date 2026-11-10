// REST contract between apps/web and apps/api (phase 1 surface).
// Paths are relative to the platform origin. Every error body is `ApiError`.

import type { PlatformRole, SheetSyncMode, SyncState, TaskUid, WorkbookMemberRole, WorkbookSource } from './domain'
import type { ColumnPlan } from './api-integrations'

/**
 * Stable machine codes of `ApiError.error`: exactly the codes apps/api sends
 * (apps/api/src/errors.ts), including the three naf-auth refusals the API
 * completes with an Arabic message (`unauthorized`, `access_denied`,
 * `auth_unavailable`). A new code is added here first.
 */
export type ApiErrorCode =
  | 'unauthorized'
  | 'access_denied'
  | 'auth_unavailable'
  | 'forbidden'
  | 'not_found'
  | 'invalid_json'
  | 'invalid_title'
  | 'unsupported_source'
  | 'invalid_snapshot'
  | 'invalid_base_version'
  | 'version_conflict'
  /** PUT /snapshot while editors are connected to the workbook's room: the room saves it (spec §11). */
  | 'room_active'
  | 'invalid_members'
  | 'owner_in_members'
  | 'unknown_user'
  | 'websocket_required'
  | 'snapshot_missing'
  | 'queue_unavailable'
  | 'internal'
  // Google Sheets import (apps/api/src/google-import/errors.ts)
  | 'google_not_configured'
  | 'google_not_linked'
  | 'google_link_expired'
  | 'google_state_invalid'
  | 'invalid_source'
  | 'google_file_forbidden'
  | 'google_file_not_found'
  | 'google_file_too_large'
  | 'google_no_sheets'
  | 'google_rate_limited'
  | 'google_unavailable'
  | 'google_bad_response'
  // Basecamp account link (apps/api/src/basecamp-link/errors.ts)
  | 'basecamp_not_configured'
  | 'basecamp_not_linked'
  | 'basecamp_link_expired'
  | 'basecamp_link_revoked'
  | 'basecamp_state_invalid'
  | 'basecamp_authorization_denied'
  | 'basecamp_account_missing'
  | 'basecamp_person_taken'
  | 'basecamp_service_not_linked'
  | 'basecamp_unavailable'
  | 'basecamp_project_not_found'
  | 'basecamp_todoset_disabled'
  | 'invalid_request'
  | 'person_already_matched'
  // Sync (apps/api/src/sync/errors.ts)
  | 'workbook_already_linked'
  | 'workbook_not_linked'
  | 'invalid_link_plan'
  | 'basecamp_todolist_not_found'
  | 'basecamp_project_taken'
  | 'conflict_already_resolved'
  | 'sheet_write_refused'
  // Phase 5: attachments and comments (apps/api/src/phase5/errors.ts, contract ./api-phase5.ts)
  | 'task_not_found'
  | 'task_not_in_basecamp'
  | 'task_deleted_remotely'
  | 'task_busy'
  | 'attachment_not_found'
  | 'attachment_length_required'
  | 'attachment_too_large'
  | 'attachment_empty'
  | 'attachment_invalid_name'
  | 'attachment_not_confirmed'
  | 'attachment_not_retryable'
  | 'comment_invalid'
  | 'basecamp_access_denied'
  // Phase 7: templates, internal API (apps/api/src/phase7/errors.ts, contract ./api-phase7.ts)
  | 'template_not_found'
  | 'template_source_unreadable'
  | 'api_token_not_found'
  // Dashboard and appearance (apps/api/src/dashboard/errors.ts, contract ./api-dashboard.ts)
  | 'widget_not_found'
  | 'invalid_widget'
  | 'widget_not_confirmed'
  | 'widget_limit'
  | 'invalid_palette'

/** Every non-2xx JSON response. `message` is Arabic: what happened and what to do (spec §12.2). */
export interface ApiError {
  ok: false
  /** Stable machine code. */
  error: ApiErrorCode
  message: string
  /** naf-auth: where to send the browser to sign in again (401 only). */
  login?: string
  /** Where to send the browser to (re)connect an integration, e.g. `/auth/google/start`. */
  link?: string
}

export interface CurrentUser {
  id: string
  name: string | null
  email: string | null
  role: PlatformRole
}

/** GET /api/me */
export interface MeResponse {
  user: CurrentUser
}

export interface WorkbookSummary {
  id: string
  title: string
  bcProjectId: number | null
  sheetCount: number
  /** Share of completed tasks across synced sheets, 0..1; null when there are none. */
  completion: number | null
  syncState: SyncState | 'unlinked'
  updatedAt: string
  /** The caller's effective role on this workbook. */
  access: 'owner' | WorkbookMemberRole | 'admin'
}

/** GET /api/workbooks?q= */
export interface WorkbookListResponse {
  workbooks: WorkbookSummary[]
}

/**
 * POST /api/workbooks → 201 `CreateWorkbookResponse`: a blank workbook (§7.1
 * option 1), or a copy of a template's snapshot (option 2, phase 7). Imports
 * go through POST /api/import/gsheets.
 */
export type CreateWorkbookRequest =
  | { title: string; source: Extract<WorkbookSource, 'blank'> }
  | { title: string; source: Extract<WorkbookSource, 'template'>; templateId: string }
export interface CreateWorkbookResponse {
  id: string
}

export interface SheetMeta {
  id: string
  univerSheetId: string
  title: string
  position: number
  syncMode: SheetSyncMode
  bcTodolistId: number | null
  headerRow: number
  /**
   * The column mapping committed when the sheet was linked (D1
   * `column_mappings`, §7.3 step 4), in column order; empty for a sheet that
   * was never linked. GET /api/workbooks/:id always sends it; optional only
   * for older payloads, where the editor infers the mapping from the header.
   */
  columns?: ColumnPlan[]
  /** Values of the status column that mean "completed" (§7.3 step 6); empty when none were chosen. */
  completedValues?: string[]
}

/** GET /api/workbooks/:id */
export interface WorkbookResponse {
  workbook: WorkbookSummary & { ownerId: string; source: WorkbookSource; createdAt: string }
  sheets: SheetMeta[]
  /** Univer `IWorkbookData` of the latest snapshot; opaque to the API. */
  snapshot: unknown
  /** Version of `snapshot`; send it back when saving. */
  version: number
}

/**
 * PUT /api/workbooks/:id/snapshot
 * Optimistic concurrency: `baseVersion` must equal the stored current version,
 * otherwise 409 `version_conflict` and nothing is written.
 */
export interface SaveSnapshotRequest {
  baseVersion: number
  snapshot: unknown
  /**
   * Synced task rows the person removed AND confirmed in the deletion dialog
   * (spec §9.2.7). A synced row missing from `snapshot` but not listed here
   * is never deleted in Basecamp: the API leaves Basecamp untouched and marks
   * the task `error`. A to-do goes to the trash; a subtask is deleted for
   * good (no trash), after its full data is kept in the platform's log.
   */
  confirmedDeletions?: TaskUid[]
}
export interface SaveSnapshotResponse {
  version: number
}

export interface WorkbookMember {
  userId: string
  name: string | null
  email: string | null
  role: WorkbookMemberRole
}

/** GET /api/workbooks/:id/members — PUT replaces the list (owner or admin only). */
export interface WorkbookMembersResponse {
  ownerId: string
  members: WorkbookMember[]
}
export interface PutWorkbookMembersRequest {
  members: Array<{ userId: string; role: WorkbookMemberRole }>
}
/** PUT /api/workbooks/:id/members → the list after the change, as GET returns it. */
export type PutWorkbookMembersResponse = WorkbookMembersResponse

/*
 * GET /api/workbooks/:id/room — WebSocket upgrade to the workbook's room
 * (Durable Object `WorkbookRoom`, spec §11). The message protocol is
 * `room-protocol.ts`. While anyone is connected, PUT …/snapshot answers 409
 * `room_active`: the room is the only writer of an open workbook.
 * - 101: upgraded, after the same access check as GET /api/workbooks/:id
 *   (every role that may open the workbook, viewers included).
 * - 404 `not_found`: the workbook does not exist or the caller has no access.
 * - 426 `websocket_required`: the request has no `Upgrade: websocket`.
 */

/** Default columns of a blank workbook (spec §7.1), in order. */
export const DEFAULT_COLUMNS = ['المهمة', 'المسؤول', 'تاريخ البدء', 'تاريخ الاستحقاق', 'الحالة', 'المرفقات', 'ملاحظات'] as const
