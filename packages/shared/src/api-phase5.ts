// REST contract for phase 5: attachments (spec §10, §5.2 attachment cell
// editor) and comments in the task details panel (spec §12.1 item 5, §8 table:
// comments live on to-dos only). apps/api implements it (src/phase5/), apps/web
// consumes it. Every JSON error is `ApiError` (./api) with an Arabic message.
//
// Permissions: every route needs access to the workbook (404 otherwise, as in
// ./api). A `viewer` — of the workbook, or of the platform — is read-only on
// every route here: GET works, every write answers 403 `forbidden`, whatever
// the UI shows.
//
// Basecamp is written and read with the caller's own token (spec §3). A
// caller who has not linked Basecamp gets 403 `basecamp_not_linked` (with
// `link`) on the routes that reach Basecamp.

import type { IsoDateTime, TaskLevel, TaskUid } from './domain'

// ---------------------------------------------------------------------------
// Settings (spec §10 «الحد الأقصى للحجم», §12.1 item 8)
// ---------------------------------------------------------------------------

/** Spec §10: 100 MB unless an admin sets another limit. */
export const ATTACHMENT_DEFAULT_MAX_BYTES = 100 * 1024 * 1024
/** A file name longer than this is refused (`attachment_invalid_name`). */
export const ATTACHMENT_NAME_MAX_LENGTH = 255
/** Longest comment text the platform sends (characters, after trimming). */
export const COMMENT_MAX_LENGTH = 10_000

/**
 * Where a subtask's files go (spec §8 table, §17-5).
 * `local`: kept in the platform with a notice (Basecamp subtasks have no
 * attachments). The spec's alternative — attach to the parent to-do with a
 * reference to the subtask — is an open decision and is not offered yet.
 */
export type SubtaskAttachmentMode = 'local'

export interface AttachmentSettings {
  /** Largest file accepted, in bytes. */
  maxBytes: number
  subtaskMode: SubtaskAttachmentMode
}

/** GET /api/attachment-settings — every signed-in member (the editor checks sizes before uploading). */
export type AttachmentSettingsResponse = AttachmentSettings

/** PUT /api/admin/attachment-settings — platform admins only → 200 `AttachmentSettingsResponse`. */
export interface PutAttachmentSettingsRequest {
  /** 1 byte … `ATTACHMENT_DEFAULT_MAX_BYTES` (the request body limit the Worker can take). */
  maxBytes: number
}

// ---------------------------------------------------------------------------
// Attachments of a task (spec §10)
// ---------------------------------------------------------------------------

/**
 * - `uploading`: kept in the platform (R2); being sent to Basecamp.
 * - `attached`: in the to-do's description in Basecamp.
 * - `local_only`: kept in the platform only (a subtask's file, §8 table).
 * - `failed`: kept in the platform; sending it to Basecamp failed (`message`
 *   says why). «إعادة المحاولة» is POST …/retry.
 */
export type AttachmentState = 'uploading' | 'attached' | 'local_only' | 'failed'

export interface AttachmentInfo {
  id: string
  taskUid: TaskUid
  filename: string
  /** Bytes; 0 when Basecamp did not give the size of a file that came from it. */
  size: number
  mime: string | null
  /** `local`: uploaded from the platform; `basecamp`: found in the to-do's description in Basecamp. */
  origin: 'local' | 'basecamp'
  state: AttachmentState
  /** Arabic: what happened and what to do. Set for `failed`; null otherwise. */
  message: string | null
  /** Same-origin path of the download proxy (GET, with the caller's permissions). */
  downloadPath: string
  createdAt: IsoDateTime
}

/** GET /api/workbooks/:id/tasks/:uid/attachments — every role that may open the workbook. */
export interface TaskAttachmentsResponse {
  taskUid: TaskUid
  level: TaskLevel
  /** In the order they were added; removed files are not listed. */
  attachments: AttachmentInfo[]
  settings: AttachmentSettings
  /**
   * Arabic notice about the whole list, or null: a subtask's files stay in the
   * platform (§8 table); a to-do not in Basecamp yet cannot take files.
   */
  notice: string | null
  /** The caller may upload and remove here (a workbook editor, and the task can take files). */
  canEdit: boolean
}

/*
 * POST /api/workbooks/:id/tasks/:uid/attachments?name=<file name, URI-encoded>
 *   body: the file's bytes, as they are (not multipart, not JSON);
 *   `Content-Type`: the file's own media type (application/octet-stream when unknown);
 *   `Content-Length`: required, at most `AttachmentSettings.maxBytes`.
 * → 201 `UploadAttachmentResponse`.
 *
 * The file is streamed to R2 (the platform's copy), then — for a to-do already
 * in Basecamp — uploaded to Basecamp with the caller's token and embedded in
 * the to-do's description (a `<bc-attachment>` at the end of the person's
 * part, before the platform's managed block), and the full description is sent
 * again. When the Basecamp step fails the file stays in the platform with
 * `state: 'failed'` and the response is still 201.
 *
 * Refusals: 403 `forbidden` (viewer); 404 `task_not_found`; 409
 * `task_not_in_basecamp` (a to-do that has not reached Basecamp yet), 409
 * `task_deleted_remotely`; 411 `attachment_length_required`; 413
 * `attachment_too_large`; 400 `attachment_empty` / `attachment_invalid_name`.
 */
export interface UploadAttachmentResponse {
  attachment: AttachmentInfo
  /** The task's list after the upload. */
  attachments: AttachmentInfo[]
}

/**
 * POST /api/workbooks/:id/attachments/:attachmentId/remove → 200 `TaskAttachmentsResponse`.
 * Only after the person confirmed (spec §10): without `confirmed: true` the
 * answer is 400 `attachment_not_confirmed` and nothing changes. The file
 * leaves the to-do's description in Basecamp (the full description is sent
 * again with the caller's token); the platform's R2 copy is kept for 30 days.
 */
export interface RemoveAttachmentRequest {
  confirmed: true
}

/*
 * POST /api/workbooks/:id/attachments/:attachmentId/retry → 200 `UploadAttachmentResponse`:
 * sends a `failed` file to Basecamp again (from the platform's copy).
 *
 * GET /api/workbooks/:id/attachments/:attachmentId/download → the file
 * (`Content-Disposition: attachment`). Every role that may open the workbook.
 * The platform's copy when it has one; otherwise the file is read from
 * Basecamp with the caller's own token (403 `basecamp_not_linked` without it).
 */

// ---------------------------------------------------------------------------
// Comments (spec §12.1 item 5, §8 table, §9.3.5 `comment_created`)
// ---------------------------------------------------------------------------

export interface CommentInfo {
  id: number
  /** The comment as plain text (Basecamp's rich text with its markup removed), lines separated by "\n". */
  text: string
  creatorName: string
  creatorAvatarUrl: string | null
  createdAt: IsoDateTime
  /** The comment in Basecamp, or null. */
  appUrl: string | null
  /** Names of the files attached to the comment. */
  attachments: string[]
}

/**
 * GET /api/workbooks/:id/tasks/:uid/comments — every role that may open the
 * workbook, read with the caller's own token. A subtask has no comments in
 * Basecamp (§8 table): its parent to-do's comments are returned, with
 * `onParent: true`.
 */
export interface TaskCommentsResponse {
  taskUid: TaskUid
  /** The to-do whose comments these are: `taskUid` itself, or its parent. */
  targetUid: TaskUid
  onParent: boolean
  /** Oldest first. */
  comments: CommentInfo[]
  commentsCount: number
  /** The to-do in Basecamp, or null. */
  bcUrl: string | null
  /** The caller may add a comment (not a viewer). */
  canComment: boolean
}

/**
 * POST /api/workbooks/:id/tasks/:uid/comments → 201 `CreateCommentResponse`.
 * Plain text, 1…`COMMENT_MAX_LENGTH` characters after trimming; sent to the
 * to-do (the parent's, for a subtask row) with the caller's own token.
 * Refusals: 403 `forbidden` (viewer); 400 `comment_invalid`.
 */
export interface CreateCommentRequest {
  content: string
}
export interface CreateCommentResponse {
  comment: CommentInfo
  commentsCount: number
}
