// Field conflicts (spec §9.1): the same field changed on both sides before
// they synced. Last writer wins per field, every conflict is logged and
// stored, and the losing value can be restored (or the conflict dismissed).

import { describe, expect, it } from 'vitest'
import type { WorkbookConflictsResponse, WorkbookSyncResponse } from '@naf-sheets/shared'
import { call, drainOutbound, edit, harness, json, readSheetView, setupLinked, syncLog, task, todoByTitle } from './harness'
import type { SetupOptions } from './harness'
import type { Linked } from './harness'

async function conflictOnTitle(remoteLater: boolean): Promise<{ l: Linked; uid: string }> {
  const h = harness()
  const l = await setupLinked(h, { rows: [{ title: 'العنوان الأصلي' }] })
  const uid = (await readSheetView(l)).uid('العنوان الأصلي')
  const todo = todoByTitle(h, 'العنوان الأصلي')
  if (!remoteLater) {
    // Basecamp's edit happened an hour before the person's.
    h.fake.clock = Date.now() - 3600_000
    todo.content = 'عنوان من Basecamp'
    todo.updatedAt = h.fake.tick()
  }
  await edit(l, (v) => v.set(v.row('العنوان الأصلي'), 'A', 'عنوان من المنصة'))
  if (remoteLater) {
    h.fake.clock = Date.now() + 3600_000
    todo.content = 'عنوان من Basecamp'
    todo.updatedAt = h.fake.tick()
  }
  await drainOutbound(h)
  return { l, uid }
}

describe('last writer wins, per field', () => {
  it('Basecamp later: its value goes into the sheet, the conflict is logged and stored', async () => {
    const { l, uid } = await conflictOnTitle(true)
    const { h } = l
    const view = await readSheetView(l)
    expect(view.text(view.row('عنوان من Basecamp'), 'A')).toBe('عنوان من Basecamp')
    expect(h.fake.callsTo('PUT', /^\/todos\/\d+\.json$/).filter((c) => (c.body as { content: string }).content === 'عنوان من المنصة')).toHaveLength(0)
    const conflicts = await json<WorkbookConflictsResponse>(await call(h.app, 'GET', `/api/workbooks/${l.wbId}/conflicts`, { user: l.owner, env: h.env }))
    expect(conflicts.conflicts).toHaveLength(1)
    expect(conflicts.conflicts[0]).toMatchObject({ uid, field: 'title', localValue: 'عنوان من المنصة', remoteValue: 'عنوان من Basecamp', winner: 'remote', sheetId: l.sheetId })
    const logged = await syncLog(l.wbId, 'conflict')
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({ status: 'conflict', task_uid: uid })
    expect((await task(uid)).sync_state).toBe('conflict')
    const state = await json<WorkbookSyncResponse>(await call(h.app, 'GET', `/api/workbooks/${l.wbId}/sync`, { user: l.owner, env: h.env }))
    expect(state.counts.conflict).toBe(1)
    expect(state.tasks.find((t) => t.uid === uid)?.message).toMatch(/[؀-ۿ]/)
  })

  it('the platform later: its value goes to Basecamp, and the conflict is still logged', async () => {
    const { l } = await conflictOnTitle(false)
    expect(todoByTitle(l.h, 'عنوان من المنصة')).toBeDefined()
    const conflicts = await json<WorkbookConflictsResponse>(await call(l.h.app, 'GET', `/api/workbooks/${l.wbId}/conflicts`, { user: l.owner, env: l.h.env }))
    expect(conflicts.conflicts[0]).toMatchObject({ field: 'title', winner: 'local' })
  })
})

describe('conflict routes', () => {
  it('restore puts the losing value back: into the sheet, then to Basecamp with the caller’s token', async () => {
    const { l, uid } = await conflictOnTitle(true)
    const { h } = l
    const conflicts = await json<WorkbookConflictsResponse>(await call(h.app, 'GET', `/api/workbooks/${l.wbId}/conflicts`, { user: l.owner, env: h.env }))
    const id = conflicts.conflicts[0]?.id as string
    const res = await call(h.app, 'POST', `/api/workbooks/${l.wbId}/conflicts/${id}/restore`, { user: l.owner, env: h.env })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ restored: true })
    const view = await readSheetView(l)
    expect(view.text(view.row('عنوان من المنصة'), 'A')).toBe('عنوان من المنصة')
    await drainOutbound(h)
    const put = h.fake.callsTo('PUT', /^\/todos\/\d+\.json$/).at(-1)
    expect((put?.body as { content: string }).content).toBe('عنوان من المنصة')
    expect(put?.token).toBe(l.token)
    const after = await json<WorkbookConflictsResponse>(await call(h.app, 'GET', `/api/workbooks/${l.wbId}/conflicts`, { user: l.owner, env: h.env }))
    expect(after.conflicts).toEqual([])
    expect((await task(uid)).sync_state).toBe('synced')
    const again = await call(h.app, 'POST', `/api/workbooks/${l.wbId}/conflicts/${id}/restore`, { user: l.owner, env: h.env })
    expect(again.status).toBe(409)
  })

  it('dismiss keeps the winner and closes the conflict', async () => {
    const { l, uid } = await conflictOnTitle(true)
    const { h } = l
    const conflicts = await json<WorkbookConflictsResponse>(await call(h.app, 'GET', `/api/workbooks/${l.wbId}/conflicts`, { user: l.owner, env: h.env }))
    const id = conflicts.conflicts[0]?.id as string
    const writes = h.fake.writes().length
    const res = await call(h.app, 'POST', `/api/workbooks/${l.wbId}/conflicts/${id}/dismiss`, { user: l.owner, env: h.env })
    expect(res.status).toBe(204)
    expect((await json<WorkbookConflictsResponse>(await call(h.app, 'GET', `/api/workbooks/${l.wbId}/conflicts`, { user: l.owner, env: h.env }))).conflicts).toEqual([])
    expect((await task(uid)).sync_state).toBe('synced')
    expect(h.fake.writes().length).toBe(writes)
    const unknown = await call(h.app, 'POST', `/api/workbooks/${l.wbId}/conflicts/nope/dismiss`, { user: l.owner, env: h.env })
    expect(unknown.status).toBe(404)
  })
})

describe('restoring a conflict on other fields', () => {
  async function remoteWins(rows: SetupOptions['rows'], people: string[], change: (l: Linked) => Promise<unknown>, remote: (todo: ReturnType<typeof todoByTitle>, l: Linked) => void) {
    const h = harness()
    const l = await setupLinked(h, { rows, people })
    await change(l)
    const todo = todoByTitle(h, rows?.[0]?.title ?? '')
    h.fake.clock = Date.now() + 3600_000
    remote(todo, l)
    todo.updatedAt = h.fake.tick()
    await drainOutbound(h)
    const list = await json<WorkbookConflictsResponse>(await call(h.app, 'GET', `/api/workbooks/${l.wbId}/conflicts`, { user: l.owner, env: h.env }))
    return { l, todo, conflicts: list.conflicts }
  }

  async function restore(l: Linked, id: string): Promise<void> {
    const res = await call(l.h.app, 'POST', `/api/workbooks/${l.wbId}/conflicts/${id}/restore`, { user: l.owner, env: l.h.env })
    expect(res.status).toBe(202)
    await drainOutbound(l.h)
  }

  it('due date: the sheet’s date comes back and goes to Basecamp in a full PUT', async () => {
    const { l, todo, conflicts } = await remoteWins(
      [{ title: 'موعد', due: '2026-12-01', assignees: 'أحمد المالك', notes: 'نص' }],
      [],
      (x) => edit(x, (v) => v.set(v.row('موعد'), 'D', '2026-12-10')),
      (t) => {
        t.dueOn = '2026-12-20'
      },
    )
    const c = conflicts.find((x) => x.field === 'dueOn')
    expect(c).toMatchObject({ localValue: '2026-12-10', remoteValue: '2026-12-20', winner: 'remote' })
    let view = await readSheetView(l)
    expect(view.text(view.row('موعد'), 'D')).toBe('2026-12-20')
    await restore(l, c?.id as string)
    view = await readSheetView(l)
    expect(view.text(view.row('موعد'), 'D')).toBe('2026-12-10')
    const put = l.h.fake.callsTo('PUT', new RegExp(`^/todos/${todo.id}\\.json$`)).at(-1)
    expect(put?.body).toMatchObject({ due_on: '2026-12-10', assignee_ids: [l.ownerPerson.id] })
    expect((put?.body as { description: string }).description).toContain('نص')
    expect(todo.dueOn).toBe('2026-12-10')
    expect((await task(c?.uid as string)).sync_state).toBe('synced')
  })

  it('assignees: the sheet’s people come back (manual) and Basecamp gets them', async () => {
    const { l, todo, conflicts } = await remoteWins(
      [{ title: 'إسناد', assignees: 'أحمد المالك' }],
      ['سارة', 'بدر'],
      (x) => edit(x, (v) => v.set(v.row('إسناد'), 'B', 'سارة')),
      (t, x) => {
        t.assigneeIds = [x.people['بدر']?.id as number]
      },
    )
    const c = conflicts.find((x) => x.field === 'assignees')
    expect(c?.winner).toBe('remote')
    expect(c?.remoteValue).toEqual([l.people['بدر']?.id])
    let view = await readSheetView(l)
    expect(view.text(view.row('إسناد'), 'B')).toBe('بدر')
    await restore(l, c?.id as string)
    view = await readSheetView(l)
    expect(view.text(view.row('إسناد'), 'B')).toBe('سارة')
    expect(todo.assigneeIds).toEqual([l.people['سارة']?.id])
    expect((await task(c?.uid as string))).toMatchObject({ assign_mode: 'manual', sync_state: 'synced' })
  })

  it('completion: the sheet’s state comes back and goes through the completion endpoint', async () => {
    // A completion conflict needs no base: a row matched by title at linking (S3).
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'النشر', done: true }], existingTodos: ['النشر'], plan: { existingTasks: 'match_by_title' } })
    const todo = todoByTitle(h, 'النشر')
    expect(todo.completed).toBe(false)
    const list = await json<WorkbookConflictsResponse>(await call(h.app, 'GET', `/api/workbooks/${l.wbId}/conflicts`, { user: l.owner, env: h.env }))
    const c = list.conflicts.find((x) => x.field === 'completed')
    expect(c).toMatchObject({ localValue: true, remoteValue: false, winner: 'remote' })
    let view = await readSheetView(l)
    expect(view.text(view.row('النشر'), 'E')).not.toBe('منجز')
    await restore(l, c?.id as string)
    view = await readSheetView(l)
    expect(view.text(view.row('النشر'), 'E')).toBe('منجز')
    expect(h.fake.callsTo('POST', new RegExp(`^/todos/${todo.id}/completion\\.json$`))).toHaveLength(1)
    expect(todo.completed).toBe(true)
  })
})
