// Persists an imported workbook the way POST /api/workbooks persists a blank
// one (routes/workbooks.ts): the snapshot is written to R2 first with the
// same create-only helper, then D1 moves in one batch — workbook, sheets,
// import report and audit entries — so D1 never points at a missing snapshot.
//
// The converter never makes a dashboard sheet (a Google sheet named «اللوحة»
// stays an ordinary sheet); the stored snapshot gets the platform's own as its
// first tab, like a blank workbook (@naf-sheets/shared dashboard-sheet.ts).
// D1 lists the imported sheets only.

import type { ConvertResult, ImportReport } from '@naf-sheets/gsheets-import'
import { contentSheetIds, withDashboardSheet } from '@naf-sheets/shared'
import { auditStatement } from '../audit'
import type { Env } from '../env'
import { ApiFailure } from '../errors'
import { writeSnapshotVersion } from '../snapshot'

export interface ImportedWorkbook {
  workbookId: string
  reportId: string
}

export interface PersistInput {
  ownerId: string
  title: string
  spreadsheetId: string
  /** Univer `IWorkbookData`, id = the new workbook id. */
  workbook: ConvertResult['workbook']
  report: ImportReport
  /** Number of spreadsheets.get calls, for the audit entry. */
  googleRequests: number
  maxInlineReportBytes: number
}

/** R2 key of a report too large for D1. */
export function importReportKey(workbookId: string, reportId: string): string {
  return `workbooks/${workbookId}/import-reports/${reportId}.json`
}

/** `import_reports.summary_json` when the report itself lives in R2. */
interface ReportPointer {
  storage: 'r2'
  key: string
  bytes: number
}

function isPointer(value: unknown): value is ReportPointer {
  return typeof value === 'object' && value !== null && (value as { storage?: unknown }).storage === 'r2' && typeof (value as { key?: unknown }).key === 'string'
}

/**
 * Title of a sheets row. Google refuses empty sheet names; should one arrive
 * blank anyway, the Univer sheet id stands in so the CHECK holds.
 * OPEN: OPEN_QUESTIONS.md "Google import" G12.
 */
function sheetTitle(name: string, univerSheetId: string): string {
  return name.trim().length > 0 ? name : univerSheetId
}

export async function persistImport(env: Env, input: PersistInput): Promise<ImportedWorkbook> {
  const now = new Date().toISOString()
  const workbookId = input.workbook.id
  const reportId = crypto.randomUUID()
  const version = 1

  const sheetOrder = contentSheetIds(input.workbook)
  const names = new Map(input.report.sheets.map((s) => [s.sheetId, s.name]))
  const snapshot = withDashboardSheet(input.workbook)

  // R2 first. The id is fresh, so an existing object is never replaced.
  const written = await writeSnapshotVersion(env, { workbookId, version, savedBy: input.ownerId }, JSON.stringify(snapshot), {
    orphanAgeMs: Number.POSITIVE_INFINITY,
    stillUncommitted: async () => false,
  })
  if (!written) throw new Error(`snapshot key already taken for new workbook ${workbookId}`)

  const reportJson = JSON.stringify(input.report)
  const reportBytes = new TextEncoder().encode(reportJson).byteLength
  let summaryJson = reportJson
  if (reportBytes > input.maxInlineReportBytes) {
    const key = importReportKey(workbookId, reportId)
    await env.SNAPSHOTS.put(key, reportJson, {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      customMetadata: { workbookId, reportId },
    })
    const pointer: ReportPointer = { storage: 'r2', key, bytes: reportBytes }
    summaryJson = JSON.stringify(pointer)
  }

  const db = env.DB
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO workbooks (id, title, owner_id, bc_project_id, source, source_ref, current_snapshot_version, created_at, updated_at)
         VALUES (?1, ?2, ?3, NULL, 'gsheets', ?4, ?5, ?6, ?6)`,
      )
      .bind(workbookId, input.title, input.ownerId, input.spreadsheetId, version, now),
  ]
  sheetOrder.forEach((univerSheetId, index) => {
    statements.push(
      db
        .prepare(
          `INSERT INTO sheets (id, workbook_id, univer_sheet_id, title, position, sync_mode, bc_todolist_id, header_row, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, 'local', NULL, 1, ?6)`,
        )
        .bind(crypto.randomUUID(), workbookId, univerSheetId, sheetTitle(names.get(univerSheetId) ?? '', univerSheetId), index + 1, now),
    )
  })
  statements.push(
    db
      .prepare('INSERT INTO import_reports (id, workbook_id, gsheet_id, summary_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(reportId, workbookId, input.spreadsheetId, summaryJson, now),
    // Creating a workbook grants its owner every right on it (§14), as for a blank one.
    auditStatement(
      db,
      {
        actorId: input.ownerId,
        action: 'workbook.create',
        entityType: 'workbook',
        entityId: workbookId,
        workbookId,
        details: { title: input.title, source: 'gsheets', ownerId: input.ownerId },
      },
      now,
    ),
    // The import itself: what was read and what came of it. No cell content.
    auditStatement(
      db,
      {
        actorId: input.ownerId,
        action: 'workbook.import.gsheets',
        entityType: 'workbook',
        entityId: workbookId,
        workbookId,
        details: {
          spreadsheetId: input.spreadsheetId,
          reportId,
          googleRequests: input.googleRequests,
          counts: input.report.counts,
          reportItems: input.report.items.length,
          reportInR2: summaryJson !== reportJson,
        },
      },
      now,
    ),
  )
  await db.batch(statements)
  return { workbookId, reportId }
}

export interface StoredReport {
  reportId: string
  createdAt: string
  report: unknown
}

/** The latest import report of a workbook; null when it has none. 500 when its R2 copy is missing. */
export async function latestImportReport(env: Env, workbookId: string): Promise<StoredReport | null> {
  const row = await env.DB.prepare(
    `SELECT id, summary_json, created_at FROM import_reports WHERE workbook_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1`,
  )
    .bind(workbookId)
    .first<{ id: string; summary_json: string; created_at: string }>()
  if (!row) return null

  const summary: unknown = JSON.parse(row.summary_json)
  if (!isPointer(summary)) return { reportId: row.id, createdAt: row.created_at, report: summary }

  const object = await env.SNAPSHOTS.get(summary.key)
  if (!object) {
    console.error(`import report missing in R2: workbook ${workbookId} report ${row.id}`)
    throw new ApiFailure(500, 'snapshot_missing')
  }
  return { reportId: row.id, createdAt: row.created_at, report: await object.json<unknown>() }
}
