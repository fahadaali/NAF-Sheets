// A to-do moving between two linked sheets (spec §9.2.6, §9.3.11, §16
// scenario 4): moved in Basecamp, its row moves with its subtasks; moved in
// the sheet, Basecamp moves it with `parent_id` (same project only).

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { deliver, drainOutbound, edit, harness, readSheetView, setupLinked, task, todoByTitle } from './harness'
import type { Linked } from './harness'

/** A second synced sheet, made the way the platform makes one for a new Basecamp list (§9.3.9). */
async function secondSheet(l: Linked): Promise<{ listId: number; sheetId: string; univerSheetId: string }> {
  const list = l.h.fake.list(l.project.id, 'التصميم')
  await deliver(l, 'todolist_created', { id: list.id, type: 'Todolist' })
  const sheet = await env.DB.prepare(`SELECT id, univer_sheet_id FROM sheets WHERE bc_todolist_id = ?1`).bind(list.id).first<{ id: string; univer_sheet_id: string }>()
  if (!sheet) throw new Error('second sheet not created')
  return { listId: list.id, sheetId: sheet.id, univerSheetId: sheet.univer_sheet_id }
}

describe('a to-do moving between two linked sheets', () => {
  it('moved to the other list in Basecamp: its row and its subtasks move to that sheet, nothing is written back', async () => {
    const h = harness()
    const l = await setupLinked(h, {
      service: true,
      hierarchy: { mode: 'indent' },
      rows: [{ title: 'تبقى' }, { title: 'تنتقل' }, { title: 'ابنتها', indent: true }],
    })
    const b = await secondSheet(l)
    const before = await readSheetView(l)
    const uid = before.uid('تنتقل')
    const childUid = before.uid('ابنتها')
    const todo = todoByTitle(h, 'تنتقل')
    const writes = h.fake.writes().length
    todo.listId = b.listId
    todo.updatedAt = h.fake.tick()
    await deliver(l, 'todo_moved', { id: todo.id, type: 'Todo' })

    expect(await task(uid)).toMatchObject({ sheet_id: b.sheetId, sync_state: 'synced', remote_status: 'active' })
    expect(await task(childUid)).toMatchObject({ sheet_id: b.sheetId })
    const a = await readSheetView(l)
    expect(() => a.row('تنتقل')).toThrow()
    expect(() => a.row('ابنتها')).toThrow()
    expect(a.row('تبقى')).toBeGreaterThan(0)
    const moved = await readSheetView(l, l.owner, b.univerSheetId)
    expect(moved.uid('تنتقل')).toBe(uid)
    expect(moved.row('ابنتها')).toBe(moved.row('تنتقل') + 1)
    expect(h.fake.writes().length).toBe(writes)

    // A later edit of the moved row goes to the same to-do, now in the other list.
    await edit(l, (v) => {
      const cells = v.snapshot.sheets[b.univerSheetId]?.cellData as Record<number, Record<number, Record<string, unknown>>>
      const row = Object.entries(cells).find(([, line]) => line[0]?.['v'] === 'تنتقل')?.[0]
      ;(cells[Number(row)] as Record<number, Record<string, unknown>>)[3] = { v: '2026-12-15', t: 1 }
    })
    await drainOutbound(h)
    expect(todo).toMatchObject({ listId: b.listId, dueOn: '2026-12-15' })
    expect(h.fake.callsTo('PUT', /\/position\.json$/).map((c) => [c.path, c.body])).toEqual([])

    // Moved back in Basecamp: the row follows, and the move is never undone from here.
    todo.listId = l.list.id
    todo.updatedAt = h.fake.tick()
    await deliver(l, 'todo_moved', { id: todo.id, type: 'Todo' })
    expect(await task(uid)).toMatchObject({ sheet_id: l.sheetId, sync_state: 'synced' })
    expect(await task(childUid)).toMatchObject({ sheet_id: l.sheetId })
    const home = await readSheetView(l)
    expect(home.row('ابنتها')).toBe(home.row('تنتقل') + 1)
    await drainOutbound(h)
    expect(todo.listId).toBe(l.list.id)
    expect(h.fake.callsTo('PUT', /\/position\.json$/)).toEqual([])
  })

  it('moved to the other sheet by a person: Basecamp moves the same to-do with parent_id, with that person’s token', async () => {
    const h = harness()
    const l = await setupLinked(h, { service: true, rows: [{ title: 'تبقى' }, { title: 'تنتقل' }] })
    const b = await secondSheet(l)
    const uid = (await readSheetView(l)).uid('تنتقل')
    const todo = todoByTitle(h, 'تنتقل')
    await edit(l, (v) => {
      const line = v.remove(v.row('تنتقل'))
      const target = v.snapshot.sheets[b.univerSheetId]?.cellData as Record<number, Record<number, Record<string, unknown>>>
      target[1] = line
    })
    expect((await task(uid)).sheet_id).toBe(b.sheetId)
    await drainOutbound(h)
    const moves = h.fake.callsTo('PUT', new RegExp(`^/todos/${todo.id}/position\\.json$`))
    expect(moves).toHaveLength(1)
    expect(moves[0]?.body).toEqual({ position: 1, parent_id: b.listId })
    expect(moves[0]?.token).toBe(l.token)
    expect(todo.listId).toBe(b.listId)
    expect([...h.fake.todos.values()].filter((t) => t.content === 'تنتقل')).toHaveLength(1)
    expect(h.fake.callsTo('PUT', new RegExp(`^/recordings/${todo.id}/status/`))).toEqual([])
    expect(await task(uid)).toMatchObject({ sync_state: 'synced', sheet_id: b.sheetId, trashed_at: null })
  })
})
