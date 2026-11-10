// Phase 7 contract (spec §15 phase 7): templates (§7.1), the internal API for
// the NAF ecosystem (§13), service tokens for it, and backups (§14).
// Every error body is `ApiError` (./api.ts).

import type { IsoDate, IsoDateTime, SyncState, TaskLevel } from './domain'

// ---------------------------------------------------------------------------
// Templates (§7.1 option 2: «من قالب ناف — قوالب يحفظها admin، أي ملف يُحوَّل إلى قالب»)
// ---------------------------------------------------------------------------

export interface TemplateSummary {
  id: string
  title: string
  description: string | null
  sheetCount: number
  /** The workbook it was copied from (null if unknown). */
  sourceWorkbookId: string | null
  /** That workbook's title now, when it still exists and is not archived. */
  sourceTitle: string | null
  createdAt: IsoDateTime
  updatedAt: IsoDateTime
}

/** GET /api/templates — live templates, for everyone who may create workbooks (and admins). */
export interface TemplateListResponse {
  templates: TemplateSummary[]
}

/**
 * POST /api/admin/templates → 201 `TemplateSummary` (platform admin only).
 * Copies the workbook's latest saved snapshot, without its system columns and
 * platform marks (a template never carries task identities). The workbook
 * itself is not changed.
 */
export interface CreateTemplateRequest {
  workbookId: string
  title: string
  description?: string | null
}

/** PUT /api/admin/templates/:id → `TemplateSummary` (rename / describe; admin only). */
export interface UpdateTemplateRequest {
  title: string
  description?: string | null
}

/** POST /api/admin/templates/:id/archive → `ArchiveTemplateResponse`. Nothing is deleted; workbooks made from it are untouched. */
export interface ArchiveTemplateResponse {
  archived: true
}

// ---------------------------------------------------------------------------
// Service tokens of the internal API (admin only)
// ---------------------------------------------------------------------------

export interface ApiTokenSummary {
  id: string
  name: string
  /** First characters of the token, to tell tokens apart. */
  prefix: string
  createdAt: IsoDateTime
  lastUsedAt: IsoDateTime | null
  revokedAt: IsoDateTime | null
}

/** GET /api/admin/api-tokens */
export interface ApiTokenListResponse {
  tokens: ApiTokenSummary[]
}

/** POST /api/admin/api-tokens → 201 `CreateApiTokenResponse`. */
export interface CreateApiTokenRequest {
  name: string
}
export interface CreateApiTokenResponse {
  token: ApiTokenSummary
  /** The token itself. Shown once: only its hash is stored. */
  secret: string
}

/** POST /api/admin/api-tokens/:id/revoke → `ApiTokenSummary`. */

// ---------------------------------------------------------------------------
// Internal API (§13 «واجهة برمجية داخلية للمنظومة (محمية برموز خدمة)»)
// Every request: `Authorization: Bearer <service token>`. Read-only.
// ---------------------------------------------------------------------------

/** GET /api/v1/workbooks — every live workbook and its state. */
export interface V1WorkbooksResponse {
  workbooks: Array<{
    id: string
    title: string
    bcProjectId: number | null
    sheetCount: number
    /** Share of completed to-dos across synced sheets, 0..1; null when none. */
    completion: number | null
    syncState: SyncState | 'unlinked'
    updatedAt: IsoDateTime
  }>
}

/** done = completed; overdue = not completed and due before today; open = the rest. */
export type V1TaskStatus = 'done' | 'open' | 'overdue'

export interface V1Assignee {
  kind: 'bc_person' | 'external' | 'follower'
  /** Basecamp person id (as text) or external contact id. */
  id: string
  name: string | null
}

/** One task row in the unified shape («المهام بصيغة موحدة»). */
export interface V1Task {
  uid: string
  workbookId: string
  sheetId: string
  sheetTitle: string
  parentUid: string | null
  level: TaskLevel
  title: string
  status: V1TaskStatus
  completed: boolean
  dueOn: IsoDate | null
  startsOn: IsoDate | null
  assignees: V1Assignee[]
  /** Basecamp recording id; null until the row reached Basecamp. */
  bcId: number | null
  syncState: SyncState | null
}

/**
 * GET /api/v1/workbooks/:id/tasks?status=&assignee=&due_before=
 * - status: done | open | overdue
 * - assignee: a Basecamp person id, or an external contact id
 * - due_before: YYYY-MM-DD (exclusive); tasks without a due date are left out
 * Only rows of synced sheets are tasks (local sheets have no task rows, §2).
 */
export interface V1TasksResponse {
  workbookId: string
  /** The day `overdue` was judged against (UTC). */
  asOf: IsoDate
  tasks: V1Task[]
}

/** GET /api/v1/stats — general indicators for NAF dashboards. */
export interface V1StatsResponse {
  asOf: IsoDate
  workbooks: number
  totals: { tasks: number; done: number; open: number; overdue: number }
  byAssignee: Array<V1Assignee & { tasks: number; done: number; open: number; overdue: number }>
}

// ---------------------------------------------------------------------------
// Backups (§14), admin only
// ---------------------------------------------------------------------------

export interface BackupRunSummary {
  id: string
  startedAt: IsoDateTime
  finishedAt: IsoDateTime | null
  status: 'running' | 'succeeded' | 'failed' | 'skipped'
  tables: number
  rows: number
  snapshots: number
  /** Arabic, for the admin; null when the run succeeded. */
  message: string | null
}

/** GET /api/admin/backups — the latest runs, newest first. */
export interface BackupRunsResponse {
  /** False when the Worker has no BACKUPS bucket bound: no backup runs at all. */
  configured: boolean
  runs: BackupRunSummary[]
}
