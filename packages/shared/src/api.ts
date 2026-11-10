// REST contract between apps/web and apps/api (phase 1 surface).
// Paths are relative to the platform origin. Every error body is `ApiError`.

import type { PlatformRole, SheetSyncMode, SyncState, WorkbookMemberRole, WorkbookSource } from './domain'

/** Every non-2xx JSON response. `message` is Arabic: what happened and what to do (spec §12.2). */
export interface ApiError {
  ok: false
  /** Stable machine code, e.g. `forbidden`, `not_found`, `version_conflict`, `unauthorized`. */
  error: string
  message: string
  /** naf-auth: where to send the browser to sign in again (401 only). */
  login?: string
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

/** POST /api/workbooks — phase 1 creates blank workbooks only. */
export interface CreateWorkbookRequest {
  title: string
  source: Extract<WorkbookSource, 'blank'>
}
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

/** Default columns of a blank workbook (spec §7.1), in order. */
export const DEFAULT_COLUMNS = ['المهمة', 'المسؤول', 'تاريخ البدء', 'تاريخ الاستحقاق', 'الحالة', 'المرفقات', 'ملاحظات'] as const
