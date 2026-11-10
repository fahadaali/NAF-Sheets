// Reconciliation (spec §9.4): every linked list with If-None-Match and the
// stored ETag, following Link rel="next"; `steps` carries 100 subtasks only;
// webhooks re-enabled or recreated; people caches refreshed; read-only.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { edit, harness, readSheetView, reconcile, setupLinked, task, todoByTitle } from './harness'

describe('reconciliation', () => {
  it('answers 304 when nothing changed: no to-do is read again', async () => {
    const h = harness()
    await setupLinked(h, { rows: [{ title: 'أ' }, { title: 'ب' }], service: true })
    await reconcile(h)
    const calls = h.fake.calls.length
    const report = await reconcile(h)
    const second = h.fake.calls.slice(calls)
    const lists = second.filter((c) => /^\/todolists\/\d+\/todos\.json$/.test(c.path))
    expect(lists.length).toBe(2)
    for (const c of lists) expect(c.headers['if-none-match']).toBeTruthy()
    expect(second.filter((c) => /^\/todos\/\d+\.json$/.test(c.path))).toEqual([])
    expect(report.notModified).toBe(1)
  })

  it('follows Link rel="next" and creates rows for to-dos made in Basecamp', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'من المنصة' }], service: true })
    h.fake.pageSize = 2
    for (const n of [1, 2, 3, 4, 5]) h.fake.addTodo(l.list.id, { content: `من Basecamp ${n}` })
    await reconcile(h)
    const pages = h.fake.calls.filter((c) => /^\/todolists\/\d+\/todos\.json$/.test(c.path) && c.query.get('completed') !== 'true').map((c) => c.query.get('page'))
    expect(pages).toEqual(expect.arrayContaining([null, '2', '3']))
    const view = await readSheetView(l)
    for (const n of [1, 2, 3, 4, 5]) expect(view.row(`من Basecamp ${n}`)).toBeGreaterThan(0)
    expect(view.row('من المنصة')).toBeGreaterThan(0)
  })

  it('reads every subtask through subtasks_url when a to-do has more than 100 (steps carries the first 100)', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أ' }], service: true })
    const todo = h.fake.addTodo(l.list.id, { content: 'مهمة كبيرة' })
    for (let i = 1; i <= 105; i++) h.fake.addSubtask(todo.id, { title: `ف${i}` })
    await reconcile(h)
    expect(h.fake.calls.some((c) => c.path === `/recordings/${todo.id}/subtasks.json`)).toBe(true)
    const parent = (await env.DB.prepare(`SELECT task_uid FROM tasks WHERE bc_recording_id = ?1`).bind(todo.id).first<{ task_uid: string }>())?.task_uid
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE parent_uid = ?1`).bind(parent).first<{ n: number }>()
    expect(count?.n).toBe(105)
    const view = await readSheetView(l)
    expect(view.row('ف105')).toBeGreaterThan(view.row('ف1'))
  })

  it('re-enables a webhook Basecamp disabled, and catches an edit made while it was off', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'قبل' }], service: true })
    const hook = [...h.fake.webhooks.values()][0]
    if (!hook) throw new Error('no webhook')
    hook.active = false
    const todo = todoByTitle(h, 'قبل')
    todo.content = 'بعد'
    todo.updatedAt = h.fake.tick()
    await reconcile(h)
    expect(h.fake.callsTo('PUT', new RegExp(`^/webhooks/${hook.id}\\.json$`))[0]?.body).toMatchObject({ active: true })
    expect(hook.active).toBe(true)
    const view = await readSheetView(l)
    expect(view.row('بعد')).toBeGreaterThan(0)
    const writes = h.fake.writes().filter((c) => !c.path.startsWith('/webhooks/'))
    expect(writes.filter((c) => /^\/todos\//.test(c.path) && c.method === 'PUT')).toEqual([])
  })

  it('recreates a webhook Basecamp no longer has (404); the old row is kept as replaced', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أ' }], service: true })
    const old = [...h.fake.webhooks.values()][0]
    if (!old) throw new Error('no webhook')
    h.fake.webhooks.delete(old.id)
    await reconcile(h)
    expect([...h.fake.webhooks.values()].filter((w) => w.projectId === l.project.id)).toHaveLength(1)
    const rows = await env.DB.prepare(`SELECT bc_webhook_id, replaced_at FROM bc_webhooks WHERE bc_project_id = ?1 ORDER BY created_at`).bind(l.project.id).all<{ bc_webhook_id: number; replaced_at: string | null }>()
    expect(rows.results).toHaveLength(2)
    expect(rows.results.find((r) => r.bc_webhook_id === old.id)?.replaced_at).not.toBeNull()
  })

  it('refreshes the project and account people caches with the service token', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أ' }], service: true })
    const newcomer = h.fake.person('عضو جديد')
    h.fake.projects.get(l.project.id)?.peopleIds.add(newcomer.id)
    await reconcile(h)
    const cached = await env.DB.prepare(`SELECT name FROM bc_people_cache WHERE bc_project_id = ?1 AND bc_person_id = ?2`).bind(l.project.id, newcomer.id).first<{ name: string }>()
    expect(cached?.name).toBe('عضو جديد')
    const account = await env.DB.prepare(`SELECT name FROM bc_account_people_cache WHERE bc_person_id = ?1`).bind(newcomer.id).first<{ name: string }>()
    expect(account?.name).toBe('عضو جديد')
  })

  it('queues again a row left pending (its message may have been lost), with its own author', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أ' }], service: true })
    h.outbound.failing = true
    await edit(l, (v) => v.set(v.row('أ'), 'D', '2026-12-31'))
    h.outbound.failing = false
    const uid = (await readSheetView(l)).uid('أ')
    await env.DB.prepare(`UPDATE tasks SET last_local_change_at = ?2 WHERE task_uid = ?1`).bind(uid, new Date(Date.now() - 3600_000).toISOString()).run()
    await reconcile(h)
    expect(h.outbound.sent.map((m) => [m.body.taskUid, m.body.actorUserId])).toEqual([[uid, l.owner.id]])
    expect((await task(uid)).sync_state).toBe('pending')
  })

  it('without a service account it reads nothing and changes nothing', async () => {
    const h = harness()
    await setupLinked(h, { rows: [{ title: 'أ' }] })
    const calls = h.fake.calls.length
    await reconcile(h)
    expect(h.fake.calls.length).toBe(calls)
  })
})
