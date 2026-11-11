// Files of a to-do as Basecamp has them (spec §10, inbound): every
// `<bc-attachment>` of the person's part of its description becomes a chip
// (a D1 `attachments` row), and the attachments cell shows their names.
//
// Run from the sync step whenever a to-do record is read (webhook,
// reconciliation, the outbound consumer's fetch, the platform's own
// description write). Metadata comes from `description_attachments`
// (rich_text.md) when Basecamp sent it; otherwise from the element.
//
// A file that left the description in Basecamp is marked removed (its R2 copy,
// if any, is kept, §10). A file the platform is still sending (`uploading`)
// or failed to send (`failed`) is left alone: it is not in the description yet.

import type { RemoteTodo } from '@naf-sheets/shared'
import { findAttachmentElements, splitDescription } from '@naf-sheets/sync-engine'
import type { Env } from '../env'
import { SYSTEM_ACTOR } from '../sync/messages'
import { applyToSheet } from '../sync/state'
import type { WorkbookState } from '../sync/state'
import { runBatches, syncLogStatement } from '../sync/store'
import { ARCHIVE_DAYS, liveAttachments, plusDays, toRefs } from './store'
import type { AttachmentRow } from './store'

/** Name of a file Basecamp gave no name for. */
export const UNNAMED_FILE = 'مرفق'

/** Brings the to-do's D1 files in line with its description; true when the list changed. */
export async function syncAttachmentsFromTodo(env: Env, state: WorkbookState, uid: string, remote: RemoteTodo, at: string): Promise<boolean> {
  const db = env.DB
  const row = state.taskRows.get(uid)
  if (!row || row.level !== 0) return false
  const { human } = splitDescription(remote.descriptionHtml)
  const meta = new Map((remote.descriptionAttachments ?? []).map((a) => [a.sgid, a]))
  const inDescription = new Map<string, { filename: string | null }>()
  for (const e of findAttachmentElements(human)) if (e.sgid !== null && !inDescription.has(e.sgid)) inDescription.set(e.sgid, { filename: e.filename })

  const live = await liveAttachments(db, uid)
  const bySgid = new Map(live.filter((r): r is AttachmentRow & { bc_sgid: string } => r.bc_sgid !== null).map((r) => [r.bc_sgid, r]))
  const removedNotesFiles = new Map<string, { id: string; filename: string }>()
  if ([...inDescription.keys()].some((sgid) => !bySgid.has(sgid))) {
    const { results } = await db
      .prepare(`SELECT id, filename, bc_sgid FROM attachments WHERE task_uid = ?1 AND removed_at IS NOT NULL AND removed_reason = 'notes_image' AND bc_sgid IS NOT NULL`)
      .bind(uid)
      .all<{ id: string; filename: string; bc_sgid: string }>()
    for (const r of results) removedNotesFiles.set(r.bc_sgid, r)
  }
  const statements: D1PreparedStatement[] = []
  const added: string[] = []
  const removed: string[] = []

  for (const [sgid, element] of inDescription) {
    const m = meta.get(sgid)
    const existing = bySgid.get(sgid)
    if (existing) {
      const filename = existing.origin === 'basecamp' ? (m?.filename ?? existing.filename) : existing.filename
      statements.push(
        db
          .prepare(
            `UPDATE attachments SET state = 'attached', last_error = NULL, last_error_code = NULL, filename = ?2,
               bc_blob_url = COALESCE(?3, bc_blob_url), bc_attachment_id = COALESCE(?4, bc_attachment_id),
               size = CASE WHEN size = 0 AND ?5 IS NOT NULL THEN ?5 ELSE size END, mime = COALESCE(mime, ?6), updated_at = ?7
             WHERE id = ?1 AND removed_at IS NULL`,
          )
          .bind(existing.id, filename, m?.downloadUrl ?? null, m?.id ?? null, m?.byteSize ?? null, m?.contentType ?? null, at),
      )
      if (filename !== existing.filename) added.push(filename)
      continue
    }
    // A notes picture's file whose picture came back to the cell with its stored
    // description (Ctrl+Z after the save, I7): the platform's own row comes back,
    // not a second chip for the same file.
    const revived = removedNotesFiles.get(sgid)
    if (revived) {
      added.push(revived.filename)
      statements.push(
        db
          .prepare(
            `UPDATE attachments SET removed_at = NULL, removed_by = NULL, purge_after = NULL, removed_reason = NULL, state = 'attached',
                    last_error = NULL, last_error_code = NULL, updated_at = ?2
             WHERE id = ?1 AND removed_at IS NOT NULL AND removed_reason = 'notes_image'`,
          )
          .bind(revived.id, at),
      )
      continue
    }
    const id = crypto.randomUUID()
    const filename = m?.filename ?? element.filename ?? UNNAMED_FILE
    added.push(filename)
    statements.push(
      db
        .prepare(
          // `r2_key` is reserved for a copy the platform may make later; nothing is written there (r2_stored = 0).
          `INSERT INTO attachments (id, task_uid, r2_key, filename, size, mime, bc_sgid, bc_blob_url, origin, created_by, created_at,
                                    state, r2_stored, bc_attachment_id, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'basecamp', NULL, ?9, 'attached', 0, ?10, ?9)
           ON CONFLICT DO NOTHING`,
        )
        .bind(id, uid, `basecamp/${state.wb.id}/${uid}/${id}`, filename, m?.byteSize ?? 0, m?.contentType ?? null, sgid, m?.downloadUrl ?? null, at, m?.id ?? null),
    )
  }
  for (const r of live) {
    if (r.state !== 'attached' || r.bc_sgid === null || inDescription.has(r.bc_sgid)) continue
    // Left the description in Basecamp: the chip goes, the platform's copy stays (§10).
    removed.push(r.filename)
    statements.push(
      db
        .prepare(`UPDATE attachments SET removed_at = ?2, removed_by = NULL, purge_after = ?3, updated_at = ?2 WHERE id = ?1 AND removed_at IS NULL`)
        .bind(r.id, at, r.r2_stored === 1 ? plusDays(at, ARCHIVE_DAYS) : null),
    )
  }
  if (statements.length > 0) await runBatches(db, statements)
  if (added.length === 0 && removed.length === 0) return false

  await runBatches(db, [
    syncLogStatement(db, { workbookId: state.wb.id, taskUid: uid, direction: 'in', action: 'attachments', newValue: { added, removed }, actor: SYSTEM_ACTOR, status: 'ok' }, at),
  ])
  await writeAttachmentsCell(env, state, uid, at)
  return true
}

/**
 * The attachments cell of `uid` from its D1 files (a server change: open
 * editors receive it through the room). Best effort: a lost race leaves the
 * cell for the next change; the files themselves are in D1.
 */
export async function writeAttachmentsCell(env: Env, state: WorkbookState, uid: string, at: string): Promise<void> {
  const row = state.taskRows.get(uid)
  const sheet = row ? state.sheetsById.get(row.sheet_id) : undefined
  if (!sheet || !state.plans.get(sheet.id)?.columns.some((c) => c.field === 'attachments')) return
  const files = toRefs(await liveAttachments(env.DB, uid))
  const apply = await applyToSheet(env, state, sheet, [{ type: 'update_row', uid, fields: { attachments: files } }], SYSTEM_ACTOR, at)
  if (apply.status === 'contended' || apply.status === 'not_found' || apply.status === 'refused') {
    console.warn(`phase5: the attachments cell of a task in workbook ${state.wb.id} was not written (${apply.status})`)
  }
}
