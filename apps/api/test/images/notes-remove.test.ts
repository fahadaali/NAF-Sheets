// A picture removed from a to-do's notes cell leaves its description in
// Basecamp (owner 2026-11-11, apps/api OPEN_QUESTIONS.md "Images" I7):
// the next PUT /todos/{id}.json carries every field and the description
// without that one `<bc-attachment>`; nothing else is removed; the old
// description is logged first and the removal is audited; a to-do trashed or
// archived in Basecamp gets nothing; a floating picture never reaches
// Basecamp; an undo before the save (or before the queue ran) sends nothing.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { cellImages } from '@naf-sheets/sheet-model'
import { findAttachmentElements, splitDescription } from '@naf-sheets/sync-engine'
import { TEST_USER_HEADER } from '../helpers'
import { drainOutbound, edit, harness, readSheetView, setupLinked, syncLog, task, todoByTitle } from '../sync/harness'
import type { Linked, SheetView } from '../sync/harness'
import { attachmentRows, bytesOf, upload } from '../phase5/helpers'
import { sheetImage } from './drawing-ops'
import { PNG_1PX } from './png'

const NOTES = 6 // column G

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
function imageCell(source: string, text: string, id = 'img1'): Record<string, unknown> {
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
        dataStream: `\r\b\r${text}\r\n`,
        paragraphs: [{ startIndex: 0 }, { startIndex: 2 }, { startIndex: 3 + text.length }],
        sectionBreaks: [{ startIndex: 4 + text.length }],
        customBlocks: [{ startIndex: 1, blockId: id }],
      },
    },
  }
}

function notesCell(view: SheetView, row: number): Record<string, unknown> {
  return ((view.cells[row] ?? {}) as Record<number, Record<string, unknown>>)[NOTES] ?? {}
}

function setNotes(view: SheetView, row: number, cell: Record<string, unknown>): void {
  view.cells[row] ??= {}
  ;(view.cells[row] as Record<number, Record<string, unknown>>)[NOTES] = cell
}

/** The picture taken out of the notes cell as the editor leaves it: the text stays, the cell's platform data stays. */
function withoutPicture(cell: Record<string, unknown>, text: string): Record<string, unknown> {
  const { p: _p, ...rest } = cell
  return { ...rest, v: text, t: 1 }
}

const title = 'إطلاق الحملة'
const text = 'راجع المسودة'

/** A to-do with a PDF attached from the attachment editor and a picture in its notes cell, both in Basecamp. */
async function withSentPicture() {
  const h = harness()
  const l = await setupLinked(h, { rows: [{ title, notes: text, due: '2026-12-01' }] })
  const uid = (await readSheetView(l)).uid(title)
  expect((await upload(l, uid, 'خطة.pdf', bytesOf('%PDF-1.7'))).status).toBe(201)
  const image = await uploadImage(l)
  // Inserted into the cell as the editor does: the cell's platform data (the stored description) stays.
  await edit(l, (v) => setNotes(v, v.row(title), { ...notesCell(v, v.row(title)), ...imageCell(image.url, text) }))
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

async function auditOf(action: string, entityId: string) {
  const { results } = await env.DB.prepare(`SELECT actor_id, details_json, at FROM audit_log WHERE action = ?1 AND entity_id = ?2`).bind(action, entityId).all<{ actor_id: string; details_json: string; at: string }>()
  return results
}

describe('a picture removed from a to-do’s notes cell', () => {
  it('leaves the description: one PUT with every field, that attachment only, the person’s token; snapshot and audit written', async () => {
    const { h, l, uid, picture, pdf, todo, sgids } = await withSentPicture()
    todo.assigneeIds = [l.ownerPerson.id]
    todo.startsOn = '2026-11-20'
    const before = todo.description
    const writes = h.fake.writes().length
    h.outbound.take()

    await edit(l, (v) => setNotes(v, v.row(title), withoutPicture(notesCell(v, v.row(title)), text)))
    expect(h.outbound.sent.map((m) => m.body.taskUid)).toEqual([uid])
    await drainOutbound(h)

    const sent = h.fake.writes().slice(writes)
    expect(sent.map((c) => `${c.method} ${c.path}`)).toEqual([`PUT /todos/${todo.id}.json`])
    const put = sent[0]!
    expect(put.token).toBe(l.token)
    // PUT /todos clears what it omits (todos.md): every field is sent, as Basecamp had it.
    expect(Object.keys(put.body as object).sort()).toEqual(['assignee_ids', 'completion_subscriber_ids', 'content', 'description', 'due_on', 'notify', 'starts_on'])
    expect(put.body).toMatchObject({ content: title, assignee_ids: [l.ownerPerson.id], due_on: '2026-12-01', starts_on: '2026-11-20', notify: false })
    const { human: oldHuman, block } = splitDescription(before)
    expect((put.body as { description: string }).description).toBe(`${oldHuman.replace(`<bc-attachment sgid="${picture.bc_sgid}"></bc-attachment>`, '')}${block ?? ''}`)

    // Only the picture's file left; the PDF and the notes text stay.
    expect(sgids()).toEqual([pdf.bc_sgid])
    expect(splitDescription(todo.description).human).toContain(text)
    const rows = await attachmentRows(uid)
    expect(rows.find((r) => r.id === pdf.id)).toMatchObject({ removed_at: null, state: 'attached' })
    const removed = rows.find((r) => r.id === picture.id)!
    expect(removed).toMatchObject({ removed_by: l.owner.id, state: 'attached', r2_stored: 1 })
    expect(removed.removed_at).not.toBeNull()
    expect(removed.purge_after).not.toBeNull()
    const reason = await env.DB.prepare(`SELECT removed_reason FROM attachments WHERE id = ?1`).bind(picture.id).first<{ removed_reason: string }>()
    expect(reason?.removed_reason).toBe('notes_image')
    // The platform keeps its copy (§10).
    expect(await env.ATTACHMENTS.head(picture.r2_key)).not.toBeNull()

    // The description as it was, logged before the PUT; then the audit row.
    const snapshots = await syncLog(l.wbId, 'detach_file_snapshot')
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({ task_uid: uid, actor: l.owner.id, status: 'ok', direction: 'out' })
    expect(snapshots[0]!.old_value).toBe(before)
    expect(JSON.parse(snapshots[0]!.new_value!)).toMatchObject({ sgid: picture.bc_sgid, attachmentId: picture.id })
    const detach = await syncLog(l.wbId, 'detach_file')
    expect(detach.at(-1)!.id).toBeGreaterThan(snapshots[0]!.id)
    const audit = await auditOf('attachment.remove_notes_image', picture.id)
    expect(audit).toHaveLength(1)
    expect(audit[0]!.actor_id).toBe(l.owner.id)
    expect(JSON.parse(audit[0]!.details_json)).toMatchObject({ taskUid: uid, bcSgid: picture.bc_sgid, descriptionSnapshot: true, r2Kept: true })

    // The attachments cell names only the PDF; the row is fine; a later edit sends nothing more.
    const view = await readSheetView(l)
    expect(view.text(view.row(title), 'F')).toBe('خطة.pdf')
    expect((await task(uid)).last_error).toBeNull()
    const after = h.fake.writes().length
    await edit(l, (v) => v.set(v.row(title), 'D', '2026-12-05'))
    await drainOutbound(h)
    expect(sgids()).toEqual([pdf.bc_sgid])
    expect(h.fake.writes().slice(after).every((c) => !(c.body as { description?: string } | null)?.description?.includes(picture.bc_sgid!))).toBe(true)
  })

  it('comes back, the same file, when the picture comes back after the save (Ctrl+Z)', async () => {
    const { h, l, uid, picture, pdf, sgids } = await withSentPicture()
    let saved: Record<string, unknown> = {}
    await edit(l, (v) => {
      saved = notesCell(v, v.row(title))
      setNotes(v, v.row(title), withoutPicture(saved, text))
    })
    await drainOutbound(h)
    expect(sgids()).toEqual([pdf.bc_sgid])
    const uploads = h.fake.uploads.length

    await edit(l, (v) => setNotes(v, v.row(title), saved))
    await drainOutbound(h)
    expect(h.fake.uploads.length).toBe(uploads)
    const rows = await attachmentRows(uid)
    expect(rows.filter((r) => r.removed_at === null).map((r) => r.id).sort()).toEqual([pdf.id, picture.id].sort())
    expect(rows.find((r) => r.id === picture.id)).toMatchObject({ removed_at: null, state: 'attached', bc_sgid: picture.bc_sgid })
    expect(sgids()).toEqual([pdf.bc_sgid, picture.bc_sgid])
  })

  it('comes back when only the picture comes back (the cell’s stored description no longer names it)', async () => {
    const { h, l, uid, picture, pdf, sgids } = await withSentPicture()
    let saved: Record<string, unknown> = {}
    await edit(l, (v) => {
      saved = notesCell(v, v.row(title))
      setNotes(v, v.row(title), withoutPicture(saved, text))
    })
    await drainOutbound(h)
    expect(sgids()).toEqual([pdf.bc_sgid])
    const uploads = h.fake.uploads.length
    // The picture alone back, on the cell as it is now (its stored description learnt the removal).
    await edit(l, (v) => setNotes(v, v.row(title), { ...notesCell(v, v.row(title)), p: saved['p'] }))
    await drainOutbound(h)
    expect(h.fake.uploads.length).toBe(uploads)
    expect((await attachmentRows(uid)).find((r) => r.id === picture.id)).toMatchObject({ removed_at: null, state: 'attached', bc_sgid: picture.bc_sgid })
    expect(sgids()).toEqual([pdf.bc_sgid, picture.bc_sgid])
    expect(await auditOf('attachment.restore_notes_image', picture.id)).toHaveLength(1)
  })

  it('a file removed with the attachment editor is not touched again, and nothing a person attached in Basecamp is', async () => {
    const { h, l, uid, picture, todo, sgids } = await withSentPicture()
    // A file someone attached in Basecamp itself, at the end of the person's part.
    const { human, block } = splitDescription(todo.description)
    todo.description = `${human}<bc-attachment sgid="their-own-file"></bc-attachment>${block}`
    // The picture's own file removed from the chips first (confirmed, §10).
    const res = await l.h.app.request(
      `/api/workbooks/${l.wbId}/attachments/${picture.id}/remove`,
      { method: 'POST', headers: { [TEST_USER_HEADER]: l.owner.id, 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }) },
      l.h.env,
    )
    expect(res.status).toBe(200)
    const writes = h.fake.writes().length
    await edit(l, (v) => setNotes(v, v.row(title), withoutPicture(notesCell(v, v.row(title)), text)))
    await drainOutbound(h)
    // The row's ordinary step may send its notes again; no write drops their file or brings the removed one back.
    for (const c of h.fake.writes().slice(writes)) {
      const description = (c.body as { description?: string } | null)?.description
      expect(description).toContain('their-own-file')
      expect(description).not.toContain(picture.bc_sgid)
    }
    expect(await syncLog(l.wbId, 'detach_file_snapshot')).toEqual([])
    expect(sgids()).toContain('their-own-file')
    expect(await auditOf('attachment.remove_notes_image', picture.id)).toEqual([])
    expect((await attachmentRows(uid)).find((r) => r.id === picture.id)?.removed_by).toBe(l.owner.id)
  })

  for (const status of ['trashed', 'archived'] as const) {
    it(`of a to-do ${status} in Basecamp: nothing is sent, no error, the chip stays`, async () => {
      const { h, l, uid, picture, todo } = await withSentPicture()
      todo.status = status
      todo.updatedAt = h.fake.tick()
      const writes = h.fake.writes().length
      await edit(l, (v) => setNotes(v, v.row(title), withoutPicture(notesCell(v, v.row(title)), text)))
      await drainOutbound(h)
      expect(h.fake.writes().slice(writes).filter((c) => c.path === `/todos/${todo.id}.json`)).toEqual([])
      expect((await attachmentRows(uid)).find((r) => r.id === picture.id)).toMatchObject({ removed_at: null, state: 'attached', last_error: null })
      expect(await syncLog(l.wbId, 'detach_file_snapshot')).toEqual([])
      expect((await syncLog(l.wbId)).filter((e) => e.status === 'error')).toEqual([])
      expect(h.dlq.sent).toEqual([])
    })
  }
})

describe('nothing is sent', () => {
  it('when the removal is undone before the save', async () => {
    const { h, l, picture, sgids } = await withSentPicture()
    const writes = h.fake.writes().length
    h.outbound.take()
    await edit(l, (v) => {
      const cell = notesCell(v, v.row(title))
      setNotes(v, v.row(title), withoutPicture(cell, text))
      setNotes(v, v.row(title), cell) // Ctrl+Z before the save
    })
    expect(h.outbound.sent).toEqual([])
    await drainOutbound(h)
    expect(h.fake.writes().length).toBe(writes)
    expect(sgids()).toContain(picture.bc_sgid)
  })

  it('when the removal is undone in the next save, before the queue ran (the consumer reads the latest snapshot)', async () => {
    const { h, l, uid, picture, sgids } = await withSentPicture()
    const writes = h.fake.writes().length
    let saved: Record<string, unknown> = {}
    h.outbound.take()
    await edit(l, (v) => {
      saved = notesCell(v, v.row(title))
      setNotes(v, v.row(title), withoutPicture(saved, text))
    })
    expect(h.outbound.sent.map((m) => m.body.taskUid)).toEqual([uid])
    await edit(l, (v) => setNotes(v, v.row(title), saved))
    await drainOutbound(h)
    expect(h.fake.writes().length).toBe(writes)
    expect(sgids()).toContain(picture.bc_sgid)
    expect((await attachmentRows(uid)).find((r) => r.id === picture.id)?.removed_at).toBeNull()
  })

  it('when a floating picture over the cells is removed', async () => {
    const { h, l, picture, sgids } = await withSentPicture()
    const floating = await uploadImage(l)
    const resource = (data: unknown) => [{ name: 'SHEET_DRAWING_PLUGIN', data: JSON.stringify(data) }]
    const image = sheetImage(l.wbId, l.univerSheetId, { drawingId: 'f1', source: floating.url, column: NOTES, row: 1 })
    const writes = h.fake.writes().length
    const uploads = h.fake.uploads.length
    await edit(l, (v) => {
      ;(v.snapshot as unknown as { resources: unknown }).resources = resource({ [l.univerSheetId]: { data: { f1: image }, order: ['f1'] } })
    })
    await drainOutbound(h)
    await edit(l, (v) => {
      ;(v.snapshot as unknown as { resources: unknown }).resources = resource({ [l.univerSheetId]: { data: {}, order: [] } })
    })
    await drainOutbound(h)
    expect(h.fake.writes().length).toBe(writes)
    expect(h.fake.uploads.length).toBe(uploads)
    expect(sgids()).toContain(picture.bc_sgid)
    // The notes picture is still in its cell.
    const view = await readSheetView(l)
    expect(cellImages(notesCell(view, view.row(title)) as never)).toHaveLength(1)
  })
})
