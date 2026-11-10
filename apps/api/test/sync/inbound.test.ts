// Inbound sync (spec §9.3): webhook deliveries are checked against the
// project, the record is always fetched with the service token, diffed and
// written into the sheet through updateLatestSnapshot + applyInbound.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { deliver, drainOutbound, edit, harness, readSheetView, setupLinked, syncLog, task, todoByTitle } from './harness'

async function version(id: string): Promise<number> {
  return ((await env.DB.prepare(`SELECT current_snapshot_version AS v FROM workbooks WHERE id = ?1`).bind(id).first<{ v: number }>())?.v ?? -1) as number
}

describe('a webhook delivery', () => {
  it('whose recording.bucket.id is not the project is ignored and logged, and nothing is fetched', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'مهمة' }], service: true })
    const todo = todoByTitle(h, 'مهمة')
    const calls = h.fake.calls.length
    const result = await deliver(l, 'todo_content_updated', { id: todo.id, type: 'Todo', bucketId: l.project.id + 1 })
    expect(result.explicitAcks).toHaveLength(1)
    expect(h.fake.calls.length).toBe(calls)
    const logged = await syncLog(l.wbId, 'webhook')
    expect(logged.at(-1)).toMatchObject({ status: 'ignored', error: 'bucket_mismatch' })
  })

  it('of an unknown kind: the record is fetched and diffed like any other, never a failure', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'قديم' }], service: true })
    const todo = todoByTitle(h, 'قديم')
    todo.content = 'جديد من Basecamp'
    todo.dueOn = '2027-01-05'
    todo.updatedAt = h.fake.tick()
    const result = await deliver(l, 'todo_teleported_to_mars', { id: todo.id, type: 'Todo' })
    expect(result.explicitAcks).toHaveLength(1)
    const get = h.fake.callsTo('GET', new RegExp(`^/todos/${todo.id}\\.json$`)).at(-1)
    expect(get?.token).not.toBe(l.token)
    const view = await readSheetView(l)
    const row = view.row('جديد من Basecamp')
    expect(view.text(row, 'A')).toBe('جديد من Basecamp')
  })

  it('our own write coming back is an echo: nothing is written to the sheet', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'مهمة' }], service: true })
    await edit(l, (v) => v.set(v.row('مهمة'), 'D', '2026-12-31'))
    await drainOutbound(h)
    const todo = todoByTitle(h, 'مهمة')
    expect(todo.dueOn).toBe('2026-12-31')
    const before = await version(l.wbId)
    const inbound = (await syncLog(l.wbId)).filter((r) => r.direction === 'in').length
    await deliver(l, 'todo_changed', { id: todo.id, type: 'Todo' })
    expect(await version(l.wbId)).toBe(before)
    expect((await syncLog(l.wbId)).filter((r) => r.direction === 'in').length).toBe(inbound)
    expect((await task((await readSheetView(l)).uid('مهمة'))).sync_state).toBe('synced')
  })

  it('todo_created: a new row with its subtasks under it', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'موجودة' }], service: true })
    const todo = h.fake.addTodo(l.list.id, { content: 'من Basecamp', assigneeIds: [l.ownerPerson.id], dueOn: '2026-12-09' })
    h.fake.addSubtask(todo.id, { title: 'فرعية من Basecamp' })
    await deliver(l, 'todo_created', { id: todo.id, type: 'Todo' })
    const view = await readSheetView(l)
    const row = view.row('من Basecamp')
    expect(view.text(row, 'B')).toBe('أحمد المالك')
    expect(view.text(row, 'D')).not.toBe('')
    const sub = view.row('فرعية من Basecamp')
    expect(sub).toBe(row + 1)
    const parent = await task(view.uid('من Basecamp'))
    expect(parent).toMatchObject({ bc_recording_id: todo.id, sync_state: 'synced', level: 0 })
    expect(await task(view.uid('فرعية من Basecamp'))).toMatchObject({ level: 1, parent_uid: parent.task_uid, sync_state: 'synced' })
  })

  it('todolist_archived: every row of the sheet is marked, none removed', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أ' }, { title: 'ب' }], service: true })
    const list = h.fake.lists.get(l.list.id)
    if (list) list.status = 'archived'
    await deliver(l, 'todolist_archived', { id: l.list.id, type: 'Todolist' })
    const view = await readSheetView(l)
    for (const title of ['أ', 'ب']) {
      expect((await task(view.uid(title))).remote_status).toBe('archived')
      expect(view.row(title)).toBeGreaterThan(0)
    }
  })

  it('a to-do moved to a list no sheet is linked to moves its row to «غير مصنّف»', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'تبقى' }, { title: 'تنتقل' }], service: true })
    const other = h.fake.list(l.project.id, 'قائمة أخرى')
    const todo = todoByTitle(h, 'تنتقل')
    const uid = (await readSheetView(l)).uid('تنتقل')
    todo.listId = other.id
    todo.updatedAt = h.fake.tick()
    await deliver(l, 'todo_moved', { id: todo.id, type: 'Todo' })
    const wb = await env.DB.prepare(`SELECT unclassified_sheet_id FROM workbooks WHERE id = ?1`).bind(l.wbId).first<{ unclassified_sheet_id: string }>()
    expect(wb?.unclassified_sheet_id).toBeTruthy()
    expect(await task(uid)).toMatchObject({ sheet_id: wb?.unclassified_sheet_id, sync_state: 'unlinked' })
    const sheet = await env.DB.prepare(`SELECT title, sync_mode FROM sheets WHERE id = ?1`).bind(wb?.unclassified_sheet_id).first<{ title: string; sync_mode: string }>()
    expect(sheet).toEqual({ title: 'غير مصنّف', sync_mode: 'local' })
    const view = await readSheetView(l)
    expect(() => view.row('تنتقل')).toThrow()
    expect(view.row('تبقى')).toBeGreaterThan(0)
  })

  it('todolist_created: a new synced sheet with the list’s to-dos (new_list_behavior create_sheet)', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أ' }], service: true })
    const list = h.fake.list(l.project.id, 'قائمة جديدة')
    h.fake.addTodo(list.id, { content: 'في القائمة الجديدة' })
    await deliver(l, 'todolist_created', { id: list.id, type: 'Todolist' })
    const sheet = await env.DB.prepare(`SELECT id, title, sync_mode FROM sheets WHERE bc_todolist_id = ?1`).bind(list.id).first<{ id: string; title: string; sync_mode: string }>()
    expect(sheet).toMatchObject({ title: 'قائمة جديدة', sync_mode: 'synced' })
    const tasks = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE sheet_id = ?1`).bind(sheet?.id).first<{ n: number }>()
    expect(tasks?.n).toBe(1)
  })
})

describe('automatic assignment of a to-do from its subtasks (§8.1)', () => {
  async function autoSetup() {
    const h = harness()
    const l = await setupLinked(h, {
      people: ['سارة', 'بدر'],
      service: true,
      hierarchy: { mode: 'indent' },
      rows: [{ title: 'الأم' }, { title: 'ف1', indent: true, assignees: 'سارة' }],
    })
    return { h, l }
  }

  it('a subtask re-assigned in Basecamp by someone without a platform link: the to-do follows with the service token, notify false, logged «قاعدة تلقائية»', async () => {
    const { h, l } = await autoSetup()
    const parent = todoByTitle(h, 'الأم')
    expect(parent.assigneeIds).toEqual([l.people['سارة']?.id])
    const sub = [...h.fake.subtasks.values()].find((s) => s.title === 'ف1')
    if (!sub) throw new Error('no subtask')
    sub.assigneeIds = [l.people['بدر']?.id as number]
    sub.updatedAt = h.fake.tick()
    const stranger = h.fake.person('غريب')
    await deliver(l, 'kanban_step_assignment_changed', { id: sub.id, type: 'Kanban::Step' }, stranger.id)

    const put = h.fake.callsTo('PUT', new RegExp(`^/todos/${parent.id}\\.json$`)).at(-1)
    expect(put).toBeDefined()
    expect(put?.body).toMatchObject({ assignee_ids: [l.people['بدر']?.id], notify: false })
    expect(put?.token).not.toBe(l.token)
    const logged = (await syncLog(l.wbId, 'update_todo')).at(-1)
    expect(logged?.actor).toBe('قاعدة تلقائية')
    const view = await readSheetView(l)
    expect(view.text(view.row('الأم'), 'B')).toBe('بدر')
    expect((await task(view.uid('الأم'))).assign_mode).toBe('auto')
  })

  it('when the person who changed the subtask linked their account, their own token is used', async () => {
    const { h, l } = await autoSetup()
    const parent = todoByTitle(h, 'الأم')
    const sub = [...h.fake.subtasks.values()].find((s) => s.title === 'ف1')
    if (!sub) throw new Error('no subtask')
    sub.assigneeIds = [l.people['بدر']?.id as number]
    sub.updatedAt = h.fake.tick()
    await deliver(l, 'kanban_step_assignment_changed', { id: sub.id, type: 'Kanban::Step' }, l.ownerPerson.id)
    const put = h.fake.callsTo('PUT', new RegExp(`^/todos/${parent.id}\\.json$`)).at(-1)
    expect(put?.token).toBe(l.token)
    expect((await syncLog(l.wbId, 'update_todo')).at(-1)?.actor).toBe(l.owner.id)
  })

  it('the automatic update coming back as a webhook neither loops nor switches the to-do to manual (§16 scenario 16)', async () => {
    const { h, l } = await autoSetup()
    const parent = todoByTitle(h, 'الأم')
    const puts = h.fake.callsTo('PUT', /^\/todos\//).length
    await deliver(l, 'todo_assignment_changed', { id: parent.id, type: 'Todo' })
    expect(h.fake.callsTo('PUT', /^\/todos\//).length).toBe(puts)
    expect((await task((await readSheetView(l)).uid('الأم'))).assign_mode).toBe('auto')
  })
})
