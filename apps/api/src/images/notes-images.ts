// Pictures inside a to-do's notes cell go to Basecamp as files of its
// description (owner 2026-11-11: "an image inside a cell belongs to its row,
// like the notes, where Basecamp's field can hold it"). The notes column maps
// to the to-do's `description`, rich text that takes attachments (spec §8
// table, §10), so a picture there takes the phase 5 path unchanged: a copy in
// R2 under the task's attachments, an `attachments` row (origin `local`), then
// `sendToBasecamp` with the acting person's own token (spec §3), which uploads
// it, adds the `<bc-attachment>` to the description and records the outcome.
//
// Every other column skips its pictures (title, assignees, dates, status,
// free columns, attachments; and a subtask's notes: Basecamp subtasks have no
// description). Nothing is ever removed from Basecamp because a picture left
// a cell: that stays the attachment editor's decision (OPEN_QUESTIONS.md
// "Images" I7). The table per column is in OPEN_QUESTIONS.md "Images" I4.

import { cellImages, columnIndex, findSystemColumns } from '@naf-sheets/sheet-model'
import { parseImagePath } from '@naf-sheets/shared'
import type { Env } from '../env'
import { sendToBasecamp } from '../phase5/routes'
import { writeAttachmentsCell } from '../phase5/attachments-sync'
import { attachmentById, fileMode, taskOfWorkbook } from '../phase5/store'
import type { AttachmentRow } from '../phase5/store'
import { syncContext } from '../sync/deps'
import type { SyncDeps } from '../sync/deps'
import { loadWorkbookState, syncedSheets } from '../sync/state'
import type { WorkbookState } from '../sync/state'
import { getWorkbookSync, isLinked } from '../sync/store'
import { imageKey } from './store'

/** Where the copy of a notes picture sent with task `uid` is kept: one per (task, picture). */
export function notesImageAttachmentKey(workbookId: string, uid: string, imageId: string): string {
  return `attachments/${workbookId}/${uid}/cell-image-${imageId}`
}

/**
 * Pictures (stored in this workbook) of the notes cell of every to-do row of
 * the synced sheets, by task uid, in cell order. Subtask rows are left out.
 */
export function notesImagesOf(state: WorkbookState): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const sheet of syncedSheets(state)) {
    const plan = state.plans.get(sheet.id)
    const data = state.snapshot.sheets[sheet.univer_sheet_id]
    const notes = plan?.columns.find((c) => c.field === 'notes')
    if (!plan || !data || !notes) continue
    const notesColumn = columnIndex(notes.columnKey)
    const header = plan.headerRow - 1
    const found = findSystemColumns(data, header)
    if (notesColumn === null || !found.ok || found.value === null) continue
    const { uid: uidColumn, level: levelColumn } = found.value
    const cells = (data.cellData ?? {}) as Record<string, Record<string, unknown> | undefined>
    for (const [key, line] of Object.entries(cells)) {
      const row = Number(key)
      if (!Number.isInteger(row) || row <= header || !line) continue
      const uidValue = (line[String(uidColumn)] as { v?: unknown } | undefined)?.v
      const uid = typeof uidValue === 'string' ? uidValue.trim() : ''
      if (uid === '' || out.has(uid)) continue
      if (Number((line[String(levelColumn)] as { v?: unknown } | undefined)?.v ?? 0) === 1) continue
      const ids: string[] = []
      for (const image of cellImages(line[String(notesColumn)] as never)) {
        const ref = parseImagePath(image.source)
        if (ref && ref.workbookId === state.wb.id && !ids.includes(ref.imageId)) ids.push(ref.imageId)
      }
      if (ids.length > 0) out.set(uid, ids)
    }
  }
  return out
}

/**
 * The tasks of `images` with at least one picture never sent before (no
 * attachments row with its key, removed or not: a file a person removed is
 * not sent again because the picture is still in the cell).
 */
export async function tasksWithUnsentNotesImages(db: D1Database, workbookId: string, images: ReadonlyMap<string, readonly string[]>): Promise<string[]> {
  const keys: string[] = []
  for (const [uid, ids] of images) for (const id of ids) keys.push(notesImageAttachmentKey(workbookId, uid, id))
  if (keys.length === 0) return []
  const known = new Set<string>()
  for (let i = 0; i < keys.length; i += 500) {
    const { results } = await db
      .prepare(`SELECT r2_key FROM attachments WHERE r2_key IN (SELECT value FROM json_each(?1))`)
      .bind(JSON.stringify(keys.slice(i, i + 500)))
      .all<{ r2_key: string }>()
    for (const r of results) known.add(r.r2_key)
  }
  const out: string[] = []
  for (const [uid, ids] of images) if (ids.some((id) => !known.has(notesImageAttachmentKey(workbookId, uid, id)))) out.push(uid)
  return out
}

export interface NotesImagesOutcome {
  /** Pictures given a new attachments row (then sent, or `failed` with the reason). */
  added: number
}

/**
 * Sends the unsent pictures of `uid`'s notes cell as files of its to-do, with
 * `actorId`'s token. Run by the outbound consumer after the task's step, out
 * of its lease (the description write takes the lease itself). A picture of a
 * to-do not in Basecamp, deleted there, or of a sheet that does not sync is
 * left alone (it stays in the cell; nothing is an error).
 */
export async function sendNotesImages(env: Env, deps: SyncDeps, workbookId: string, uid: string, actorId: string): Promise<NotesImagesOutcome> {
  const db = env.DB
  const wb = await getWorkbookSync(db, workbookId)
  if (!wb || !isLinked(wb)) return { added: 0 }
  const found = await taskOfWorkbook(db, workbookId, uid)
  if (!found || found.task.level !== 0) return { added: 0 }
  if (fileMode(wb, found.sheet, found.task).kind !== 'basecamp') return { added: 0 }
  const state = await loadWorkbookState(env, wb)
  if (!state) return { added: 0 }
  const ids = notesImagesOf(state).get(uid) ?? []
  if (ids.length === 0 || (await tasksWithUnsentNotesImages(db, workbookId, new Map([[uid, ids]]))).length === 0) return { added: 0 }

  const ctx = syncContext(env, deps)
  let added = 0
  for (const imageId of ids) {
    const key = notesImageAttachmentKey(workbookId, uid, imageId)
    if (await db.prepare(`SELECT 1 FROM attachments WHERE r2_key = ?1`).bind(key).first()) continue
    const source = await env.ATTACHMENTS.get(imageKey(workbookId, imageId))
    // A picture whose stored copy is missing stays in the cell only.
    if (!source) continue
    const type = source.httpMetadata?.contentType ?? 'application/octet-stream'
    const extension = type === 'image/jpeg' ? 'jpg' : (type.split('/')[1] ?? 'png')
    const name = source.customMetadata?.name?.trim() || `صورة-${imageId.slice(0, 8)}.${extension}`
    const copied = await env.ATTACHMENTS.put(key, source.body.pipeThrough(new FixedLengthStream(source.size)), {
      httpMetadata: { contentType: type },
      customMetadata: { workbookId, taskUid: uid, imageId, uploadedBy: actorId, origin: 'notes_image' },
      onlyIf: { etagDoesNotMatch: '*' },
    })
    if (copied === null) continue // another consumer copied it first
    const id = crypto.randomUUID()
    const at = new Date(deps.now()).toISOString()
    const inserted = await db
      .prepare(
        `INSERT INTO attachments (id, task_uid, r2_key, filename, size, mime, bc_sgid, bc_blob_url, origin, created_by, created_at, state, r2_stored, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, 'local', ?7, ?8, 'uploading', 1, ?8)
         ON CONFLICT DO NOTHING`,
      )
      .bind(id, uid, key, name, source.size, type, actorId, at)
      .run()
    if ((inserted.meta.changes ?? 0) === 0) continue
    added++
    const row = (await attachmentById(db, id)) as AttachmentRow
    await sendToBasecamp(env, deps, ctx, wb, row, { id: actorId, role: 'editor' })
  }
  if (added > 0) {
    const fresh = await loadWorkbookState(env, wb)
    if (fresh) await writeAttachmentsCell(env, fresh, uid, new Date(deps.now()).toISOString())
  }
  return { added }
}
