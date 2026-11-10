// Row deletion (spec §9.2.7, §16 scenarios 3 and 10): nothing is deleted in
// Basecamp unless the person confirmed it; a subtask's full record is kept
// before its permanent DELETE; undo brings the to-do back from the trash and
// re-creates the subtask.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { isArabic } from '../helpers'
import { drainOutbound, edit, harness, readSheetView, setupLinked, subtaskByTitle, syncLog, task, todoByTitle } from './harness'

describe('a synced row missing from the snapshot', () => {
  it('without confirmation: Basecamp is not touched, the row goes to error in Arabic, the save succeeds', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'تبقى' }, { title: 'تختفي' }] })
    const uid = (await readSheetView(l)).uid('تختفي')
    const writes = h.fake.writes().length
    await edit(l, (v) => v.remove(v.row('تختفي')))
    await drainOutbound(h)
    expect(h.fake.writes().length).toBe(writes)
    expect(todoByTitle(h, 'تختفي').status).toBe('active')
    const row = await task(uid)
    expect(row).toMatchObject({ sync_state: 'error', last_error_code: 'row_missing', trashed_at: null })
    expect(isArabic(row.last_error)).toBe(true)

    // Put back: the error clears, nothing was sent.
    await edit(l, (v) => {
      v.cells[5] = { 0: { v: 'تختفي' }, [v.uidColumn]: { v: uid, t: 1 }, [v.uidColumn + 2]: { v: 0, t: 2 } }
    })
    expect((await task(uid)).sync_state).toBe('synced')
    expect(h.fake.writes().length).toBe(writes)
  })
})

describe('a confirmed deletion', () => {
  it('to-do: goes to the trash with the person’s token; undo brings the same to-do back (never re-created)', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أولى' }, { title: 'للسلة' }] })
    const uid = (await readSheetView(l)).uid('للسلة')
    const todo = todoByTitle(h, 'للسلة')
    let removed: Record<number, Record<string, unknown>> = {}
    let row = 0
    await edit(
      l,
      (v) => {
        row = v.row('للسلة')
        removed = v.remove(row)
      },
      { confirmedDeletions: [uid] },
    )
    await drainOutbound(h)
    const trash = h.fake.callsTo('PUT', new RegExp(`^/recordings/${todo.id}/status/trashed\\.json$`))
    expect(trash).toHaveLength(1)
    expect(trash[0]?.token).toBe(l.token)
    expect(todo.status).toBe('trashed')
    expect(await task(uid)).toMatchObject({ remote_status: 'trashed', sync_state: 'synced' })
    expect((await task(uid)).trashed_at).not.toBeNull()

    await edit(l, (v) => {
      v.cells[row] = removed
    })
    await drainOutbound(h)
    expect(h.fake.callsTo('PUT', new RegExp(`^/recordings/${todo.id}/status/active\\.json$`))).toHaveLength(1)
    expect(todo.status).toBe('active')
    expect([...h.fake.todos.values()].filter((t) => t.content === 'للسلة')).toHaveLength(1)
    expect(await task(uid)).toMatchObject({ remote_status: 'active', trashed_at: null, bc_recording_id: todo.id })
  })

  it('subtask: the full record is stored in the log before the permanent DELETE; undo re-creates it as a new subtask', async () => {
    const h = harness()
    const l = await setupLinked(h, {
      people: ['سارة'],
      hierarchy: { mode: 'indent' },
      rows: [{ title: 'الأم', assignees: 'أحمد المالك' }, { title: 'فرعية للحذف', indent: true, assignees: 'سارة', due: '2026-12-03' }],
    })
    const uid = (await readSheetView(l)).uid('فرعية للحذف')
    const sub = subtaskByTitle(h, 'فرعية للحذف')
    let storedBeforeDelete: string | null = null
    h.fake.beforeSubtaskDelete = async (id) => {
      const row = await env.DB.prepare(`SELECT old_value FROM sync_log WHERE task_uid = ?1 AND action = 'delete_subtask_snapshot'`).bind(uid).first<{ old_value: string }>()
      storedBeforeDelete = id === sub.id ? (row?.old_value ?? null) : null
    }
    let removed: Record<number, Record<string, unknown>> = {}
    let row = 0
    await edit(
      l,
      (v) => {
        row = v.row('فرعية للحذف')
        removed = v.remove(row)
      },
      { confirmedDeletions: [uid] },
    )
    await drainOutbound(h)
    expect(h.fake.callsTo('DELETE', new RegExp(`^/subtasks/${sub.id}\\.json$`))).toHaveLength(1)
    expect(h.fake.subtasks.has(sub.id)).toBe(false)
    expect(storedBeforeDelete).not.toBeNull()
    expect(JSON.parse(storedBeforeDelete as unknown as string)).toMatchObject({ type: 'subtask', id: sub.id, title: 'فرعية للحذف', dueOn: '2026-12-03', assigneeIds: [l.people['سارة']?.id] })
    expect(await task(uid)).toMatchObject({ remote_status: 'deleted' })
    expect((await syncLog(l.wbId, 'delete_subtask')).length).toBe(1)
    const audit = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'task.delete' AND entity_id = ?1`).bind(uid).first<{ n: number }>()
    expect(audit?.n).toBe(1)

    // Undo (Ctrl+Z): the same uid is back → a NEW subtask with the stored values.
    await edit(l, (v) => {
      v.cells[row] = removed
    })
    await drainOutbound(h)
    const again = subtaskByTitle(h, 'فرعية للحذف')
    expect(again.id).not.toBe(sub.id)
    expect(again).toMatchObject({ todoId: sub.todoId, dueOn: '2026-12-03', assigneeIds: [l.people['سارة']?.id] })
    expect(await task(uid)).toMatchObject({ bc_recording_id: again.id, remote_status: 'active', trashed_at: null })
  })

  it('a subtask deleted with its to-do is never deleted on its own: it goes to the trash with the to-do', async () => {
    const h = harness()
    const l = await setupLinked(h, { hierarchy: { mode: 'indent' }, rows: [{ title: 'الأم' }, { title: 'ابنة', indent: true }] })
    const view = await readSheetView(l)
    const parentUid = view.uid('الأم')
    const childUid = view.uid('ابنة')
    await edit(
      l,
      (v) => {
        v.remove(v.row('ابنة'))
        v.remove(v.row('الأم'))
      },
      { confirmedDeletions: [parentUid, childUid] },
    )
    await drainOutbound(h)
    expect(h.fake.callsTo('DELETE', /^\/subtasks\//)).toHaveLength(0)
    expect(todoByTitle(h, 'الأم').status).toBe('trashed')
    expect((await task(childUid)).trashed_at).not.toBeNull()
  })
})
