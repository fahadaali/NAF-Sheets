// Pictures inserted in the editor go to the platform, never into the snapshot
// as base64 (apps/web OPEN_QUESTIONS.md I1): POST /api/workbooks/:id/images
// with the file's bytes (packages/shared/src/api-images.ts); the snapshot
// keeps the returned same-origin URL. No Univer import: unit-tested alone.

import { IMAGE_MAX_BYTES, IMAGE_TYPES, imagePath, type UploadImageResponse } from '@naf-sheets/shared'
import { t } from '../strings'

export type ImageUploadResult = { ok: true; url: string; imageId: string } | { ok: false; message: string }

/** Refusals the browser can tell before sending anything (the API checks the bytes again). */
export function checkImageFile(file: Pick<File, 'type' | 'size'>): string | null {
  if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) return t.images.typeNotAllowed
  if (file.size > IMAGE_MAX_BYTES) return t.images.tooLarge(IMAGE_MAX_BYTES / (1024 * 1024))
  if (file.size === 0) return t.images.typeNotAllowed
  return null
}

export function imageUploadPath(workbookId: string, name: string): string {
  return `/api/workbooks/${encodeURIComponent(workbookId)}/images?name=${encodeURIComponent(name)}`
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>

/** Sends one picture. Never throws: a refusal comes back with the API's Arabic message. */
export async function uploadImage(workbookId: string, file: File, fetchImpl: Fetch = (i, init) => fetch(i, init)): Promise<ImageUploadResult> {
  const refused = checkImageFile(file)
  if (refused) return { ok: false, message: refused }
  let res: Response
  try {
    res = await fetchImpl(imageUploadPath(workbookId, file.name), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': file.type },
      body: file,
    })
  } catch {
    return { ok: false, message: t.errors.network }
  }
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (res.status === 201 && typeof body === 'object' && body !== null && typeof (body as UploadImageResponse).imageId === 'string') {
    const { imageId } = body as UploadImageResponse
    return { ok: true, imageId, url: imagePath(workbookId, imageId) }
  }
  const message = typeof body === 'object' && body !== null && typeof (body as { message?: unknown }).message === 'string' ? (body as { message: string }).message : t.images.uploadFailed
  return { ok: false, message }
}
