// REST contract for wave 3: sync state, conflicts and assignee options
// (spec §5.2, §8.1, §8.2, §9). apps/api implements it (src/sync/), apps/web
// consumes it. Every JSON error is `ApiError` (./api). Until the workbook room
// carries sync events (phase 6), the editor polls GET …/sync.

import type { BcPerson } from './api-integrations'
import type { AssignMode, ExternalContact, FieldConflict, IsoDateTime, SyncState, TaskUid } from './domain'

// ---------------------------------------------------------------------------
// Sync state per row (§5.2 "مؤشر المزامنة لكل صف", §9.2.8)
// ---------------------------------------------------------------------------

export interface TaskSyncInfo {
  uid: TaskUid
  /** `SheetMeta.id`. */
  sheetId: string
  state: SyncState
  /** Arabic, saying what happened and what to do; set for `error` and `conflict` only. */
  message: string | null
  /** §9.3.10: the row stays in the sheet, marked, until a person removes it. */
  remoteStatus: 'active' | 'archived' | 'trashed' | 'deleted'
  /** The record in Basecamp (its `app_url`); null until it exists there. */
  bcUrl: string | null
  /** Level-0 rows only (§8.1); null for subtasks. */
  assignMode: AssignMode | null
}

/** GET /api/workbooks/:id/sync — every role that may open the workbook. */
export interface WorkbookSyncResponse {
  /** `unlinked` when the workbook has no Basecamp project. */
  state: SyncState
  lastSuccessAt: IsoDateTime | null
  counts: { pending: number; error: number; conflict: number }
  /**
   * Arabic notice for the whole workbook, or null: e.g. the Basecamp account
   * is inactive (§9.2.9) or the service account is not linked.
   */
  notice: string | null
  tasks: TaskSyncInfo[]
}

/** POST /api/workbooks/:id/sync-now → 202 (§9.4 «مزامنة الآن»); editors, owner, admin. */
export interface SyncNowResponse {
  /** Lists queued for reconciliation. */
  queued: number
}

// ---------------------------------------------------------------------------
// Field conflicts (§9.1: logged, shown on the cell, the other value restorable)
// ---------------------------------------------------------------------------

export interface ConflictRecord extends FieldConflict {
  id: string
  /** `SheetMeta.id`. */
  sheetId: string
  createdAt: IsoDateTime
}

/** GET /api/workbooks/:id/conflicts — unresolved only. */
export interface WorkbookConflictsResponse {
  conflicts: ConflictRecord[]
}

/**
 * POST /api/workbooks/:id/conflicts/:conflictId/restore → 202 `RestoreConflictResponse`.
 * Puts back the value that lost: a local loser is written to Basecamp with
 * the caller's token, a remote loser is written into the sheet.
 * POST /api/workbooks/:id/conflicts/:conflictId/dismiss → 204 keeps the winner.
 */
export interface RestoreConflictResponse {
  restored: true
}

// ---------------------------------------------------------------------------
// Assignee cell (§5.2, §8.2): sections «أعضاء المشروع» / «أعضاء الحساب» / «جهات خارجية»
// ---------------------------------------------------------------------------

/** GET /api/workbooks/:id/assignee-options — from the caches, refreshed when older than 10 minutes (§9.5). */
export interface AssigneeOptionsResponse {
  /** Basecamp people of the linked project; empty when unlinked. */
  projectPeople: BcPerson[]
  /** People of the Basecamp account who are not in the project (§8.2 case 1). */
  accountPeople: BcPerson[]
  externals: ExternalContact[]
  refreshedAt: IsoDateTime | null
}

/** POST /api/external-contacts → 201 `ExternalContact` (§8.2 case 3); editors and admin. */
export interface CreateExternalContactRequest {
  name: string
  organization?: string | null
  email?: string | null
  phone?: string | null
}

/**
 * POST /api/workbooks/:id/project-people → 200 `AssigneeOptionsResponse`
 * (§8.2 case 1): adds an account member to the linked project with the
 * caller's own token, after the editor's confirmation dialog. A 403 from
 * Basecamp is `forbidden` with the Arabic message of §8.2.
 */
export interface GrantProjectPersonRequest {
  bcPersonId: number
}

// ---------------------------------------------------------------------------
// Admin: sync health (§9.4 «تقرير صحة المزامنة»)
// ---------------------------------------------------------------------------

/** GET /api/admin/sync-health — platform admin only. */
export interface SyncHealthResponse {
  workbooks: Array<{
    workbookId: string
    title: string
    bcProjectId: number
    counts: { pending: number; error: number; conflict: number }
    lastSuccessAt: IsoDateTime | null
    webhook: 'active' | 'inactive' | 'missing'
  }>
  /** Messages that reached the dead-letter queue and were not retried. */
  deadLetters: number
}
