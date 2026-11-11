// Templates (spec §7.1 option 2, §12.1 item 8, §15 phase 7).
//
//   GET  /api/templates                     live templates (anyone signed in)
//   POST /api/admin/templates               turn a workbook into a template (admin)
//   PUT  /api/admin/templates/:id           rename / describe (admin)
//   POST /api/admin/templates/:id/archive   archive; nothing is deleted (admin)
//   POST /api/workbooks { source: 'template', templateId, title }
//                                           → createWorkbookFromTemplate below
//
// A template is a frozen, cleaned copy of a workbook's latest saved snapshot
// in R2 (`templates/{id}/snapshot.json`, create-only, never overwritten). The
// source workbook is only read. A workbook made from a template gets a copy of
// that snapshot under its own id; all its sheets start local (§7.3 links them).
// Frozen at creation time: decided by the owner 2026-11-10 (OPEN_QUESTIONS.md T1).

import { Hono } from 'hono'
import type {
  ArchiveTemplateResponse,
  TemplateListResponse,
  TemplateSummary,
  UpdateTemplateRequest,
} from '@naf-sheets/shared'
import { contentSheetIds } from '@naf-sheets/shared'
import { instantiateTemplate, toTemplateWorkbook } from '@naf-sheets/sheet-model'
import type { WorkbookSnapshot } from '@naf-sheets/sheet-model'
import type { Caller } from '../access'
import type { AppEnv } from '../auth'
import { auditStatement } from '../audit'
import type { Env } from '../env'
import { ApiFailure } from '../errors'
import { callerOf, isPlainObject, nowIso, readJson } from '../request'
import { readSnapshot, writeSnapshotVersion } from '../snapshot'

const MAX_TITLE = 200
const MAX_DESCRIPTION = 500
const MAX_ID = 128

export function templateKey(templateId: string): string {
  return `templates/${templateId}/snapshot.json`
}

/** One entry of `templates.sheets_json`. */
export interface TemplateSheet {
  univerSheetId: string
  title: string
  /** 1-based, as D1 `sheets.header_row`. */
  headerRow: number
}

interface TemplateRow {
  id: string
  title: string
  description: string | null
  source_workbook_id: string | null
  source_title: string | null
  r2_key: string
  sheet_count: number
  sheets_json: string
  created_at: string
  updated_at: string
}

const SELECT = `
SELECT t.id, t.title, t.description, t.source_workbook_id, t.r2_key, t.sheet_count, t.sheets_json,
       t.created_at, t.updated_at,
       (SELECT w.title FROM workbooks w WHERE w.id = t.source_workbook_id AND w.archived_at IS NULL) AS source_title
FROM templates t`

function toSummary(row: TemplateRow): TemplateSummary {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    sheetCount: row.sheet_count,
    sourceWorkbookId: row.source_workbook_id,
    sourceTitle: row.source_title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function liveTemplate(db: D1Database, id: string): Promise<TemplateRow | null> {
  if (id === '' || id.length > MAX_ID) return null
  return db.prepare(`${SELECT} WHERE t.id = ?1 AND t.archived_at IS NULL`).bind(id).first<TemplateRow>()
}

function requireAdmin(caller: Caller): void {
  if (caller.role !== 'admin') throw new ApiFailure(403, 'admin_only')
}

function parseTitleAndDescription(body: unknown): { title: string; description: string | null } {
  if (!isPlainObject(body)) throw new ApiFailure(400, 'invalid_template_title')
  const { title, description } = body
  if (typeof title !== 'string') throw new ApiFailure(400, 'invalid_template_title')
  const t = title.trim()
  if (t.length === 0 || t.length > MAX_TITLE) throw new ApiFailure(400, 'invalid_template_title')
  if (description !== undefined && description !== null && typeof description !== 'string') throw new ApiFailure(400, 'invalid_template_title')
  const d = typeof description === 'string' ? description.trim() : ''
  if (d.length > MAX_DESCRIPTION) throw new ApiFailure(400, 'invalid_template_title')
  return { title: t, description: d === '' ? null : d }
}

function sheetsOfTemplate(row: TemplateRow): TemplateSheet[] {
  try {
    const parsed = JSON.parse(row.sheets_json) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (s): s is TemplateSheet =>
        isPlainObject(s) && typeof s.univerSheetId === 'string' && typeof s.title === 'string' && typeof s.headerRow === 'number' && Number.isInteger(s.headerRow) && s.headerRow >= 1,
    )
  } catch {
    return []
  }
}

function isSnapshot(value: unknown): value is WorkbookSnapshot {
  return isPlainObject(value) && isPlainObject(value.sheets)
}

/** A sheet title that satisfies the `sheets.title` CHECK. */
function sheetTitle(title: string, univerSheetId: string): string {
  return title.trim().length > 0 ? title : univerSheetId
}

/**
 * The template's sheets in tab order: the stored list, else (defensively) the
 * snapshot's own order and names with the header on row 1.
 */
function plannedSheets(row: TemplateRow, snapshot: WorkbookSnapshot): TemplateSheet[] {
  const content = new Set(contentSheetIds(snapshot))
  const stored = sheetsOfTemplate(row).filter((s) => content.has(s.univerSheetId))
  if (stored.length > 0) return stored
  return [...content].map((id) => ({ univerSheetId: id, title: String(snapshot.sheets[id]?.name ?? ''), headerRow: 1 }))
}

/**
 * POST /api/workbooks with `source: 'template'`: R2 first (create-only), then
 * D1 in one batch — the same order as a blank workbook, so D1 never points at
 * a snapshot that does not exist. Returns the new workbook id.
 */
export async function createWorkbookFromTemplate(env: Env, caller: Caller, input: { title: string; templateId: unknown }): Promise<string> {
  if (typeof input.templateId !== 'string') throw new ApiFailure(404, 'template_not_found')
  const db = env.DB
  const row = await liveTemplate(db, input.templateId)
  if (!row) throw new ApiFailure(404, 'template_not_found')
  const object = await env.SNAPSHOTS.get(row.r2_key)
  const template = object ? await object.json<unknown>() : null
  if (!isSnapshot(template)) {
    console.error(`template snapshot missing or unreadable: template ${row.id}`)
    throw new ApiFailure(500, 'snapshot_missing')
  }

  const workbookId = crypto.randomUUID()
  const version = 1
  const now = nowIso()
  const snapshot = instantiateTemplate(template, { workbookId, title: input.title })
  const sheets = plannedSheets(row, snapshot)
  if (sheets.length === 0) {
    console.error(`template has no sheets: template ${row.id}`)
    throw new ApiFailure(500, 'snapshot_missing')
  }

  const written = await writeSnapshotVersion(env, { workbookId, version, savedBy: caller.id }, JSON.stringify(snapshot), {
    orphanAgeMs: Number.POSITIVE_INFINITY,
    stillUncommitted: async () => false,
  })
  if (!written) throw new Error(`snapshot key already taken for new workbook ${workbookId}`)

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO workbooks (id, title, owner_id, bc_project_id, source, source_ref, current_snapshot_version, created_at, updated_at)
         VALUES (?1, ?2, ?3, NULL, 'template', ?4, ?5, ?6, ?6)`,
      )
      .bind(workbookId, input.title, caller.id, row.id, version, now),
  ]
  sheets.forEach((s, index) => {
    statements.push(
      db
        .prepare(
          `INSERT INTO sheets (id, workbook_id, univer_sheet_id, title, position, sync_mode, bc_todolist_id, header_row, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, 'local', NULL, ?6, ?7)`,
        )
        .bind(crypto.randomUUID(), workbookId, s.univerSheetId, sheetTitle(s.title, s.univerSheetId), index + 1, s.headerRow, now),
    )
  })
  statements.push(
    auditStatement(
      db,
      {
        actorId: caller.id,
        action: 'workbook.create',
        entityType: 'workbook',
        entityId: workbookId,
        workbookId,
        details: { title: input.title, source: 'template', templateId: row.id, ownerId: caller.id },
      },
      now,
    ),
  )
  await db.batch(statements)
  return workbookId
}

async function createTemplate(env: Env, caller: Caller, body: unknown): Promise<TemplateSummary> {
  const { title, description } = parseTitleAndDescription(body)
  const workbookId = isPlainObject(body) ? body.workbookId : undefined
  if (typeof workbookId !== 'string' || workbookId === '' || workbookId.length > MAX_ID) throw new ApiFailure(400, 'invalid_template_source')

  const db = env.DB
  const wb = await db
    .prepare(`SELECT id, current_snapshot_version AS version FROM workbooks WHERE id = ?1 AND archived_at IS NULL`)
    .bind(workbookId)
    .first<{ id: string; version: number }>()
  if (!wb) throw new ApiFailure(400, 'invalid_template_source')
  // OPEN (T2): while editors are connected, the room may hold edits newer than
  // the saved snapshot (it persists every 200 ops or 5 minutes, §6.1). The
  // template copies the latest *saved* version and records which one.
  const snapshot = await readSnapshot(env, wb.id, wb.version)
  if (!isSnapshot(snapshot)) {
    console.error(`template source unreadable: workbook ${wb.id} version ${wb.version}`)
    throw new ApiFailure(500, 'template_source_unreadable')
  }

  const { results: sheetRows } = await db
    .prepare(`SELECT univer_sheet_id, title, header_row FROM sheets WHERE workbook_id = ?1 ORDER BY position, id`)
    .bind(wb.id)
    .all<{ univer_sheet_id: string; title: string; header_row: number }>()
  const headerRows: Record<string, number> = {}
  for (const s of sheetRows) headerRows[s.univer_sheet_id] = s.header_row - 1
  const { workbook: cleaned, unreadableSheets } = toTemplateWorkbook(snapshot, { headerRows })
  if (unreadableSheets.length > 0) {
    // OPEN (T3): kept as they are (no uid is read from them later: the copy's sheets are local).
    console.warn(`template from workbook ${wb.id}: ${unreadableSheets.length} sheet(s) with unreadable system columns kept as they are`)
  }

  // The dashboard sheet is not in the template (toTemplateWorkbook drops it).
  const order = contentSheetIds(cleaned)
  const known = new Map(sheetRows.map((s) => [s.univer_sheet_id, s]))
  const sheets: TemplateSheet[] = order.map((id) => {
    const meta = known.get(id)
    return { univerSheetId: id, title: meta?.title ?? String(cleaned.sheets[id]?.name ?? id), headerRow: meta?.header_row ?? 1 }
  })
  if (sheets.length === 0) throw new ApiFailure(500, 'template_source_unreadable')

  const id = crypto.randomUUID()
  const key = templateKey(id)
  const now = nowIso()
  // Create-only: a template's snapshot is never replaced.
  const put = await env.SNAPSHOTS.put(key, JSON.stringify(cleaned), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { templateId: id, sourceWorkbookId: wb.id, sourceVersion: String(wb.version), savedBy: caller.id },
    onlyIf: { etagDoesNotMatch: '*' },
  })
  if (!put) throw new Error(`template key already taken: ${key}`)

  await db.batch([
    db
      .prepare(
        `INSERT INTO templates (id, title, description, source_workbook_id, source_version, r2_key, sheet_count, sheets_json, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
      )
      .bind(id, title, description, wb.id, wb.version, key, sheets.length, JSON.stringify(sheets), caller.id, now),
    auditStatement(
      db,
      {
        actorId: caller.id,
        action: 'template.create',
        entityType: 'template',
        entityId: id,
        workbookId: wb.id,
        details: { title, sourceWorkbookId: wb.id, sourceVersion: wb.version, sheets: sheets.length, unreadableSheets: unreadableSheets.length },
      },
      now,
    ),
  ])
  const row = await liveTemplate(db, id)
  if (!row) throw new Error(`template ${id} vanished after insert`)
  return toSummary(row)
}

/** GET /api/templates */
export function templateRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()
  routes.get('/', async (c) => {
    callerOf(c)
    const { results } = await c.env.DB.prepare(`${SELECT} WHERE t.archived_at IS NULL ORDER BY t.title, t.id`).all<TemplateRow>()
    return c.json<TemplateListResponse>({ templates: results.map(toSummary) })
  })
  return routes
}

/** /api/admin/templates — platform admins only. */
export function adminTemplateRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.post('/', async (c) => {
    const caller = callerOf(c)
    requireAdmin(caller)
    const summary = await createTemplate(c.env, caller, await readJson(c))
    return c.json<TemplateSummary>(summary, 201)
  })

  routes.put('/:id', async (c) => {
    const caller = callerOf(c)
    requireAdmin(caller)
    const db = c.env.DB
    const row = await liveTemplate(db, c.req.param('id'))
    if (!row) throw new ApiFailure(404, 'template_not_found')
    const body: UpdateTemplateRequest = parseTitleAndDescription(await readJson(c))
    const now = nowIso()
    await db.batch([
      db.prepare(`UPDATE templates SET title = ?2, description = ?3, updated_at = ?4 WHERE id = ?1 AND archived_at IS NULL`).bind(row.id, body.title, body.description ?? null, now),
      auditStatement(
        db,
        {
          actorId: caller.id,
          action: 'template.update',
          entityType: 'template',
          entityId: row.id,
          workbookId: null,
          details: { from: { title: row.title, description: row.description }, to: { title: body.title, description: body.description ?? null } },
        },
        now,
      ),
    ])
    const updated = await liveTemplate(db, row.id)
    if (!updated) throw new ApiFailure(404, 'template_not_found')
    return c.json<TemplateSummary>(toSummary(updated))
  })

  routes.post('/:id/archive', async (c) => {
    const caller = callerOf(c)
    requireAdmin(caller)
    const db = c.env.DB
    const row = await liveTemplate(db, c.req.param('id'))
    if (!row) throw new ApiFailure(404, 'template_not_found')
    const now = nowIso()
    // Archived, never deleted: the R2 copy and the row stay (CLAUDE.md §3).
    await db.batch([
      db.prepare(`UPDATE templates SET archived_at = ?2, archived_by = ?3, updated_at = ?2 WHERE id = ?1 AND archived_at IS NULL`).bind(row.id, now, caller.id),
      auditStatement(db, { actorId: caller.id, action: 'template.archive', entityType: 'template', entityId: row.id, workbookId: null, details: { title: row.title } }, now),
    ])
    return c.json<ArchiveTemplateResponse>({ archived: true })
  })

  return routes
}
