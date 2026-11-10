// Found while building phase 5 (apps/api/OPEN_QUESTIONS.md P2): on a sheet
// whose column mapping has no notes column, the next outbound update used to
// send an empty description — the text a person wrote in Basecamp and every
// file in it were wiped (spec §8.2 keeps that part verbatim; §16 scenario 8).
// The person part now follows Basecamp when the sheet does not hold it.

import { describe, expect, it } from 'vitest'
import { deliver, drainOutbound, edit, harness, readSheetView, reconcile, setupLinked, syncLog, todoByTitle } from '../sync/harness'

const NO_NOTES = { columns: [{ columnKey: 'A', field: 'title' as const }, { columnKey: 'B', field: 'assignees' as const }, { columnKey: 'D', field: 'due_on' as const }] }

describe('a sheet without a notes column (P2)', () => {
  it('an edit of the row keeps the description written in Basecamp, files included', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أ', due: '2026-12-01' }], service: true, plan: NO_NOTES })
    const todo = todoByTitle(h, 'أ')
    const blob = h.fake.addBlob('خطة.pdf', 'application/pdf', new Uint8Array([1, 2, 3]))
    const human = `<div>نص كتبه شخص في Basecamp</div>${h.fake.attachmentHtml(blob)}`
    todo.description = human
    todo.updatedAt = h.fake.tick()
    await reconcile(h)
    await edit(l, (v) => v.set(v.row('أ'), 'A', 'أ جديد'))
    await drainOutbound(h)
    const put = h.fake.callsTo('PUT', new RegExp(`^/todos/${todo.id}\\.json$`)).at(-1)
    expect((put?.body as { content: string }).content).toBe('أ جديد')
    expect((put?.body as { description: string }).description).toBe(human)
    expect(todoByTitle(h, 'أ جديد').description).toBe(human)
  })

  it('a description changed in Basecamp is not pushed back, and a later local edit does not revert it', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'ب' }], service: true, plan: NO_NOTES })
    const todo = todoByTitle(h, 'ب')
    todo.description = '<div>أول</div>'
    todo.updatedAt = h.fake.tick()
    await deliver(l, 'todo_description_changed', { id: todo.id, type: 'Todo' })
    todo.description = '<div>ثانٍ</div>'
    todo.updatedAt = h.fake.tick()
    await deliver(l, 'todo_description_changed', { id: todo.id, type: 'Todo' })
    expect(h.fake.writes().filter((c) => c.path === `/todos/${todo.id}.json`)).toEqual([])
    await edit(l, (v) => v.set(v.row('ب'), 'D', '2026-12-24'))
    await drainOutbound(h)
    expect(todo.dueOn).toBe('2026-12-24')
    expect(todo.description).toBe('<div>ثانٍ</div>')
    // Nothing was logged as a conflict on notes: the sheet holds none.
    const uid = (await readSheetView(l)).uid('ب')
    expect((await syncLog(l.wbId, 'conflict')).filter((r) => r.task_uid === uid)).toEqual([])
  })
})
