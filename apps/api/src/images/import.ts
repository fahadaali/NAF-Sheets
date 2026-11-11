// Pictures of an imported .xlsx (upload or public Google link) are stored
// like a picture inserted in the editor (./store.ts): R2, checked by their
// bytes (PNG, JPEG, GIF, WebP; never SVG), at most IMAGE_MAX_BYTES each. The
// snapshot then holds their URLs (@naf-sheets/xlsx-import importPictures).
//
// They are stored before the workbook row exists (its id is chosen first). A
// file whose import then fails leaves its pictures in R2 under that unused
// id; nothing deletes them (CLAUDE.md §3; OPEN_QUESTIONS.md "Images" I9).

import type { PictureStore } from '@naf-sheets/xlsx-import'
import type { Env } from '../env'
import { storeImage } from './store'

export function importPictureStore(env: Env, workbookId: string, importerId: string): PictureStore {
  return async (bytes, meta) => {
    const stored = await storeImage(env, workbookId, bytes, { uploadedBy: importerId, origin: 'import', name: meta.name })
    if (stored.ok) return { ok: true, url: stored.url }
    return { ok: false, reason: stored.reason === 'too_large' ? 'size' : 'type' }
  }
}
