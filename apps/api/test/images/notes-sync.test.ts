// Pictures inside cells and Basecamp, per column (apps/api OPEN_QUESTIONS.md
// "Images" I4): a picture in a to-do's notes cell goes out as a file of its
// description (the phase 5 path, with the editor's own token); a picture in
// the title, assignee, date or status cell is skipped — no error, no
// conflict, nothing cleared; inbound sync keeps every platform picture.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { imagePath } from '@naf-sheets/shared'
import { cellImages } from '@naf-sheets/sheet-model'
import { findAttachmentElements, splitDescription } from '@naf-sheets/sync-engine'
import { TEST_USER_HEADER } from '../helpers'
import { drainOutbound, edit, harness, readSheetView, reconcile, setupLinked, task, todoByTitle } from '../sync/harness'
import type { Linked } from '../sync/harness'
import { attachmentRows } from '../phase5/helpers'
import { PNG_1PX } from './png'

const COL = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6 } as const

async function uploadImage(l: Linked): Promise<{ imageId: string; url: string }> {
  const res = await l.h.app.request(
    `/api/workbooks/${l.wbId}/images?name=${encodeURIComponent('مخطط.png')}`,
    { method: 'POST', headers: { [TEST_USER_HEADER]: l.owner.id, 'content-length': String(PNG_1PX.byteLength) }, body: PNG_1PX },
    l.h.env,
  )
  expect(res.status).toBe(201)
  return (await res.json()) as { imageId: string; url: string }
}

/** A cell holding one picture and, optionally, text after it (Univer 1.4.0's cell-image document). */
function imageCell(source: string, text = '', id = 'img1'): Record<string, unknown> {
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
        dataStream: `\r\b\r${text === '' ? '' : `${text}\r`}\n`,
        paragraphs: [{ startIndex: 0 }, { startIndex: 2 }, ...(text === '' ? [] : [{ startIndex: 3 + text.length }])],
        sectionBreaks: [{ startIndex: 3 + (text === '' ? 0 : text.length + 1) }],
        customBlocks: [{ startIndex: 1, blockId: id }],
      },
    },
  }
}

function setCell(view: Awaited<ReturnType<typeof readSheetView>>, row: number, column: keyof typeof COL, cell: Record<string, unknown>) {
  view.cells[row] ??= {}
  ;(view.cells[row] as Record<number, Record<string, unknown>>)[COL[column]] = cell
}

describe('a picture in a to-do’s notes cell', () => {
  it('goes to Basecamp as a file of the description, with the editor’s token; once only', async () => {
    const h = harness()
    const title = 'إطلاق الحملة'
    const l = await setupLinked(h, { rows: [{ title, notes: 'راجع المسودة' }] })
    const image = await uploadImage(l)
    const view = await readSheetView(l)
    const row = view.row(title)
    const uid = view.uid(title)
    h.outbound.take()
    const ownerToken = h.fake.uploads.length
    await edit(l, (v) => setCell(v, row, 'G', imageCell(image.url, 'راجع المسودة')))
    // The text did not change: the row is queued for its picture alone.
    expect(h.outbound.sent.map((m) => m.body.taskUid)).toEqual([uid])
    await drainOutbound(h)

    expect(h.fake.uploads.length).toBe(ownerToken + 1)
    const sent = h.fake.uploads.at(-1)!
    expect(sent.contentType).toBe('image/png')
    expect(sent.bytes).toEqual(PNG_1PX)
    const todo = todoByTitle(h, title)
    const { human } = splitDescription(todo.description)
    expect(findAttachmentElements(human)).toHaveLength(1)
    expect(human).toContain('راجع المسودة')
    const rows = await attachmentRows(uid)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: 'attached', origin: 'local', created_by: l.owner.id, r2_key: `attachments/${l.wbId}/${uid}/cell-image-${image.imageId}` })
    expect(await env.ATTACHMENTS.head(rows[0]!.r2_key)).not.toBeNull()
    expect((await task(uid)).sync_state).toBe('synced')

    // The picture stays in the cell, the attachments cell names the file, and nothing is sent again.
    const after = await readSheetView(l)
    expect(cellImages(after.cells[row]?.[COL.G] as never)).toHaveLength(1)
    expect(after.text(row, 'F')).toContain('مخطط.png')
    h.outbound.take()
    await edit(l, (v) => v.set(v.row(title), 'D', '2026-12-30'))
    await drainOutbound(h)
    expect(h.fake.uploads.length).toBe(ownerToken + 1)
    expect(await attachmentRows(uid)).toHaveLength(1)
  })

  it('a picture of a subtask’s notes stays in the platform (Basecamp subtasks have no description)', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أم' }, { title: 'فرعية', indent: true, notes: 'x' }], hierarchy: { mode: 'indent' } as never })
    const image = await uploadImage(l)
    const view = await readSheetView(l)
    h.outbound.take()
    const before = h.fake.uploads.length
    await edit(l, (v) => setCell(v, v.row('فرعية'), 'G', imageCell(image.url, 'x')))
    await drainOutbound(h)
    expect(h.fake.uploads.length).toBe(before)
    expect(await attachmentRows(view.uid('فرعية'))).toEqual([])
  })
})

describe('a picture where Basecamp cannot hold one is skipped', () => {
  it('title, assignees, start and due dates and status holding only a picture: no error, no conflict, nothing cleared or sent', async () => {
    const h = harness()
    const title = 'تصميم الشعار'
    const l = await setupLinked(h, { rows: [{ title, assignees: 'أحمد المالك', starts: '2026-11-20', due: '2026-12-01', done: true, notes: 'ملاحظة' }] })
    await drainOutbound(h)
    const image = await uploadImage(l)
    const view = await readSheetView(l)
    const row = view.row(title)
    const uid = view.uid(title)
    const todo = todoByTitle(h, title)
    const before = { content: todo.content, assignees: [...todo.assigneeIds], due: todo.dueOn, starts: todo.startsOn, completed: todo.completed, description: todo.description }
    const writes = h.fake.writes().length
    h.outbound.take()

    await edit(l, (v) => {
      for (const c of ['A', 'B', 'C', 'D', 'E'] as const) setCell(v, row, c, imageCell(image.url, '', `img-${c}`))
    })
    await drainOutbound(h)

    expect(h.fake.writes().length).toBe(writes)
    expect(todo).toMatchObject({ content: before.content, assigneeIds: before.assignees, dueOn: before.due, startsOn: before.starts, completed: before.completed, description: before.description })
    const t = await task(uid)
    expect(t.sync_state).toBe('synced')
    expect(t.last_error).toBeNull()
    const { results } = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sync_conflicts WHERE task_uid = ?1`).bind(uid).all<{ n: number }>()
    expect(results[0]!.n).toBe(0)
    expect(await attachmentRows(uid)).toEqual([])
  })
})

describe('inbound sync keeps platform pictures', () => {
  it('a new title, due date and description from Basecamp keep the pictures of their cells', async () => {
    const h = harness()
    const title = 'حملة الربع الأول'
    const l = await setupLinked(h, { rows: [{ title, due: '2026-12-01', notes: 'قديم' }], service: true })
    await drainOutbound(h)
    const image = await uploadImage(l)
    const view = await readSheetView(l)
    const row = view.row(title)
    await edit(l, (v) => {
      setCell(v, row, 'A', imageCell(image.url, title, 'a'))
      setCell(v, row, 'D', imageCell(image.url, '', 'd'))
    })
    await drainOutbound(h)

    const todo = todoByTitle(h, title)
    todo.content = 'حملة الربع الأول المعدّلة'
    todo.dueOn = '2026-12-15'
    todo.description = '<div>وصف جديد من Basecamp</div>'
    todo.updatedAt = h.fake.tick()
    await reconcile(h)

    const after = await readSheetView(l)
    const line = after.cells[row] as Record<number, Record<string, unknown>>
    expect(cellImages(line[COL.A] as never).map((i) => i.drawingId)).toEqual(['a'])
    expect(cellImages(line[COL.D] as never).map((i) => i.drawingId)).toEqual(['d'])
    expect(JSON.stringify(line[COL.A])).toContain('حملة الربع الأول المعدّلة')
    expect(JSON.stringify(line[COL.D])).toContain('2026-12-15')
    expect(JSON.stringify(line[COL.G])).toContain('وصف جديد من Basecamp')
  })
})
