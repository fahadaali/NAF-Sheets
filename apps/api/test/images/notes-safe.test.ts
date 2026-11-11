// «Before the first real Basecamp link» Q1 and Q2 (apps/api OPEN_QUESTIONS.md):
// nothing leaves Basecamp unless a person's explicit action in the platform
// caused it.
//   Q1  changing a sheet's notes column removes nothing; only a picture a
//       person removed from the cell removes its file (I7 unchanged).
//   Q2  a notes cell that lost its stored description (a plain value pasted
//       over it) does not make the ordinary sync drop the to-do's files.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { findAttachmentElements, splitDescription } from '@naf-sheets/sync-engine'
import { TEST_USER_HEADER } from '../helpers'
import { drainOutbound, edit, harness, readSheetView, setupLinked, syncLog, todoByTitle } from '../sync/harness'
import type { Linked, SheetView } from '../sync/harness'
import { attachmentRows, bytesOf, upload } from '../phase5/helpers'
import { PNG_1PX } from './png'

const OLD_NOTES = 6 // column G
const NEW_NOTES = 12 // column M, empty
const title = 'إطلاق الحملة'
const text = 'راجع المسودة'

async function uploadImage(l: Linked): Promise<{ imageId: string; url: string }> {
  const res = await l.h.app.request(
    `/api/workbooks/${l.wbId}/images?name=${encodeURIComponent('مخطط.png')}`,
    { method: 'POST', headers: { [TEST_USER_HEADER]: l.owner.id, 'content-length': String(PNG_1PX.byteLength) }, body: PNG_1PX },
    l.h.env,
  )
  expect(res.status).toBe(201)
  return (await res.json()) as { imageId: string; url: string }
}

/** A cell holding one picture and text after it (Univer 1.4.0's cell-image document). */
function imageCell(source: string, body: string): Record<string, unknown> {
  const id = 'img1'
  return {
    t: 1,
    p: {
      id: 'd',
      drawings: {
        [id]: {
          unitId: 'd', subUnitId: 'd', drawingId: id, drawingType: 0, imageSourceType: 'URL', source,
          transform: { left: 0, top: 0, width: 40, height: 30 },
          docTransform: { size: { width: 40, height: 30 }, positionH: { relativeFrom: 0, posOffset: 0 }, positionV: { relativeFrom: 0, posOffset: 0 }, angle: 0 },
          behindDoc: 0, title: '', description: '', layoutType: 0, wrapText: 0, distB: 0, distL: 0, distR: 0, distT: 0,
        },
      },
      drawingsOrder: [id],
      body: {
        dataStream: `\r\b\r${body}\r\n`,
        paragraphs: [{ startIndex: 0 }, { startIndex: 2 }, { startIndex: 3 + body.length }],
        sectionBreaks: [{ startIndex: 4 + body.length }],
        customBlocks: [{ startIndex: 1, blockId: id }],
      },
    },
  }
}

function cellAt(view: SheetView, row: number, column: number): Record<string, unknown> {
  return ((view.cells[row] ?? {}) as Record<number, Record<string, unknown>>)[column] ?? {}
}

function setCell(view: SheetView, row: number, column: number, cell: Record<string, unknown>): void {
  view.cells[row] ??= {}
  ;(view.cells[row] as Record<number, Record<string, unknown>>)[column] = cell
}

function withoutPicture(cell: Record<string, unknown>, body: string): Record<string, unknown> {
  const { p: _p, ...rest } = cell
  return { ...rest, v: body, t: 1 }
}

/** A to-do with a PDF attached from the attachment editor and a picture in its notes cell, both in Basecamp. */
async function withSentPicture() {
  const h = harness()
  const l = await setupLinked(h, { rows: [{ title, notes: text, due: '2026-12-01' }] })
  const uid = (await readSheetView(l)).uid(title)
  expect((await upload(l, uid, 'خطة.pdf', bytesOf('%PDF-1.7'))).status).toBe(201)
  const image = await uploadImage(l)
  await edit(l, (v) => setCell(v, v.row(title), OLD_NOTES, { ...cellAt(v, v.row(title), OLD_NOTES), ...imageCell(image.url, text) }))
  await drainOutbound(h)
  const rows = await attachmentRows(uid)
  const picture = rows.find((r) => r.r2_key.endsWith(`cell-image-${image.imageId}`))!
  const pdf = rows.find((r) => r.filename === 'خطة.pdf')!
  expect(picture).toMatchObject({ state: 'attached' })
  expect(pdf).toMatchObject({ state: 'attached' })
  const todo = todoByTitle(h, title)
  const sgids = () => findAttachmentElements(splitDescription(todo.description).human).map((e) => e.sgid)
  expect(sgids()).toEqual([pdf.bc_sgid, picture.bc_sgid])
  return { h, l, uid, image, picture, pdf, todo, sgids }
}

/** The sheet's notes column moves from G to M (a settings change: the mapping rows). */
async function moveNotesColumn(l: Linked): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`UPDATE column_mappings SET field = 'free' WHERE sheet_id = ?1 AND column_key = 'G'`).bind(l.sheetId),
    env.DB.prepare(`INSERT INTO column_mappings (sheet_id, column_key, field, free_to_description) VALUES (?1, 'M', 'notes', 0)`).bind(l.sheetId),
  ])
}

const notesColumnOf = async (id: string) => (await env.DB.prepare(`SELECT notes_column FROM attachments WHERE id = ?1`).bind(id).first<{ notes_column: string | null }>())?.notes_column

/** Every description the fake Basecamp was sent after `from` still carries all of `sgids`. */
function expectNoDrop(h: Awaited<ReturnType<typeof withSentPicture>>['h'], from: number, sgids: Array<string | null>): void {
  for (const c of h.fake.writes().slice(from)) {
    const description = (c.body as { description?: string } | null)?.description
    if (description === undefined) continue
    for (const sgid of sgids) expect(description).toContain(sgid)
  }
}

describe('Q1: changing the notes column', () => {
  it('keeps every file and sends no PUT that drops one; the old pictures are simply no longer tracked', async () => {
    const { h, l, uid, picture, pdf, sgids } = await withSentPicture()
    expect(await notesColumnOf(picture.id)).toBe('G')
    const writes = h.fake.writes().length
    await moveNotesColumn(l)
    // Any later edit of the row runs its pictures step under the new column.
    await edit(l, (v) => v.set(v.row(title), 'D', '2026-12-09'))
    await drainOutbound(h)

    expectNoDrop(h, writes, [pdf.bc_sgid, picture.bc_sgid])
    expect(sgids()).toEqual([pdf.bc_sgid, picture.bc_sgid])
    const rows = await attachmentRows(uid)
    expect(rows.filter((r) => r.removed_at === null).map((r) => r.id).sort()).toEqual([pdf.id, picture.id].sort())
    expect(await syncLog(l.wbId, 'detach_file_snapshot')).toEqual([])
    expect(await syncLog(l.wbId, 'detach_file')).toEqual([])
    expect((await env.DB.prepare(`SELECT 1 FROM audit_log WHERE action = 'attachment.remove_notes_image'`).first())).toBeNull()
    // Still not tracked under the new column; a later edit changes nothing either.
    expect(await notesColumnOf(picture.id)).toBe('G')
    const after = h.fake.writes().length
    await edit(l, (v) => v.set(v.row(title), 'D', '2026-12-10'))
    await drainOutbound(h)
    expectNoDrop(h, after, [pdf.bc_sgid, picture.bc_sgid])
    expect(sgids()).toEqual([pdf.bc_sgid, picture.bc_sgid])
  })

  it('also with the picture taken out of the old column afterwards: it is no longer tracked there, so the file stays', async () => {
    const { h, l, uid, picture, pdf, sgids } = await withSentPicture()
    await moveNotesColumn(l)
    await edit(l, (v) => v.set(v.row(title), 'D', '2026-12-09'))
    await drainOutbound(h)
    const writes = h.fake.writes().length
    await edit(l, (v) => setCell(v, v.row(title), OLD_NOTES, withoutPicture(cellAt(v, v.row(title), OLD_NOTES), text)))
    await drainOutbound(h)
    expectNoDrop(h, writes, [pdf.bc_sgid, picture.bc_sgid])
    expect(sgids()).toEqual([pdf.bc_sgid, picture.bc_sgid])
    expect((await attachmentRows(uid)).find((r) => r.id === picture.id)?.removed_at).toBeNull()
  })

  it('a picture put into the new notes column is the same file (no second upload), tracked there; removing it from there removes the file', async () => {
    const { h, l, uid, image, picture, pdf, sgids } = await withSentPicture()
    await moveNotesColumn(l)
    await edit(l, (v) => v.set(v.row(title), 'D', '2026-12-09'))
    await drainOutbound(h)
    const uploads = h.fake.uploads.length
    await edit(l, (v) => setCell(v, v.row(title), NEW_NOTES, imageCell(image.url, text)))
    await drainOutbound(h)
    expect(h.fake.uploads.length).toBe(uploads)
    expect(await notesColumnOf(picture.id)).toBe('M')
    expect(sgids()).toContain(picture.bc_sgid)

    // A person removes it from the (new) notes cell: I7, the file goes.
    await edit(l, (v) => setCell(v, v.row(title), NEW_NOTES, withoutPicture(cellAt(v, v.row(title), NEW_NOTES), text)))
    await drainOutbound(h)
    expect(sgids()).toEqual([pdf.bc_sgid])
    const removed = (await attachmentRows(uid)).find((r) => r.id === picture.id)!
    expect(removed.removed_at).not.toBeNull()
    expect(removed.removed_by).toBe(l.owner.id)
  })
})

describe('Q2: a notes cell that lost its stored description', () => {
  async function withPdf() {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title, notes: text, due: '2026-12-01' }] })
    const uid = (await readSheetView(l)).uid(title)
    expect((await upload(l, uid, 'خطة.pdf', bytesOf('%PDF-1.7'))).status).toBe(201)
    const pdf = (await attachmentRows(uid)).find((r) => r.filename === 'خطة.pdf')!
    const todo = todoByTitle(h, title)
    const sgids = () => findAttachmentElements(splitDescription(todo.description).human).map((e) => e.sgid)
    expect(sgids()).toEqual([pdf.bc_sgid])
    return { h, l, uid, pdf, todo, sgids }
  }

  it('a different plain value pasted over the notes: the new text goes out, the file stays in the PUT and in Basecamp', async () => {
    const { h, l, uid, pdf, todo, sgids } = await withPdf()
    const writes = h.fake.writes().length
    await edit(l, (v) => setCell(v, v.row(title), OLD_NOTES, { v: 'نص لُصق من مكان آخر', t: 1 })) // no `custom`: the stored description is gone
    await drainOutbound(h)
    const puts = h.fake.writes().slice(writes).filter((c) => c.path === `/todos/${todo.id}.json`)
    expect(puts.length).toBeGreaterThan(0)
    for (const put of puts) expect((put.body as { description: string }).description).toContain(pdf.bc_sgid)
    expect(splitDescription(todo.description).human).toContain('نص لُصق من مكان آخر')
    expect(sgids()).toEqual([pdf.bc_sgid])
    expect((await attachmentRows(uid)).find((r) => r.id === pdf.id)).toMatchObject({ removed_at: null, state: 'attached' })
    expect(await syncLog(l.wbId, 'detach_file')).toEqual([])
  })

  it('the same text pasted back as a plain value (stored description gone): nothing is sent, the file stays', async () => {
    const { h, l, uid, pdf, todo, sgids } = await withPdf()
    const writes = h.fake.writes().length
    await edit(l, (v) => setCell(v, v.row(title), OLD_NOTES, { v: text, t: 1 }))
    await drainOutbound(h)
    expect(h.fake.writes().slice(writes).filter((c) => c.path === `/todos/${todo.id}.json`)).toEqual([])
    expect(sgids()).toEqual([pdf.bc_sgid])
    expect((await attachmentRows(uid)).find((r) => r.id === pdf.id)?.removed_at).toBeNull()
  })

  it('the cell emptied entirely: the file stays too', async () => {
    const { h, l, pdf, todo, sgids } = await withPdf()
    const writes = h.fake.writes().length
    await edit(l, (v) => setCell(v, v.row(title), OLD_NOTES, {}))
    await drainOutbound(h)
    for (const put of h.fake.writes().slice(writes).filter((c) => c.path === `/todos/${todo.id}.json`)) {
      expect((put.body as { description: string }).description).toContain(pdf.bc_sgid)
    }
    expect(sgids()).toEqual([pdf.bc_sgid])
  })

  it('a plain value pasted over a cell holding a picture: the picture (a person removed it) leaves, the PDF stays', async () => {
    const { h, l, uid, picture, pdf, sgids } = await withSentPicture()
    await edit(l, (v) => setCell(v, v.row(title), OLD_NOTES, { v: 'نص عادي', t: 1 }))
    await drainOutbound(h)
    expect(sgids()).toEqual([pdf.bc_sgid])
    expect((await attachmentRows(uid)).find((r) => r.id === picture.id)?.removed_at).not.toBeNull()
    expect((await attachmentRows(uid)).find((r) => r.id === pdf.id)?.removed_at).toBeNull()
    void l
  })
})

describe('unchanged by Q1 and Q2', () => {
  it('a person removing the picture from the notes cell still removes its file, and an undo puts it back', async () => {
    const { h, l, uid, picture, pdf, sgids } = await withSentPicture()
    let saved: Record<string, unknown> = {}
    await edit(l, (v) => {
      saved = cellAt(v, v.row(title), OLD_NOTES)
      setCell(v, v.row(title), OLD_NOTES, withoutPicture(saved, text))
    })
    await drainOutbound(h)
    expect(sgids()).toEqual([pdf.bc_sgid])
    expect((await attachmentRows(uid)).find((r) => r.id === picture.id)?.removed_at).not.toBeNull()
    const uploads = h.fake.uploads.length
    await edit(l, (v) => setCell(v, v.row(title), OLD_NOTES, saved)) // Ctrl+Z after the save
    await drainOutbound(h)
    expect(h.fake.uploads.length).toBe(uploads)
    expect(sgids()).toEqual([pdf.bc_sgid, picture.bc_sgid])
    expect((await attachmentRows(uid)).find((r) => r.id === picture.id)).toMatchObject({ removed_at: null, state: 'attached', bc_sgid: picture.bc_sgid })
  })
})
