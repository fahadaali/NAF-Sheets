// Pictures of a workbook in R2 (contract: packages/shared/src/api-images.ts):
// the ATTACHMENTS bucket, key `workbooks/{workbookId}/images/{imageId}`. The
// workbook snapshot holds only the picture's URL. An object is written once
// and never changed; nothing here deletes one (CLAUDE.md §3: deleting data
// needs the owner's approval; apps/api OPEN_QUESTIONS.md "Images" I9).

import { IMAGE_MAX_BYTES, imagePath, sniffImageType, type ImageType } from '@naf-sheets/shared'
import type { Env } from '../env'

export function imagePrefix(workbookId: string): string {
  return `workbooks/${workbookId}/images/`
}

export function imageKey(workbookId: string, imageId: string): string {
  return `${imagePrefix(workbookId)}${imageId}`
}

/** 32 random lower-case hex characters (`IMAGE_ID_PATTERN`). */
export function newImageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export type StoreImageResult =
  | { ok: true; imageId: string; url: string; contentType: ImageType; size: number; sha256: string }
  | { ok: false; reason: 'empty' | 'too_large' | 'type_not_allowed' }

export interface StoreImageMeta {
  /** members.user_id of the person who added it (an import: the importer). */
  uploadedBy: string
  /** 'editor' (inserted in the grid) or 'import' (a picture of an imported file). */
  origin: 'editor' | 'import'
  /** The name it had, for the audit and the headers; never trusted as a type. */
  name?: string | null
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Checks a picture (size, type recognised from its bytes: PNG, JPEG, GIF,
 * WebP; never SVG) and stores it under a new id. Never overwrites an object.
 */
export async function storeImage(env: Env, workbookId: string, bytes: Uint8Array, meta: StoreImageMeta): Promise<StoreImageResult> {
  if (bytes.byteLength === 0) return { ok: false, reason: 'empty' }
  if (bytes.byteLength > IMAGE_MAX_BYTES) return { ok: false, reason: 'too_large' }
  const type = sniffImageType(bytes.subarray(0, 16))
  if (type === null) return { ok: false, reason: 'type_not_allowed' }
  const imageId = newImageId()
  const sha256 = await sha256Hex(bytes)
  const stored = await env.ATTACHMENTS.put(imageKey(workbookId, imageId), bytes, {
    httpMetadata: { contentType: type },
    customMetadata: { workbookId, imageId, uploadedBy: meta.uploadedBy, origin: meta.origin, sha256, ...(meta.name ? { name: meta.name.slice(0, 255) } : {}) },
    // Create-only: an id is never reused.
    onlyIf: { etagDoesNotMatch: '*' },
  })
  if (stored === null) throw new Error('an image id was already taken')
  return { ok: true, imageId, url: imagePath(workbookId, imageId), contentType: type, size: bytes.byteLength, sha256 }
}

/** Reads a request body up to `max` bytes; null when it is longer (the rest is not read). */
export async function readLimited(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array | null> {
  const reader = body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    parts.push(value)
  }
  const out = new Uint8Array(size)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.byteLength
  }
  return out
}
