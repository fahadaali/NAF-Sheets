// Pictures inside a to-do's notes cell go to Basecamp as files of its
// description (owner 2026-11-11: "an image inside a cell belongs to its row,
// like the notes, where Basecamp's field can hold it"). The notes column maps
// to the to-do's `description`, rich text that takes attachments (spec §8
// table, §10), so a picture there takes the phase 5 path unchanged: a copy in
// R2 under the task's attachments, an `attachments` row (origin `local`), then
// `sendToBasecamp` with the acting person's own token (spec §3), which uploads
// it, adds the `<bc-attachment>` to the description and records the outcome.
//
// A picture removed from the notes cell leaves the description too (owner
// 2026-11-11, OPEN_QUESTIONS.md "Images" I7: «نعم تحذف»). Basecamp has no
// separate record for a file of a description: it is the `<bc-attachment
// sgid>` element in the rich text (bc-api rich_text.md), so removing it is the
// next `PUT /todos/{id}.json` without that element, carrying every other field
// as read (phase 5's `changeTodoDescription`, the attachment editor's removal
// path). The rules:
//   - only the sgid the platform recorded for that picture (the `attachments`
//     row with key `attachments/{wb}/{uid}/cell-image-{imageId}`) is removed;
//     a file a person attached in Basecamp, or any other file, is never touched;
//   - with the token of the person whose edit removed it (spec §3);
//   - the description as read is logged (`sync_log` `detach_file_snapshot`)
//     before the PUT, and the removal is audited (`attachment.remove_notes_image`);
//   - a to-do deleted or archived in Basecamp, or not reachable: nothing is
//     sent, nothing is an error, the chip stays;
//   - it runs in the outbound consumer on the latest committed snapshot, so a
//     removal undone before the save (or before the queue ran) sends nothing;
//   - the file is kept in the platform (removed chip, R2 copy kept, §10), and
//     if the picture comes back to the cell (Ctrl+Z after the save) its file
//     comes back: the same `<bc-attachment sgid>` is put back in the
//     description, as the notes cell's own undo does (its stored description
//     still holds the element, P11); nothing is sent when it is already back.
//     (verify live, I20: rich_text.md documents that an attachment cannot be
//     reused in *another* record; putting it back in the same description is
//     not documented either way.)
//
// Changing the sheet's notes column is not a removal (OPEN_QUESTIONS.md «Before
// the first real Basecamp link» Q1): each picture's row records the notes
// column it is tracked under (`notes_column`); pictures of another column than
// the sheet's current one are not tracked, their files stay in Basecamp.
//
// Every other column skips its pictures (title, assignees, dates, status,
// free columns, attachments; and a subtask's notes: Basecamp subtasks have no
// description). Floating pictures are never in a cell, so they never reach
// Basecamp. The table per column is in OPEN_QUESTIONS.md "Images" I4.

import { NotFoundError } from '@naf-sheets/basecamp'
import { cellImages, columnIndex, findSystemColumns } from '@naf-sheets/sheet-model'
import { parseImagePath } from '@naf-sheets/shared'
import { auditStatement } from '../audit'
import { LinkFailure, withUserToken } from '../basecamp-link'
import type { LinkContext } from '../basecamp-link'
import type { Env } from '../env'
import { changeTodoDescription } from '../phase5/description'
import { Phase5Failure } from '../phase5/errors'
import { sendToBasecamp } from '../phase5/routes'
import { writeAttachmentsCell } from '../phase5/attachments-sync'
import { ARCHIVE_DAYS, attachmentById, fileMode, plusDays, taskOfWorkbook } from '../phase5/store'
import type { AttachmentRow } from '../phase5/store'
import { readClient, syncContext } from '../sync/deps'
import type { SyncDeps } from '../sync/deps'
import { loadWorkbookState, syncedSheets } from '../sync/state'
import type { WorkbookState } from '../sync/state'
import { getWorkbookSync, isLinked, runBatches, syncLogStatement } from '../sync/store'
import type { WorkbookSyncRow } from '../sync/store'
import { imageKey } from './store'

/** Where the copy of a notes picture sent with task `uid` is kept: one per (task, picture). */
export function notesImageAttachmentKey(workbookId: string, uid: string, imageId: string): string {
  return `attachments/${workbookId}/${uid}/cell-image-${imageId}`
}

/** The picture id of a notes picture's attachment key of task `uid`, or null when the key is not one. */
function imageIdOfKey(workbookId: string, uid: string, key: string): string | null {
  const prefix = `attachments/${workbookId}/${uid}/cell-image-`
  if (!key.startsWith(prefix)) return null
  const id = key.slice(prefix.length)
  return /^[0-9a-f]{32}$/.test(id) ? id : null
}

/**
 * The pictures (stored in this workbook) of the notes cell of every to-do row
 * of the synced sheets, by task uid, in cell order — an empty list for a row
 * whose notes cell holds none. Only rows whose notes cell could be located
 * are listed (a sheet without a notes column, or whose system columns cannot
 * be read, lists none), so a missing entry never means "removed". Subtask
 * rows are left out.
 */
export function notesCellsOf(state: WorkbookState): Map<string, NotesCell> {
  const out = new Map<string, NotesCell>()
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
      out.set(uid, { column: notes.columnKey.trim().toUpperCase(), ids })
    }
  }
  return out
}

/** `notesCellsOf`, only the rows whose notes cell holds at least one picture. */
export function notesImagesOf(state: WorkbookState): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [uid, cell] of notesCellsOf(state)) if (cell.ids.length > 0) out.set(uid, cell.ids)
  return out
}

/** A to-do's notes cell: the column it is read from (the sheet's notes column now) and its pictures. */
export interface NotesCell {
  /** Column key (upper case) of the sheet's notes column at the time of reading. */
  column: string
  ids: string[]
}

interface NotesImageRow {
  id: string
  task_uid: string
  r2_key: string
  removed_at: string | null
  removed_reason: string | null
  state: string
  bc_sgid: string | null
  /** The notes column the picture was tracked under; null for a row older than migration 0009. */
  notes_column: string | null
}

/** The notes-picture attachment rows of `uids` (removed or not), with their picture id. */
async function notesImageRows(db: D1Database, workbookId: string, uids: readonly string[]): Promise<Array<NotesImageRow & { imageId: string }>> {
  const out: Array<NotesImageRow & { imageId: string }> = []
  for (let i = 0; i < uids.length; i += 500) {
    const { results } = await db
      .prepare(
        `SELECT id, task_uid, r2_key, removed_at, removed_reason, state, bc_sgid, notes_column FROM attachments
         WHERE task_uid IN (SELECT value FROM json_each(?1)) AND origin = 'local' ORDER BY created_at, id`,
      )
      .bind(JSON.stringify(uids.slice(i, i + 500)))
      .all<NotesImageRow>()
    for (const r of results) {
      const imageId = imageIdOfKey(workbookId, r.task_uid, r.r2_key)
      if (imageId !== null) out.push({ ...r, imageId })
    }
  }
  return out
}

/** What a task's notes pictures need, compared with its attachment rows. */
export interface NotesImageWork {
  /** Pictures in the cell never sent (no row with their key). */
  send: string[]
  /** Pictures back in the cell whose file left the description with them (`removed_reason` notes_image). */
  revive: Array<NotesImageRow & { imageId: string }>
  /** Files sent for a picture that is no longer in the cell (live rows, `attached` or `failed`). */
  remove: Array<NotesImageRow & { imageId: string }>
  /** Rows to stamp with the current notes column: a picture now in the notes cell that was tracked under another column (or none yet). */
  adopt: string[]
}

/**
 * Q1 (OPEN_QUESTIONS.md «Before the first real Basecamp link»): a picture's
 * file is removed from Basecamp only when a person removed the picture from
 * the cell. Changing the sheet's notes column is not that: the pictures of the
 * old column are no longer tracked (their rows stay as they are, their files
 * stay in Basecamp). A picture tracked under another column that is found in
 * the current notes cell is adopted by it.
 */
function workOf(cell: NotesCell, allRows: ReadonlyArray<NotesImageRow & { imageId: string }>): NotesImageWork {
  const ids = cell.ids
  const inCell = new Set(ids)
  const rows = allRows.filter((r) => r.notes_column === null || r.notes_column === cell.column || inCell.has(r.imageId))
  const byImage = new Map(rows.map((r) => [r.imageId, r]))
  const work: NotesImageWork = { send: [], revive: [], remove: [], adopt: rows.filter((r) => r.notes_column !== cell.column).map((r) => r.id) }
  for (const id of ids) {
    const row = byImage.get(id)
    if (!row) work.send.push(id)
    // A file removed with the attachment editor, or in Basecamp, is not sent again (I6).
    else if (row.removed_at !== null && row.removed_reason === 'notes_image') work.revive.push(row)
  }
  // `uploading` is left alone: it is being sent right now; the next step sees its outcome.
  for (const row of rows) if (row.removed_at === null && !inCell.has(row.imageId) && (row.state === 'attached' || row.state === 'failed')) work.remove.push(row)
  return work
}

const hasWork = (w: NotesImageWork) => w.send.length > 0 || w.revive.length > 0 || w.remove.length > 0 || w.adopt.length > 0

/**
 * The tasks of `cells` (uid → pictures of its notes cell, empty when none)
 * whose pictures and files differ: a picture never sent, a picture back in
 * the cell after its file was removed with it, or a file whose picture left
 * the cell.
 */
export async function tasksWithNotesImageWork(db: D1Database, workbookId: string, cells: ReadonlyMap<string, NotesCell>): Promise<string[]> {
  if (cells.size === 0) return []
  const rows = await notesImageRows(db, workbookId, [...cells.keys()])
  const byTask = new Map<string, Array<NotesImageRow & { imageId: string }>>()
  for (const r of rows) byTask.set(r.task_uid, [...(byTask.get(r.task_uid) ?? []), r])
  const out: string[] = []
  for (const [uid, cell] of cells) if (hasWork(workOf(cell, byTask.get(uid) ?? []))) out.push(uid)
  return out
}

export interface NotesImagesOutcome {
  /** Pictures given a new attachments row (then sent, or `failed` with the reason). */
  added: number
  /** Files put back because their picture came back to the cell. */
  revived: number
  /** Files taken out of the description (or only out of the platform when never in Basecamp). */
  removed: number
}

/** Makes sure the task's copy of the picture is in R2 (it is kept when the file is removed). */
async function ensureCopy(env: Env, workbookId: string, uid: string, imageId: string, actorId: string): Promise<{ size: number; type: string; name: string } | null> {
  const key = notesImageAttachmentKey(workbookId, uid, imageId)
  const source = await env.ATTACHMENTS.get(imageKey(workbookId, imageId))
  const existing = await env.ATTACHMENTS.head(key)
  if (!source && !existing) return null
  const type = source?.httpMetadata?.contentType ?? existing?.httpMetadata?.contentType ?? 'application/octet-stream'
  const extension = type === 'image/jpeg' ? 'jpg' : (type.split('/')[1] ?? 'png')
  const name = source?.customMetadata?.name?.trim() || `صورة-${imageId.slice(0, 8)}.${extension}`
  if (existing) {
    await source?.body.cancel()
    return { size: existing.size, type, name }
  }
  const s = source as R2ObjectBody
  const copied = await env.ATTACHMENTS.put(key, s.body.pipeThrough(new FixedLengthStream(s.size)), {
    httpMetadata: { contentType: type },
    customMetadata: { workbookId, taskUid: uid, imageId, uploadedBy: actorId, origin: 'notes_image' },
    onlyIf: { etagDoesNotMatch: '*' },
  })
  if (copied === null) return null // another consumer copied it first
  return { size: s.size, type, name }
}

/** Why a removal is skipped without any error: the to-do is not (or no longer) reachable in Basecamp. */
function goneRemotely(error: unknown): boolean {
  if (error instanceof NotFoundError) return true
  return error instanceof Phase5Failure && (error.key === 'task_deleted_remotely' || error.key === 'task_not_in_basecamp')
}

/**
 * Takes the file of a picture that left the notes cell out of the to-do's
 * description, with `actorId`'s token. True when the platform's chip was
 * removed. A to-do gone or archived in Basecamp, or an actor without a usable
 * link: nothing is sent and the chip stays (no error).
 */
async function removeNotesImageFile(
  env: Env,
  deps: SyncDeps,
  ctx: LinkContext,
  wb: WorkbookSyncRow,
  row: NotesImageRow & { imageId: string },
  actorId: string,
): Promise<boolean> {
  const db = env.DB
  const full = (await attachmentById(db, row.id)) as AttachmentRow
  let removed = false
  let snapshotLogged = false
  const markRemoved = async () => {
    const at = new Date(deps.now()).toISOString()
    const purgeAfter = full.r2_stored === 1 ? plusDays(at, ARCHIVE_DAYS) : null
    const done = await db.batch([
      db
        .prepare(
          `UPDATE attachments SET removed_at = ?2, removed_by = ?3, purge_after = ?4, removed_reason = 'notes_image', updated_at = ?2
           WHERE id = ?1 AND removed_at IS NULL`,
        )
        .bind(row.id, at, actorId, purgeAfter),
      auditStatement(
        db,
        {
          actorId,
          action: 'attachment.remove_notes_image',
          entityType: 'attachment',
          entityId: row.id,
          workbookId: wb.id,
          details: {
            taskUid: row.task_uid,
            imageId: row.imageId,
            filename: full.filename,
            bcSgid: full.bc_sgid,
            inBasecamp: full.bc_sgid !== null,
            descriptionSnapshot: snapshotLogged,
            r2Kept: full.r2_stored === 1,
            purgeAfter,
          },
        },
        at,
      ),
    ])
    removed = (done[0]?.meta.changes ?? 0) > 0
  }
  if (full.bc_sgid === null) {
    // Never reached Basecamp (a failed upload): only the platform's chip goes.
    await markRemoved()
    return removed
  }
  const sgid = full.bc_sgid
  try {
    await withUserToken(ctx, actorId, (token) =>
      changeTodoDescription({
        env,
        deps,
        client: readClient(ctx),
        token,
        actor: actorId,
        wb,
        uid: row.task_uid,
        change: { kind: 'remove', sgid },
        // Snapshot before the write (CLAUDE.md §3): the description exactly as Basecamp had it.
        beforeWrite: async (current) => {
          await runBatches(db, [
            syncLogStatement(
              db,
              {
                workbookId: wb.id,
                taskUid: row.task_uid,
                direction: 'out',
                action: 'detach_file_snapshot',
                field: 'description',
                oldValue: current.descriptionHtml,
                newValue: { sgid, attachmentId: row.id, imageId: row.imageId },
                actor: actorId,
                status: 'ok',
              },
              new Date(deps.now()).toISOString(),
            ),
          ])
          snapshotLogged = true
        },
        onWritten: markRemoved,
      }),
    )
  } catch (error) {
    if (goneRemotely(error)) return false
    if (error instanceof LinkFailure) {
      console.warn(`images: a notes picture's file was not removed from Basecamp (${error.key}); it stays until the row is sent again`)
      return false
    }
    throw error
  }
  return removed
}

/**
 * Brings the files of `uid`'s notes pictures in line with its notes cell,
 * with `actorId`'s token: unsent pictures are sent, files of pictures that
 * left the cell are removed from the description, files of pictures that came
 * back are sent again. Run by the outbound consumer after the task's step, out
 * of its lease (the description write takes the lease itself), on the latest
 * committed snapshot. A to-do not in Basecamp, deleted or archived there, or
 * of a sheet that does not sync is left alone (nothing is an error).
 */
export async function syncNotesImages(env: Env, deps: SyncDeps, workbookId: string, uid: string, actorId: string): Promise<NotesImagesOutcome> {
  const outcome: NotesImagesOutcome = { added: 0, revived: 0, removed: 0 }
  const db = env.DB
  const wb = await getWorkbookSync(db, workbookId)
  if (!wb || !isLinked(wb)) return outcome
  const found = await taskOfWorkbook(db, workbookId, uid)
  if (!found || found.task.level !== 0) return outcome
  if (fileMode(wb, found.sheet, found.task).kind !== 'basecamp') return outcome
  const state = await loadWorkbookState(env, wb)
  if (!state) return outcome
  const cell = notesCellsOf(state).get(uid)
  // The notes cell could not be located (row gone, no notes column…): never read as "every picture removed".
  if (cell === undefined) return outcome
  const work = workOf(cell, await notesImageRows(db, workbookId, [uid]))
  if (!hasWork(work)) return outcome
  // Pictures now tracked under the current notes column (no network, so first).
  for (const id of work.adopt) await db.prepare(`UPDATE attachments SET notes_column = ?2 WHERE id = ?1`).bind(id, cell.column).run()

  const ctx = syncContext(env, deps)
  for (const row of work.remove) if (await removeNotesImageFile(env, deps, ctx, wb, row, actorId)) outcome.removed++

  for (const row of work.revive) {
    if (!(await ensureCopy(env, workbookId, uid, row.imageId, actorId)) && !(await env.ATTACHMENTS.head(row.r2_key))) continue
    const at = new Date(deps.now()).toISOString()
    const done = await db.batch([
      // The same file back (its sgid is kept); `sendToBasecamp` uploads only when it has none.
      db
        .prepare(
          `UPDATE attachments SET removed_at = NULL, removed_by = NULL, purge_after = NULL, removed_reason = NULL, state = 'uploading',
                  last_error = NULL, last_error_code = NULL, updated_at = ?2
           WHERE id = ?1 AND removed_at IS NOT NULL AND removed_reason = 'notes_image'`,
        )
        .bind(row.id, at),
      auditStatement(
        db,
        { actorId, action: 'attachment.restore_notes_image', entityType: 'attachment', entityId: row.id, workbookId, details: { taskUid: uid, imageId: row.imageId, bcSgid: row.bc_sgid } },
        at,
      ),
    ])
    if ((done[0]?.meta.changes ?? 0) === 0) continue
    outcome.revived++
    await sendToBasecamp(env, deps, ctx, wb, (await attachmentById(db, row.id)) as AttachmentRow, { id: actorId, role: 'editor' })
  }

  for (const imageId of work.send) {
    const key = notesImageAttachmentKey(workbookId, uid, imageId)
    if (await db.prepare(`SELECT 1 FROM attachments WHERE r2_key = ?1`).bind(key).first()) continue
    // A picture whose stored copy is missing stays in the cell only.
    const copy = await ensureCopy(env, workbookId, uid, imageId, actorId)
    if (!copy) continue
    const id = crypto.randomUUID()
    const at = new Date(deps.now()).toISOString()
    const inserted = await db
      .prepare(
        `INSERT INTO attachments (id, task_uid, r2_key, filename, size, mime, bc_sgid, bc_blob_url, origin, created_by, created_at, state, r2_stored, updated_at, notes_column)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, 'local', ?7, ?8, 'uploading', 1, ?8, ?9)
         ON CONFLICT DO NOTHING`,
      )
      .bind(id, uid, key, copy.name, copy.size, copy.type, actorId, at, cell.column)
      .run()
    if ((inserted.meta.changes ?? 0) === 0) continue
    outcome.added++
    const row = (await attachmentById(db, id)) as AttachmentRow
    await sendToBasecamp(env, deps, ctx, wb, row, { id: actorId, role: 'editor' })
  }
  if (outcome.added + outcome.revived + outcome.removed > 0) {
    const fresh = await loadWorkbookState(env, wb)
    if (fresh) await writeAttachmentsCell(env, fresh, uid, new Date(deps.now()).toISOString())
  }
  return outcome
}
