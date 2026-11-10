// Shared steps of the phase 5 tests (attachments and comments), on top of the
// sync harness: a fake Basecamp, recording queues, nothing real is called.

import { env } from 'cloudflare:workers'
import { TEST_USER_HEADER } from '../helpers'
import type { Linked } from '../sync/harness'

export interface UploadOptions {
  user?: { id: string }
  contentType?: string
  /** `null`: no Content-Length header; a string: that header as given. */
  length?: string | null
  /** Send the bytes as a stream (no length known to the runtime). */
  stream?: boolean
}

/** POST …/tasks/:uid/attachments?name=… with the raw bytes, as the editor sends a file. */
export async function upload(l: Linked, uid: string, name: string, bytes: Uint8Array, options: UploadOptions = {}): Promise<Response> {
  const headers = new Headers({ [TEST_USER_HEADER]: (options.user ?? l.owner).id, 'content-type': options.contentType ?? 'application/pdf' })
  if (options.length !== null) headers.set('content-length', options.length ?? String(bytes.byteLength))
  const body: BodyInit = options.stream
    ? new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      })
    : bytes
  return l.h.app.request(`/api/workbooks/${l.wbId}/tasks/${encodeURIComponent(uid)}/attachments?name=${encodeURIComponent(name)}`, { method: 'POST', headers, body }, l.h.env)
}

export async function r2Keys(workbookId: string): Promise<string[]> {
  const listed = await env.ATTACHMENTS.list({ prefix: `attachments/${workbookId}/` })
  return listed.objects.map((o) => o.key)
}

export interface AttachmentDbRow {
  id: string
  task_uid: string
  r2_key: string
  filename: string
  size: number
  mime: string | null
  bc_sgid: string | null
  bc_blob_url: string | null
  origin: string
  created_by: string | null
  state: string
  r2_stored: number
  removed_at: string | null
  removed_by: string | null
  purge_after: string | null
  last_error: string | null
}

export async function attachmentRows(uid: string): Promise<AttachmentDbRow[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM attachments WHERE task_uid = ?1 ORDER BY created_at, id`).bind(uid).all<AttachmentDbRow>()
  return results
}

export const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)

/** The notes cell's stored description HTML (sheet-model keeps it in the cell's platform data). */
export function storedNotes(cell: Record<string, unknown> | undefined): string | undefined {
  const custom = cell?.['custom'] as { nafSheets?: { notesHtml?: string } } | undefined
  return custom?.nafSheets?.notesHtml
}
