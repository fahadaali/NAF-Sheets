// Pictures over and in cells: upload and serving (contract:
// packages/shared/src/api-images.ts). A workbook nobody may open answers 404
// (as src/routes/workbooks.ts); a viewer reads pictures and is refused (403)
// on upload, whatever the UI shows (CLAUDE.md §2). Nothing here reaches
// Basecamp: a picture goes there only as a file of a to-do's description, on
// the sync path (./notes-images.ts).

import { Hono } from 'hono'
import type { Context } from 'hono'
import { IMAGE_ID_PATTERN, IMAGE_MAX_BYTES, type UploadImageResponse } from '@naf-sheets/shared'
import type { WorkbookAccess } from '../access'
import { canWrite, resolveAccess } from '../access'
import { auditStatement } from '../audit'
import type { AppEnv } from '../auth'
import { getWorkbookRow } from '../db'
import { ApiFailure, errorBody, jsonResponse } from '../errors'
import { callerOf } from '../request'
import { ImageFailure } from './errors'
import { imageKey, readLimited, storeImage } from './store'

async function access(c: Context<AppEnv>): Promise<{ workbookId: string; access: WorkbookAccess; callerId: string }> {
  const caller = callerOf(c)
  const id = c.req.param('id') ?? ''
  if (id === '' || id.length > 128) throw new ApiFailure(404, 'workbook_not_found')
  const row = await getWorkbookRow(c.env.DB, caller.id, id)
  const granted = row ? resolveAccess(caller, row.owner_id, row.member_role) : null
  if (!row || granted === null) throw new ApiFailure(404, 'workbook_not_found')
  return { workbookId: id, access: granted, callerId: caller.id }
}

export function imageRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()
  routes.onError((error, c) => {
    if (error instanceof ImageFailure) return jsonResponse(error.body(), error.status)
    if (error instanceof ApiFailure) return jsonResponse(errorBody(error.key), error.status)
    console.error(`images: unhandled ${error.name} on ${c.req.method} ${new URL(c.req.url).pathname}`)
    return jsonResponse(errorBody('internal'), 500)
  })

  routes.post('/:id/images', async (c) => {
    const { workbookId, access: granted, callerId } = await access(c)
    if (!canWrite(granted)) throw new ImageFailure('forbidden_write')
    const declared = c.req.header('content-length')
    if (declared === undefined || !/^\d{1,16}$/.test(declared.trim())) throw new ImageFailure('length_required')
    const length = Number(declared.trim())
    // Refused before a byte is read.
    if (length > IMAGE_MAX_BYTES) throw new ImageFailure('image_too_large')
    if (length === 0 || !c.req.raw.body) throw new ImageFailure('image_empty')
    const bytes = await readLimited(c.req.raw.body, IMAGE_MAX_BYTES)
    if (bytes === null) throw new ImageFailure('image_too_large')
    const name = (c.req.query('name') ?? '').replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, '').trim().slice(0, 255) || null
    let stored
    try {
      stored = await storeImage(c.env, workbookId, bytes, { uploadedBy: callerId, origin: 'editor', name })
    } catch {
      console.error(`images: storing a picture of workbook ${workbookId} failed`)
      throw new ImageFailure('storage_failed')
    }
    if (!stored.ok) throw new ImageFailure(stored.reason === 'empty' ? 'image_empty' : stored.reason === 'too_large' ? 'image_too_large' : 'image_type_not_allowed')
    await auditStatement(
      c.env.DB,
      { actorId: callerId, action: 'image.upload', entityType: 'image', entityId: stored.imageId, workbookId, details: { size: stored.size, type: stored.contentType, sha256: stored.sha256 } },
      new Date().toISOString(),
    ).run()
    return c.json<UploadImageResponse>({ imageId: stored.imageId, url: stored.url, contentType: stored.contentType, size: stored.size }, 201)
  })

  routes.get('/:id/images/:imageId', async (c) => {
    const imageId = c.req.param('imageId') ?? ''
    // Never reveals whether a workbook exists: the same 404 for both.
    let workbookId: string
    try {
      workbookId = (await access(c)).workbookId
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 404) throw new ImageFailure('image_not_found')
      throw error
    }
    if (!IMAGE_ID_PATTERN.test(imageId)) throw new ImageFailure('image_not_found')
    const object = await c.env.ATTACHMENTS.get(imageKey(workbookId, imageId))
    if (!object) throw new ImageFailure('image_not_found')
    const type = object.httpMetadata?.contentType ?? 'application/octet-stream'
    return new Response(object.body, {
      headers: {
        'content-type': type,
        'content-length': String(object.size),
        'x-content-type-options': 'nosniff',
        // Shown as a picture only; never run as a page of this origin.
        'content-security-policy': "default-src 'none'; sandbox",
        'cross-origin-resource-policy': 'same-origin',
        etag: object.httpEtag,
      },
    })
  })

  return routes
}
