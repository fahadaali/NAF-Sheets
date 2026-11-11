// The pictures an .xlsx holds (./images.ts) → stored by the caller, then
// written into the converted workbook by @naf-sheets/gsheets-import
// `applyImportedImages` (owner 2026-11-11; apps/api OPEN_QUESTIONS.md
// "Images" I10–I14). Only what is not imported is reported.

import { applyImportedImages, MESSAGES, univerSheetId, location, type ConvertResult, type ImportedImage, type SkippedImage } from '@naf-sheets/gsheets-import'
import { MAX_IMPORTED_PICTURES, pictureSize, type XlsxPicture } from './images'
import type { XlsxReadResult } from './read'

/**
 * Stores one picture's bytes (the API: type and size checked, R2, a URL).
 * `type`: the type the bytes are (when known) for the report.
 */
export type PictureStore = (bytes: Uint8Array, meta: { name: string | null }) => Promise<{ ok: true; url: string } | { ok: false; reason: 'type' | 'size'; type?: string }>

export interface PictureImportCounts {
  floating: number
  inCell: number
  skipped: number
}

const extensionType = (part: string) => (part.split('.').pop() ?? '').toUpperCase()

/** Stores and writes the pictures of `read` into `converted` (mutates it). Without `store`, every picture is reported. */
export async function importPictures(read: Pick<XlsxReadResult, 'pictures' | 'readPicture'>, converted: ConvertResult, store: PictureStore | undefined): Promise<PictureImportCounts> {
  const images: ImportedImage[] = []
  const skipped: SkippedImage[] = []
  const stored = new Map<string, { url: string; width: number | null; height: number | null } | SkippedImage['reason']>()
  const skip = (p: XlsxPicture, reason: SkippedImage['reason'], detail?: string) =>
    skipped.push({ sheetGid: p.sheet.gid, kind: p.kind, row: p.row, column: p.column, reason, ...(detail ? { detail } : {}) })

  if (!store) {
    for (const p of read.pictures) {
      converted.report.items.push({
        kind: p.kind === 'in_cell' ? 'cell_image' : 'drawing_image',
        outcome: 'not_transferred',
        location: location(univerSheetId(p.sheet.gid), p.sheet.name, { startRow: p.row, endRow: p.row, startColumn: p.column, endColumn: p.column }),
        message: MESSAGES.drawingImage(),
      })
    }
    return { floating: 0, inCell: 0, skipped: read.pictures.length }
  }

  let taken = 0
  for (const p of read.pictures) {
    if (p.part === null) {
      skip(p, p.missing === 'external' ? 'external' : 'missing', p.url)
      continue
    }
    let entry = stored.get(p.part)
    if (entry === undefined) {
      if (taken >= MAX_IMPORTED_PICTURES) entry = 'limit'
      else {
        const bytes = await read.readPicture(p.part)
        if (bytes === null) entry = 'limit'
        else {
          const result = await store(bytes, { name: p.part.split('/').pop() ?? null })
          if (result.ok) {
            const size = pictureSize(bytes)
            entry = { url: result.url, width: size?.width ?? null, height: size?.height ?? null }
            taken++
          } else entry = result.reason
        }
      }
      stored.set(p.part, entry)
    }
    if (typeof entry === 'string') {
      skip(p, entry, entry === 'type' ? extensionType(p.part) : undefined)
      continue
    }
    const base = { sheetGid: p.sheet.gid, source: entry.url, ...(p.title ? { title: p.title } : {}), ...(p.description ? { description: p.description } : {}) }
    if (p.kind === 'floating' && p.anchor) images.push({ ...base, kind: 'floating', anchor: p.anchor })
    else images.push({ ...base, kind: 'in_cell', row: p.row, column: p.column, width: entry.width, height: entry.height })
  }
  const applied = applyImportedImages(converted.workbook, converted.report, images, skipped)
  return { floating: applied.floating, inCell: applied.inCell, skipped: skipped.length }
}
