// Routes of packages/shared/src/api-phase5.ts: a task's files (spec §10) and
// its comments (§12.1 item 5). A workbook nobody may open answers 404 (as in
// src/routes/workbooks.ts); a `viewer` reads (GET, downloads) and is refused
// with 403 on every write, whatever the UI shows (CLAUDE.md §2).

import { Hono } from 'hono'
import type { Context } from 'hono'
import { AccountInactiveError, BasecampError, ForbiddenError, NotFoundError, UnexpectedResponseError, ValidationError } from '@naf-sheets/basecamp'
import type { BasecampClient, RawComment } from '@naf-sheets/basecamp'
import {
  ATTACHMENT_NAME_MAX_LENGTH,
  COMMENT_MAX_LENGTH,
  type AttachmentSettingsResponse,
  type CommentInfo,
  type CreateCommentResponse,
  type TaskAttachmentsResponse,
  type TaskCommentsResponse,
  type UploadAttachmentResponse,
} from '@naf-sheets/shared'
import { escapeHtml, htmlToComparableText } from '@naf-sheets/sync-engine'
import type { Caller, WorkbookAccess } from '../access'
import { canWrite, resolveAccess } from '../access'
import { auditStatement } from '../audit'
import type { AppEnv } from '../auth'
import { activeUserLink, LinkFailure, withUserToken } from '../basecamp-link'
import type { LinkContext } from '../basecamp-link'
import { getWorkbookRow } from '../db'
import type { Env } from '../env'
import { ApiFailure } from '../errors'
import { callerOf, isPlainObject, readJson } from '../request'
import { readClient, syncContext } from '../sync/deps'
import type { SyncDeps } from '../sync/deps'
import { loadWorkbookState } from '../sync/state'
import { getWorkbookSync, runBatches, syncLogStatement } from '../sync/store'
import type { SheetRow, TaskRow, WorkbookSyncRow } from '../sync/store'
import { writeAttachmentsCell } from './attachments-sync'
import { changeTodoDescription } from './description'
import { ATTACHMENT_FAILURES, commentInvalidMessage, onPhase5Error, Phase5Failure, tooLargeMessage } from './errors'
import type { AttachmentFailureCode } from './errors'
import { attachmentSettings, saveAttachmentSettings, validMaxBytes } from './settings'
import { ARCHIVE_DAYS, attachmentById, attachmentOfWorkbook, commentTarget, fileMode, liveAttachments, plusDays, taskOfWorkbook, toInfo } from './store'
import type { AttachmentRow } from './store'

interface Loaded {
  caller: Caller
  access: WorkbookAccess
  wb: WorkbookSyncRow
}

/** The workbook and the caller's access; 404 when missing or not accessible (never reveals it exists). */
async function load(c: Context<AppEnv>): Promise<Loaded> {
  const caller = callerOf(c)
  const id = c.req.param('id') ?? ''
  if (id === '' || id.length > 128) throw new ApiFailure(404, 'workbook_not_found')
  const row = await getWorkbookRow(c.env.DB, caller.id, id)
  const access = row ? resolveAccess(caller, row.owner_id, row.member_role) : null
  if (!row || access === null) throw new ApiFailure(404, 'workbook_not_found')
  const wb = await getWorkbookSync(c.env.DB, id)
  if (!wb) throw new ApiFailure(404, 'workbook_not_found')
  return { caller, access, wb }
}

function requireWrite(loaded: Loaded): void {
  if (!canWrite(loaded.access)) throw new Phase5Failure('forbidden_write')
}

async function taskOf(db: D1Database, wb: WorkbookSyncRow, uid: string | undefined): Promise<{ task: TaskRow; sheet: SheetRow }> {
  const found = await taskOfWorkbook(db, wb.id, uid ?? '')
  if (!found) throw new Phase5Failure('task_not_found')
  return found
}

const nowIso = (deps: SyncDeps) => new Date(deps.now()).toISOString()

// ---------------------------------------------------------------------------
// Upload input
// ---------------------------------------------------------------------------

// Controls, and the bidi overrides a file name could use to disguise its extension.
const UNSAFE_NAME = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/** The file name as stored and shown, or null when it cannot be one. */
export function cleanFileName(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.normalize('NFC').replace(UNSAFE_NAME, '').replace(/[\\/]/g, '_').replace(/\s+/g, ' ').trim()
  if (name === '' || name === '.' || name === '..' || [...name].length > ATTACHMENT_NAME_MAX_LENGTH) return null
  return name
}

/** The file's media type, or `application/octet-stream` when it is missing or not one. */
export function cleanContentType(raw: string | undefined): string {
  const type = (raw ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  return /^[a-z0-9][\w.+-]*\/[\w.+-]+$/.test(type) ? type : 'application/octet-stream'
}

/** `Content-Disposition` with an ASCII fallback and the UTF-8 name (RFC 6266). */
function disposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

// ---------------------------------------------------------------------------
// Basecamp step of an upload (and its retry)
// ---------------------------------------------------------------------------

function failureOf(error: unknown): AttachmentFailureCode | null {
  if (error instanceof LinkFailure) return error.key === 'basecamp_unavailable' ? 'unavailable' : error.key === 'not_configured' ? 'unavailable' : 'not_linked'
  if (error instanceof Phase5Failure) {
    if (error.key === 'task_busy') return 'busy'
    if (error.key === 'task_deleted_remotely') return 'deleted_remotely'
    if (error.key === 'task_not_in_basecamp') return 'not_found'
    return null
  }
  if (error instanceof AccountInactiveError) return 'account_inactive'
  if (error instanceof ForbiddenError) return 'forbidden'
  if (error instanceof NotFoundError) return 'not_found'
  if (error instanceof UnexpectedResponseError) return 'unexpected'
  if (error instanceof BasecampError) return error.retryable ? 'unavailable' : 'rejected'
  return null
}

/**
 * Sends a stored file to Basecamp and into the to-do's description, with the
 * caller's token. Never throws for a Basecamp or link problem: the file is then
 * `failed` with the reason (it stays in the platform, §10).
 */
async function sendToBasecamp(env: Env, deps: SyncDeps, ctx: LinkContext, wb: WorkbookSyncRow, row: AttachmentRow, caller: Caller): Promise<void> {
  const db = env.DB
  try {
    await withUserToken(ctx, caller.id, async (token) => {
      const client: BasecampClient = readClient(ctx)
      let sgid = row.bc_sgid
      if (sgid === null) {
        // Streamed from the platform's copy for each attempt; never held whole in memory.
        const { attachableSgid } = await client.attachments.upload(token, {
          name: row.filename,
          contentType: row.mime ?? 'application/octet-stream',
          data: {
            byteLength: row.size,
            open: async () => {
              const object = await env.ATTACHMENTS.get(row.r2_key)
              if (!object) throw new Error('the stored copy is missing')
              return object.body.pipeThrough(new FixedLengthStream(row.size))
            },
          },
        })
        sgid = attachableSgid
        await db.prepare(`UPDATE attachments SET bc_sgid = ?2, updated_at = ?3 WHERE id = ?1`).bind(row.id, sgid, nowIso(deps)).run()
      }
      const fileSgid = sgid
      await changeTodoDescription({
        env,
        deps,
        client,
        token,
        actor: caller.id,
        wb,
        uid: row.task_uid,
        change: { kind: 'add', sgid: fileSgid },
        onWritten: async () => {
          await db
            .prepare(`UPDATE attachments SET state = 'attached', last_error = NULL, last_error_code = NULL, updated_at = ?2 WHERE id = ?1`)
            .bind(row.id, nowIso(deps))
            .run()
        },
      })
    })
  } catch (error) {
    // Any failure leaves the file in the platform as `failed` (never stuck `uploading`), with a retry.
    const known = failureOf(error)
    const code: AttachmentFailureCode = known ?? 'unexpected'
    if (known === null || code === 'unexpected' || code === 'unavailable') console.warn(`phase5: an upload to Basecamp failed (${error instanceof Error ? error.name : 'unknown'})`)
    await runBatches(db, [
      db
        .prepare(`UPDATE attachments SET state = 'failed', last_error = ?2, last_error_code = ?3, updated_at = ?4 WHERE id = ?1 AND removed_at IS NULL`)
        .bind(row.id, ATTACHMENT_FAILURES[code], code, nowIso(deps)),
      syncLogStatement(db, { workbookId: wb.id, taskUid: row.task_uid, direction: 'out', action: 'attach_file', newValue: { attachmentId: row.id }, actor: caller.id, status: 'error', error: code }, nowIso(deps)),
    ])
  }
}

/** The task's list, for every answer that returns it. */
async function listResponse(env: Env, loaded: Loaded, task: TaskRow, sheet: SheetRow): Promise<TaskAttachmentsResponse> {
  const settings = await attachmentSettings(env.SETTINGS)
  const mode = fileMode(loaded.wb, sheet, task)
  return {
    taskUid: task.task_uid,
    level: task.level,
    attachments: (await liveAttachments(env.DB, task.task_uid)).map((r) => toInfo(r, loaded.wb.id)),
    settings,
    notice: mode.kind === 'basecamp' ? null : mode.notice,
    canEdit: canWrite(loaded.access) && mode.kind !== 'refused',
  }
}

/** The attachments cell after a change (a server write the open editors receive). */
async function refreshCell(env: Env, wb: WorkbookSyncRow, uid: string, at: string): Promise<void> {
  const state = await loadWorkbookState(env, wb)
  if (state) await writeAttachmentsCell(env, state, uid, at)
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

function commentInfo(c: RawComment): CommentInfo {
  const attachments = Array.isArray(c.content_attachments)
    ? c.content_attachments.map((a) => (typeof a?.filename === 'string' ? a.filename : '')).filter((n) => n !== '')
    : []
  const creator = c.creator as { name?: unknown; avatar_url?: unknown } | undefined
  return {
    id: c.id,
    // Plain text only: Basecamp's markup is never rendered by the platform.
    text: htmlToComparableText(typeof c.content === 'string' ? c.content : ''),
    creatorName: typeof creator?.name === 'string' ? creator.name : '',
    creatorAvatarUrl: typeof creator?.avatar_url === 'string' ? creator.avatar_url : null,
    createdAt: c.created_at,
    appUrl: typeof c.app_url === 'string' && c.app_url.startsWith('https://') ? c.app_url : null,
    attachments,
  }
}

/** Plain text → the rich text Basecamp takes (only `div` and `br`, escaped). */
export function commentHtml(text: string): string {
  const lines = text.split(/\r\n|\r|\n/).map((l) => escapeHtml(l))
  return `<div>${lines.join('<br>')}</div>`
}

/** A Basecamp refusal on a comment or download with the person's token, as the caller should read it. */
function basecampRefusal(error: unknown): unknown {
  if (error instanceof ForbiddenError || error instanceof NotFoundError) return new Phase5Failure('basecamp_access_denied')
  if (error instanceof ValidationError) return new Phase5Failure('task_deleted_remotely')
  if (error instanceof BasecampError && error.code !== 'unauthorized') {
    console.warn(`phase5: Basecamp ${error.code} (${error.status ?? 'no response'})`)
    return new LinkFailure('basecamp_unavailable')
  }
  return error
}

function bcUrlOf(env: Env, wb: WorkbookSyncRow, todoId: number | null): string | null {
  const account = (env as Env & { BASECAMP_ACCOUNT_ID?: string }).BASECAMP_ACCOUNT_ID?.trim() ?? ''
  if (!/^[1-9]\d{0,15}$/.test(account) || wb.bc_project_id === null || todoId === null) return null
  // OPEN: built from the documented app URL pattern, as for the sync state (S13).
  return `https://3.basecamp.com/${account}/buckets/${wb.bc_project_id}/todos/${todoId}`
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function phase5WorkbookRoutes(deps: SyncDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()
  routes.onError(onPhase5Error)

  // ── Attachments (§10)
  routes.get('/:id/tasks/:uid/attachments', async (c) => {
    const loaded = await load(c)
    const { task, sheet } = await taskOf(c.env.DB, loaded.wb, c.req.param('uid'))
    return c.json<TaskAttachmentsResponse>(await listResponse(c.env, loaded, task, sheet))
  })

  routes.post('/:id/tasks/:uid/attachments', async (c) => {
    const loaded = await load(c)
    requireWrite(loaded)
    const { wb, caller } = loaded
    const env = c.env
    const { task, sheet } = await taskOf(env.DB, wb, c.req.param('uid'))
    const mode = fileMode(wb, sheet, task)
    if (mode.kind === 'refused') throw new Phase5Failure(mode.key)
    const filename = cleanFileName(c.req.query('name'))
    if (filename === null) throw new Phase5Failure('attachment_invalid_name')
    const declared = c.req.header('content-length')
    if (declared === undefined || !/^\d{1,16}$/.test(declared.trim())) throw new Phase5Failure('length_required')
    const length = Number(declared.trim())
    const settings = await attachmentSettings(env.SETTINGS)
    // Refused before a byte is read (spec §10: a clear message over the limit).
    if (length > settings.maxBytes) throw new Phase5Failure('attachment_too_large', tooLargeMessage(settings.maxBytes))
    if (length === 0) throw new Phase5Failure('attachment_empty')
    const body = c.req.raw.body
    if (!body) throw new Phase5Failure('attachment_empty')
    const ctx = mode.kind === 'basecamp' ? syncContext(env, deps) : null
    // Nothing is stored for a person who could not send it on: their own link is checked first (§3).
    if (ctx) await activeUserLink(ctx, caller.id)

    const id = crypto.randomUUID()
    const key = `attachments/${wb.id}/${task.task_uid}/${id}`
    const mime = cleanContentType(c.req.header('content-type'))
    // Streamed to R2: the declared length is enforced byte for byte, the file is never held whole in memory.
    const fixed = new FixedLengthStream(length)
    const [piped, stored] = await Promise.allSettled([
      body.pipeTo(fixed.writable),
      env.ATTACHMENTS.put(key, fixed.readable, {
        httpMetadata: { contentType: mime },
        customMetadata: { workbookId: wb.id, taskUid: task.task_uid, attachmentId: id, uploadedBy: caller.id },
      }),
    ])
    if (piped.status === 'rejected') throw new Phase5Failure('upload_incomplete')
    if (stored.status === 'rejected' || stored.value === null || stored.value.size !== length) {
      console.error(`phase5: storing a file of workbook ${wb.id} failed`)
      throw new Phase5Failure('storage_failed')
    }
    const at = nowIso(deps)
    const state = mode.kind === 'basecamp' ? 'uploading' : 'local_only'
    await env.DB.prepare(
      `INSERT INTO attachments (id, task_uid, r2_key, filename, size, mime, bc_sgid, bc_blob_url, origin, created_by, created_at, state, r2_stored, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, 'local', ?7, ?8, ?9, 1, ?8)`,
    )
      .bind(id, task.task_uid, key, filename, length, mime, caller.id, at, state)
      .run()
    const row = (await attachmentById(env.DB, id)) as AttachmentRow
    if (ctx) await sendToBasecamp(env, deps, ctx, wb, row, caller)
    await refreshCell(env, wb, task.task_uid, nowIso(deps))
    const list = await listResponse(env, loaded, task, sheet)
    const attachment = list.attachments.find((a) => a.id === id) ?? toInfo((await attachmentById(env.DB, id)) as AttachmentRow, wb.id)
    return c.json<UploadAttachmentResponse>({ attachment, attachments: list.attachments }, 201)
  })

  routes.post('/:id/attachments/:attachmentId/retry', async (c) => {
    const loaded = await load(c)
    requireWrite(loaded)
    const { wb, caller } = loaded
    const env = c.env
    const row = await attachmentOfWorkbook(env.DB, wb.id, c.req.param('attachmentId') ?? '')
    if (!row || row.removed_at !== null) throw new Phase5Failure('attachment_not_found')
    if (row.state !== 'failed' || row.r2_stored !== 1) throw new Phase5Failure('attachment_not_retryable')
    const { task, sheet } = await taskOf(env.DB, wb, row.task_uid)
    const mode = fileMode(wb, sheet, task)
    if (mode.kind === 'refused') throw new Phase5Failure(mode.key)
    if (mode.kind === 'local') throw new Phase5Failure('attachment_not_retryable')
    const ctx = syncContext(env, deps)
    await activeUserLink(ctx, caller.id)
    await env.DB.prepare(`UPDATE attachments SET state = 'uploading', updated_at = ?2 WHERE id = ?1`).bind(row.id, nowIso(deps)).run()
    await sendToBasecamp(env, deps, ctx, wb, { ...row, state: 'uploading' }, caller)
    await refreshCell(env, wb, task.task_uid, nowIso(deps))
    const list = await listResponse(env, loaded, task, sheet)
    const attachment = list.attachments.find((a) => a.id === row.id) as UploadAttachmentResponse['attachment']
    return c.json<UploadAttachmentResponse>({ attachment, attachments: list.attachments })
  })

  routes.post('/:id/attachments/:attachmentId/remove', async (c) => {
    const loaded = await load(c)
    requireWrite(loaded)
    const { wb, caller } = loaded
    const env = c.env
    const body = await readJson(c)
    // §10: only after the person confirmed.
    if (!isPlainObject(body) || body.confirmed !== true) throw new Phase5Failure('attachment_not_confirmed')
    const row = await attachmentOfWorkbook(env.DB, wb.id, c.req.param('attachmentId') ?? '')
    if (!row || row.removed_at !== null) throw new Phase5Failure('attachment_not_found')
    const { task, sheet } = await taskOf(env.DB, wb, row.task_uid)
    const mode = fileMode(wb, sheet, task)
    const at = nowIso(deps)
    const purgeAfter = row.r2_stored === 1 ? plusDays(at, ARCHIVE_DAYS) : null
    const markRemoved = async () => {
      await runBatches(env.DB, [
        env.DB
          .prepare(`UPDATE attachments SET removed_at = ?2, removed_by = ?3, purge_after = ?4, updated_at = ?2 WHERE id = ?1 AND removed_at IS NULL`)
          .bind(row.id, at, caller.id, purgeAfter),
        auditStatement(
          env.DB,
          {
            actorId: caller.id,
            action: 'attachment.remove',
            entityType: 'attachment',
            entityId: row.id,
            workbookId: wb.id,
            details: { taskUid: row.task_uid, filename: row.filename, origin: row.origin, bcSgid: row.bc_sgid, r2Kept: row.r2_stored === 1, purgeAfter },
          },
          at,
        ),
      ])
    }
    // The file leaves the description in Basecamp first; only then does the chip go (§10).
    if (mode.kind === 'basecamp' && row.bc_sgid !== null) {
      const ctx = syncContext(env, deps)
      const sgid = row.bc_sgid
      try {
        await withUserToken(ctx, caller.id, (token) =>
          changeTodoDescription({ env, deps, client: readClient(ctx), token, actor: caller.id, wb, uid: row.task_uid, change: { kind: 'remove', sgid }, onWritten: markRemoved }),
        )
      } catch (error) {
        throw basecampRefusal(error)
      }
    } else {
      // OPEN (P5): a to-do deleted in Basecamp, a subtask's or a local file: only the platform's chip goes.
      await markRemoved()
    }
    await refreshCell(env, wb, task.task_uid, nowIso(deps))
    return c.json<TaskAttachmentsResponse>(await listResponse(env, loaded, task, sheet))
  })

  routes.get('/:id/attachments/:attachmentId/download', async (c) => {
    const loaded = await load(c)
    const env = c.env
    const row = await attachmentOfWorkbook(env.DB, loaded.wb.id, c.req.param('attachmentId') ?? '')
    if (!row || row.removed_at !== null) throw new Phase5Failure('attachment_not_found')
    const headers = new Headers({
      'content-disposition': disposition(row.filename),
      'x-content-type-options': 'nosniff',
      // Never rendered as a page of this origin, whatever the file says it is.
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'no-store',
    })
    if (row.r2_stored === 1) {
      const object = await env.ATTACHMENTS.get(row.r2_key)
      if (object) {
        headers.set('content-type', row.mime ?? object.httpMetadata?.contentType ?? 'application/octet-stream')
        headers.set('content-length', String(object.size))
        return new Response(object.body, { status: 200, headers })
      }
      if (row.bc_blob_url === null) throw new Phase5Failure('attachment_not_found')
    }
    if (row.bc_blob_url === null) throw new Phase5Failure('attachment_gone_remotely')
    // Basecamp's copy, read with the caller's own token (§3, §10 «بصلاحيات المستخدم»).
    // OPEN (P7): a viewer who never linked Basecamp cannot download a file that came from it.
    const ctx = syncContext(env, deps)
    const url = row.bc_blob_url
    try {
      const file = await withUserToken(ctx, loaded.caller.id, (token) => readClient(ctx).attachments.download(token, url))
      headers.set('content-type', row.mime ?? file.contentType ?? 'application/octet-stream')
      if (file.contentLength !== null) headers.set('content-length', String(file.contentLength))
      return new Response(file.body, { status: 200, headers })
    } catch (error) {
      if (error instanceof NotFoundError) throw new Phase5Failure('attachment_gone_remotely')
      if (error instanceof TypeError) throw new Phase5Failure('attachment_gone_remotely')
      throw basecampRefusal(error)
    }
  })

  // ── Comments (§12.1 item 5; §8 table: on to-dos only)
  routes.get('/:id/tasks/:uid/comments', async (c) => {
    const loaded = await load(c)
    const env = c.env
    const { task } = await taskOf(env.DB, loaded.wb, c.req.param('uid'))
    const target = await commentTarget(env.DB, task)
    if (!target || target.bc_recording_id === null) throw new Phase5Failure('task_not_in_basecamp')
    const todoId = target.bc_recording_id
    const ctx = syncContext(env, deps)
    let raw: RawComment[]
    try {
      raw = await withUserToken(ctx, loaded.caller.id, (token) => readClient(ctx).comments.list(token, todoId).all())
    } catch (error) {
      throw basecampRefusal(error)
    }
    const comments = raw.filter((r) => r.status === undefined || r.status === 'active').map(commentInfo)
    await env.DB.prepare(`UPDATE tasks SET bc_comments_count = ?2, bc_comments_seen_at = ?3 WHERE task_uid = ?1`).bind(target.task_uid, comments.length, nowIso(deps)).run()
    return c.json<TaskCommentsResponse>({
      taskUid: task.task_uid,
      targetUid: target.task_uid,
      onParent: target.task_uid !== task.task_uid,
      comments,
      commentsCount: comments.length,
      bcUrl: bcUrlOf(env, loaded.wb, todoId),
      canComment: canWrite(loaded.access),
    })
  })

  routes.post('/:id/tasks/:uid/comments', async (c) => {
    const loaded = await load(c)
    requireWrite(loaded)
    const env = c.env
    const body = await readJson(c)
    const text = isPlainObject(body) && typeof body.content === 'string' ? body.content.replace(/\r\n?/g, '\n').trim() : ''
    if (text === '' || [...text].length > COMMENT_MAX_LENGTH) throw new Phase5Failure('comment_invalid', commentInvalidMessage(COMMENT_MAX_LENGTH))
    const { task } = await taskOf(env.DB, loaded.wb, c.req.param('uid'))
    const target = await commentTarget(env.DB, task)
    if (!target || target.bc_recording_id === null) throw new Phase5Failure('task_not_in_basecamp')
    if (target.remote_status !== 'active') throw new Phase5Failure('task_deleted_remotely')
    const todoId = target.bc_recording_id
    const ctx = syncContext(env, deps)
    let created: RawComment
    try {
      // With the caller's own token: the comment appears in Basecamp under their name (§3).
      created = await withUserToken(ctx, loaded.caller.id, (token) => readClient(ctx).comments.create(token, todoId, commentHtml(text)))
    } catch (error) {
      throw basecampRefusal(error)
    }
    const at = nowIso(deps)
    await runBatches(env.DB, [
      env.DB.prepare(`UPDATE tasks SET bc_comments_count = COALESCE(bc_comments_count, 0) + 1, bc_comments_seen_at = ?2 WHERE task_uid = ?1`).bind(target.task_uid, at),
      // The comment's text is the person's data: only its id is logged (§14).
      syncLogStatement(env.DB, { workbookId: loaded.wb.id, taskUid: target.task_uid, direction: 'out', action: 'create_comment', newValue: { commentId: created.id }, actor: loaded.caller.id, status: 'ok' }, at),
    ])
    const count = await env.DB.prepare(`SELECT bc_comments_count AS n FROM tasks WHERE task_uid = ?1`).bind(target.task_uid).first<{ n: number | null }>()
    return c.json<CreateCommentResponse>({ comment: commentInfo(created), commentsCount: count?.n ?? 1 }, 201)
  })

  return routes
}

/** GET /api/attachment-settings (every member) and PUT /api/admin/attachment-settings (admins). */
export function attachmentSettingsRoutes(): { read: Hono<AppEnv>; admin: Hono<AppEnv> } {
  const read = new Hono<AppEnv>()
  read.onError(onPhase5Error)
  read.get('/', async (c) => {
    callerOf(c)
    return c.json<AttachmentSettingsResponse>(await attachmentSettings(c.env.SETTINGS))
  })
  const admin = new Hono<AppEnv>()
  admin.onError(onPhase5Error)
  admin.put('/', async (c) => {
    const caller = callerOf(c)
    if (caller.role !== 'admin') throw new Phase5Failure('admin_only')
    const body = await readJson(c)
    const maxBytes = isPlainObject(body) ? body.maxBytes : undefined
    if (!validMaxBytes(maxBytes)) throw new Phase5Failure('invalid_settings')
    const at = new Date().toISOString()
    const saved = await saveAttachmentSettings(c.env.SETTINGS, maxBytes)
    await auditStatement(c.env.DB, { actorId: caller.id, action: 'settings.attachments', entityType: 'settings', entityId: 'attachments', workbookId: null, details: { maxBytes } }, at).run()
    return c.json<AttachmentSettingsResponse>(saved)
  })
  return { read, admin }
}
