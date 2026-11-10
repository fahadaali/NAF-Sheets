// Link wizard (spec §7.3): preview computes only; commit links, writes the
// system columns through updateLatestSnapshot, stores sheets / mappings /
// tasks, registers the webhook and queues the initial creation. Nothing in
// Basecamp is ever deleted by linking.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { LinkPlan, LinkPreviewResponse, LinkWorkbookResponse, WorkbookSyncResponse } from '@naf-sheets/shared'
import { isArabic } from '../helpers'
import {
  call,
  defaultSheetPlan,
  drainOutbound,
  harness,
  json,
  linkUser,
  readSheetView,
  seedMember,
  seedProjectPeople,
  setupLinked,
  task,
  todoByTitle,
  writeRow,
} from './harness'
import type { Harness, RowSpec } from './harness'
import { createWorkbook } from '../helpers'

async function unlinkedWorkbook(h: Harness, rows: RowSpec[], options: { peopleNames?: string[] } = {}) {
  const owner = await seedMember('editor')
  const ownerPerson = h.fake.person('أحمد المالك')
  await linkUser(h, owner.id, ownerPerson)
  const others = (options.peopleNames ?? []).map((n) => h.fake.person(n))
  const project = h.fake.project('حملة', [ownerPerson.id, ...others.map((p) => p.id)])
  const list = h.fake.list(project.id, 'المحتوى')
  await seedProjectPeople(project.id, [ownerPerson, ...others])
  const wbId = await createWorkbook(h.app, owner)
  const res = await call(h.app, 'GET', `/api/workbooks/${wbId}`, { user: owner, env: h.env })
  const wb = await json<{ snapshot: { sheets: Record<string, { cellData: Record<number, Record<number, Record<string, unknown>>> }> }; version: number; sheets: Array<{ id: string; univerSheetId: string }> }>(res)
  const sheet = wb.sheets[0] as { id: string; univerSheetId: string }
  rows.forEach((r, i) => writeRow((wb.snapshot.sheets[sheet.univerSheetId] as { cellData: Record<number, Record<number, Record<string, unknown>>> }).cellData, i + 1, r))
  expect((await call(h.app, 'PUT', `/api/workbooks/${wbId}/snapshot`, { user: owner, env: h.env, body: { baseVersion: wb.version, snapshot: wb.snapshot } })).status).toBe(200)
  return { owner, ownerPerson, others, project, list, wbId, sheet }
}

describe('POST /api/workbooks/:id/link/preview', () => {
  it('counts to-dos and subtasks, proposes title matches, lists unmatched assignees, and writes nothing', async () => {
    const h = harness()
    const w = await unlinkedWorkbook(
      h,
      [
        { title: 'إطلاق الحملة', assignees: 'سارة' },
        { title: 'تصميم البوستر', indent: true, assignees: 'سارا العتيبي' },
        { title: 'كتابة النص', indent: true },
        { title: 'النشر', assignees: 'شخص لا يعرفه أحد' },
      ],
      { peopleNames: ['سارة', 'سارة العتيبي'] },
    )
    h.fake.addTodo(w.list.id, { content: 'النشر' })
    h.fake.addTodo(w.list.id, { content: 'مهمة قديمة' })
    const plan: LinkPlan = {
      project: { mode: 'existing', projectId: w.project.id },
      sheets: [defaultSheetPlan(w.sheet.id, { todolistId: w.list.id, hierarchy: { mode: 'indent' }, existingTasks: 'match_by_title' })],
    }
    const before = (await env.DB.prepare(`SELECT current_snapshot_version AS v FROM workbooks WHERE id = ?1`).bind(w.wbId).first<{ v: number }>())?.v
    const res = await call(h.app, 'POST', `/api/workbooks/${w.wbId}/link/preview`, { user: w.owner, env: h.env, body: plan })
    expect(res.status).toBe(200)
    const body = await json<LinkPreviewResponse>(res)
    const s = body.sheets[0]
    expect(s).toMatchObject({ sheetId: w.sheet.id, todosToCreate: 1, subtasksToCreate: 2 })
    expect(s?.proposedMatches).toEqual([{ rowNumber: 5, title: 'النشر', todoId: [...h.fake.todos.values()].find((t) => t.content === 'النشر')?.id, todoTitle: 'النشر' }])
    const texts = s?.unmatchedAssignees.map((u) => u.text)
    expect(texts).toContain('سارا العتيبي')
    expect(texts).toContain('شخص لا يعرفه أحد')
    expect(texts).not.toContain('سارة')
    const fuzzy = s?.unmatchedAssignees.find((u) => u.text === 'سارا العتيبي')
    expect(fuzzy?.candidates[0]?.name).toBe('سارة العتيبي')
    expect(s?.warnings.some((w2) => isArabic(w2))).toBe(true)
    // Nothing written: no Basecamp write, no new snapshot, no task row, no link state.
    expect(h.fake.writes()).toEqual([])
    const after = await env.DB.prepare(`SELECT current_snapshot_version AS v, link_state, bc_project_id FROM workbooks WHERE id = ?1`).bind(w.wbId).first<{ v: number; link_state: string | null; bc_project_id: number | null }>()
    expect(after).toEqual({ v: before, link_state: null, bc_project_id: null })
    const tasks = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE sheet_id = ?1`).bind(w.sheet.id).first<{ n: number }>()
    expect(tasks?.n).toBe(0)
  })

  it('refuses a plan that names no title column (400, Arabic)', async () => {
    const h = harness()
    const w = await unlinkedWorkbook(h, [{ title: 'مهمة' }])
    const plan = { project: { mode: 'existing', projectId: w.project.id }, sheets: [{ ...defaultSheetPlan(w.sheet.id, { todolistId: w.list.id }), columns: [{ columnKey: 'B', field: 'assignees' }] }] }
    const res = await call(h.app, 'POST', `/api/workbooks/${w.wbId}/link/preview`, { user: w.owner, env: h.env, body: plan })
    expect(res.status).toBe(400)
    const body = await json<{ error: string; message: string }>(res)
    expect(body.error).toBe('invalid_link_plan')
    expect(isArabic(body.message)).toBe(true)
  })
})

describe('POST /api/workbooks/:id/link', () => {
  it('links, writes the system columns, stores tasks, registers the webhook and creates the to-dos with the owner token', async () => {
    const h = harness()
    const l = await setupLinked(h, {
      rows: [
        { title: 'إطلاق الحملة', due: '2026-12-01', notes: 'خطة النشر' },
        { title: 'تصميم البوستر', indent: true },
        { title: 'النشر' },
      ],
      hierarchy: { mode: 'indent' },
      service: true,
    })
    const view = await readSheetView(l)
    expect(view.uidColumn).toBeGreaterThan(6)
    const parent = await task(view.uid('إطلاق الحملة'))
    const child = await task(view.uid('تصميم البوستر'))
    expect(parent).toMatchObject({ level: 0, sync_state: 'synced', bc_type: 'todo' })
    expect(child).toMatchObject({ level: 1, parent_uid: parent.task_uid, sync_state: 'synced', bc_type: 'subtask' })

    const todo = todoByTitle(h, 'إطلاق الحملة')
    expect(todo).toMatchObject({ listId: l.list.id, dueOn: '2026-12-01' })
    expect(todo.description).toContain('خطة النشر')
    expect([...h.fake.subtasks.values()].map((s) => [s.todoId, s.title])).toEqual([[todo.id, 'تصميم البوستر']])
    // Written with the owner's own token (§3).
    for (const c of h.fake.callsTo('POST', /\/(todos|subtasks)\.json$/)) expect(c.token).toBe(l.token)
    // Webhook with the service token, five types, secret in the path.
    const hooks = [...h.fake.webhooks.values()]
    expect(hooks).toHaveLength(1)
    expect(hooks[0]?.types).toEqual(['Todo', 'Todolist', 'Kanban::Step', 'Comment', 'Upload'])
    expect(hooks[0]?.payloadUrl).toMatch(/^https:\/\/sheets\.naflaw\.test\/webhooks\/basecamp\/[A-Za-z0-9_-]{48}$/)
    const audit = await env.DB.prepare(`SELECT action FROM audit_log WHERE workbook_id = ?1 AND action LIKE 'workbook.link%'`).bind(l.wbId).all<{ action: string }>()
    expect(audit.results.map((r) => r.action)).toContain('workbook.link')
  })

  it('creates a new list for a sheet in mode new, and a project in mode create', async () => {
    const h = harness()
    const w = await unlinkedWorkbook(h, [{ title: 'مهمة أولى' }])
    const plan: LinkPlan = { project: { mode: 'create', name: 'مشروع جديد' }, sheets: [{ ...defaultSheetPlan(w.sheet.id), mode: 'new' }] }
    const res = await call(h.app, 'POST', `/api/workbooks/${w.wbId}/link`, { user: w.owner, env: h.env, body: plan })
    expect(res.status).toBe(200)
    const body = await json<LinkWorkbookResponse>(res)
    expect(body.bcProjectId).not.toBeNull()
    expect(body.sheets[0]?.bcTodolistId).not.toBeNull()
    expect(body.sheets[0]?.queuedTasks).toBe(1)
    expect(h.fake.lists.get(body.sheets[0]?.bcTodolistId as number)?.name).toBe('ورقة 1')
    await drainOutbound(h)
    expect(todoByTitle(h, 'مهمة أولى').listId).toBe(body.sheets[0]?.bcTodolistId)
  })

  it('links a matched to-do instead of creating it, takes Basecamp values and logs the differences as conflicts', async () => {
    const h = harness()
    const w = await unlinkedWorkbook(h, [{ title: 'النشر', due: '2026-12-05' }, { title: 'جديدة' }])
    const existing = h.fake.addTodo(w.list.id, { content: 'النشر', dueOn: '2026-12-20', description: '<div>من Basecamp</div>' })
    const plan: LinkPlan = { project: { mode: 'existing', projectId: w.project.id }, sheets: [defaultSheetPlan(w.sheet.id, { todolistId: w.list.id, existingTasks: 'match_by_title' })] }
    expect((await call(h.app, 'POST', `/api/workbooks/${w.wbId}/link`, { user: w.owner, env: h.env, body: plan })).status).toBe(200)
    await drainOutbound(h)
    expect([...h.fake.todos.values()].filter((t) => t.content === 'النشر')).toHaveLength(1)
    expect(h.fake.todos.get(existing.id)?.description).toBe('<div>من Basecamp</div>')
    expect(h.fake.todos.get(existing.id)?.dueOn).toBe('2026-12-20')
    const l = { h, owner: w.owner, wbId: w.wbId, univerSheetId: w.sheet.univerSheetId } as never
    const view = await readSheetView(l)
    expect(view.text(view.row('النشر'), 'D')).not.toBe('2026-12-05')
    const conflicts = await json<{ conflicts: Array<{ field: string; winner: string }> }>(await call(h.app, 'GET', `/api/workbooks/${w.wbId}/conflicts`, { user: w.owner, env: h.env }))
    expect(conflicts.conflicts.map((c) => [c.field, c.winner])).toContainEqual(['dueOn', 'remote'])
  })

  it('refuses a workbook that is already linked (409), and a caller who is neither owner nor admin (403)', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'مهمة' }] })
    const plan: LinkPlan = { project: { mode: 'existing', projectId: l.project.id }, sheets: [] }
    const again = await call(h.app, 'POST', `/api/workbooks/${l.wbId}/link`, { user: l.owner, env: h.env, body: plan })
    expect(again.status).toBe(409)
    expect((await json<{ error: string }>(again)).error).toBe('workbook_already_linked')

    const w = await unlinkedWorkbook(h, [{ title: 'مهمة' }])
    const editor = await seedMember('editor')
    await env.DB.prepare(`INSERT INTO workbook_members (workbook_id, user_id, role, added_by, added_at) VALUES (?1, ?2, 'editor', ?3, ?4)`).bind(w.wbId, editor.id, w.owner.id, new Date().toISOString()).run()
    const refused = await call(h.app, 'POST', `/api/workbooks/${w.wbId}/link`, { user: editor, env: h.env, body: plan })
    expect(refused.status).toBe(403)
    expect(isArabic((await json<{ message: string }>(refused)).message)).toBe(true)
  })

  it('still links without the service account: the webhook waits, a notice says why', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'مهمة' }] })
    expect(h.fake.webhooks.size).toBe(0)
    expect(todoByTitle(h, 'مهمة')).toBeDefined()
    const state = await json<WorkbookSyncResponse>(await call(h.app, 'GET', `/api/workbooks/${l.wbId}/sync`, { user: l.owner, env: h.env }))
    expect(state.state).toBe('synced')
    expect(isArabic(state.notice)).toBe(true)
    expect(state.notice).toContain('حساب الخدمة')
  })

  it('resumes an interrupted commit without creating the project twice', async () => {
    const h = harness()
    const w = await unlinkedWorkbook(h, [{ title: 'مهمة' }])
    // The list creation fails after the project was created.
    h.fake.fail((c) => c.method === 'POST' && /\/todolists\.json$/.test(c.path), 422)
    const plan: LinkPlan = { project: { mode: 'create', name: 'مشروع' }, sheets: [{ ...defaultSheetPlan(w.sheet.id), mode: 'new' }] }
    const first = await call(h.app, 'POST', `/api/workbooks/${w.wbId}/link`, { user: w.owner, env: h.env, body: plan })
    expect(first.status).toBeGreaterThanOrEqual(400)
    const projects = h.fake.projects.size
    const second = await call(h.app, 'POST', `/api/workbooks/${w.wbId}/link`, { user: w.owner, env: h.env, body: plan })
    expect(second.status).toBe(200)
    expect(h.fake.projects.size).toBe(projects)
  })
})
