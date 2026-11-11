// REST contract for images over and in cells (owner, 2026-11-11; apps/api
// OPEN_QUESTIONS.md "Images"). apps/api implements it (src/images/), apps/web
// consumes it (src/images/), and the import stores the pictures of an .xlsx the
// same way.
//
// A picture is stored once in R2 (the ATTACHMENTS bucket, key
// `workbooks/{workbookId}/images/{imageId}`) and the workbook snapshot holds
// only its URL (`imagePath`), never the bytes. Whoever may open the workbook
// may read its images; viewers cannot add one (403 `forbidden`). Every JSON
// error is `ApiError` (./api) with an Arabic message.
//
// Images never reach Basecamp by themselves: a floating image is not part of
// any row, and an image inside a cell is sent only where that column's
// Basecamp field can hold a file (the notes / description of a to-do), as an
// attachment (spec §10). Everywhere else it is skipped without an error.

/** Largest picture accepted (bytes): uploads, and each picture of an imported file. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024

/**
 * Accepted picture types, recognised from the bytes themselves (the declared
 * type is not trusted). SVG is refused: it can carry script.
 */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type ImageType = (typeof IMAGE_TYPES)[number]

/** The id of a stored picture: 32 lower-case hex characters. */
export const IMAGE_ID_PATTERN = /^[0-9a-f]{32}$/

/**
 * POST /api/workbooks/:id/images?name=<file name> — the picture's bytes as the
 * body (no multipart), with `Content-Length`. Editors and admins only.
 * → 201 `UploadImageResponse`.
 *
 * Errors: 411 `image_length_required`, 400 `image_empty`, 413 `image_too_large`,
 * 415 `image_type_not_allowed`, 403 `forbidden` (viewer), 404 `workbook_not_found`.
 */
export interface UploadImageResponse {
  imageId: string
  /** Same-origin path the snapshot stores as the image's source (`imagePath`). */
  url: string
  contentType: ImageType
  size: number
}

/**
 * GET /api/workbooks/:id/images/:imageId — the picture, to anyone who may open
 * the workbook (404 `image_not_found` otherwise, never revealing it exists).
 * Served with its recognised type, `X-Content-Type-Options: nosniff` and a
 * sandboxing Content-Security-Policy.
 */
export function imagePath(workbookId: string, imageId: string): string {
  return `/api/workbooks/${encodeURIComponent(workbookId)}/images/${imageId}`
}

/** The workbook and image of a source written by `imagePath` (relative or absolute URL), or null. */
export function parseImagePath(source: unknown): { workbookId: string; imageId: string } | null {
  if (typeof source !== 'string') return null
  let path = source
  const scheme = /^https?:\/\/[^/]+/i.exec(path)
  if (scheme) path = path.slice(scheme[0].length)
  const m = /^\/api\/workbooks\/([^/?#]+)\/images\/([0-9a-f]{32})(?:[?#].*)?$/.exec(path)
  if (!m) return null
  let workbookId: string
  try {
    workbookId = decodeURIComponent(m[1] as string)
  } catch {
    return null
  }
  return workbookId === '' ? null : { workbookId, imageId: m[2] as string }
}

/** The type of a picture from its first bytes, or null when it is not one of `IMAGE_TYPES`. */
export function sniffImageType(head: Uint8Array): ImageType | null {
  const b = head
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return null
}
