// Outbound sync (spec §9.2): detection after a save, the bc-outbound
// consumer, Basecamp's two update behaviours, retries, idempotency, the dead
// letter queue, Account Inactive, and the acting user's own token (§3).

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { isArabic } from '../helpers'
import {
  call,
  drainOutbound,
  edit,
  harness,
  json,
  linkUser,
  readSheetView,
  runOutbound,
  seedMember,
  setupLinked,
  subtaskByTitle,
  task,
  todoByTitle,
} from './harness'

describe('detection after a save', () => {
  it('queues only the rows that changed, with delaySeconds 2, and marks them pending', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أولى' }, { title: 'ثانية' }] })
    await edit(l, (v) => v.set(v.row('ثانية'), 'D', '2026-12-24'))
    const sent = h.outbound.sent
    const view = await readSheetView(l)
    expect(sent.map((s) => s.body.taskUid)).toEqual([view.uid('ثانية')])
    expect(sent[0]?.delaySeconds).toBe(2)
    expect(sent[0]?.body).toMatchObject({ kind: 'task_changed', workbookId: l.wbId, actorUserId: l.owner.id })
    expect((await task(view.uid('ثانية'))).sync_state).toBe('pending')
    expect((await task(view.uid('أولى'))).sync_state).toBe('synced')
  })

  it('never refuses a save for a sync reason: the queue failing leaves the row pending', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أولى' }] })
    h.outbound.failing = true
    await edit(l, (v) => v.set(v.row('أولى'), 'D', '2026-12-24'))
    const view = await readSheetView(l)
    expect((await task(view.uid('أولى'))).sync_state).toBe('pending')
  })

  it('refuses a malformed confirmedDeletions before writing anything (it can never delete)', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أولى' }] })
    const view = await readSheetView(l)
    const res = await call(h.app, 'PUT', `/api/workbooks/${l.wbId}/snapshot`, {
      user: l.owner,
      env: h.env,
      body: { baseVersion: view.version, snapshot: view.snapshot, confirmedDeletions: 'all' },
    })
    expect(res.status).toBe(400)
    expect((await readSheetView(l)).version).toBe(view.version)
  })
})

describe('to-do update: PUT /todos/{id}.json carries every field', () => {
  it('a due date change sends all six fields and keeps assignees and description (§16 scenario 9)', async () => {
    const h = harness()
    const l = await setupLinked(h, { people: ['سارة'], rows: [{ title: 'إطلاق', assignees: 'سارة', notes: 'خطة النشر', starts: '2026-11-20' }] })
    const todo = todoByTitle(h, 'إطلاق')
    todo.completionSubscriberIds = [l.ownerPerson.id]
    const before = { assignees: [...todo.assigneeIds], description: todo.description }
    expect(before.assignees).toEqual([l.people['سارة']?.id])

    await edit(l, (v) => v.set(v.row('إطلاق'), 'D', '2026-12-31'))
    await drainOutbound(h)

    const puts = h.fake.callsTo('PUT', /^\/todos\/\d+\.json$/)
    expect(puts).toHaveLength(1)
    const body = puts[0]?.body as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['assignee_ids', 'completion_subscriber_ids', 'content', 'description', 'due_on', 'notify', 'starts_on'])
    expect(body).toMatchObject({ content: 'إطلاق', due_on: '2026-12-31', starts_on: '2026-11-20', assignee_ids: before.assignees, completion_subscriber_ids: [l.ownerPerson.id], notify: false })
    expect(todo.description).toBe(before.description)
    expect(todo.assigneeIds).toEqual(before.assignees)
    expect(puts[0]?.token).toBe(l.token)
    expect((await task((await readSheetView(l)).uid('إطلاق'))).sync_state).toBe('synced')
  })

  it('completion goes through the completion endpoint, not the update', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'إطلاق', done: false }] })
    await edit(l, (v) => v.set(v.row('إطلاق'), 'E', 'منجز'))
    await drainOutbound(h)
    expect(h.fake.callsTo('POST', /^\/todos\/\d+\/completion\.json$/)).toHaveLength(1)
    expect(h.fake.callsTo('PUT', /^\/todos\/\d+\.json$/)).toHaveLength(0)
    expect(todoByTitle(h, 'إطلاق').completed).toBe(true)
  })
})

describe('subtask update: PUT /subtasks/{id}.json is partial', () => {
  it('sends only the changed field; null clears the date, [] removes the assignees', async () => {
    const h = harness()
    const l = await setupLinked(h, {
      people: ['سارة'],
      hierarchy: { mode: 'indent' },
      rows: [{ title: 'الأم', assignees: 'أحمد المالك' }, { title: 'فرعية', indent: true, assignees: 'سارة', due: '2026-12-01' }],
    })
    await edit(l, (v) => v.set(v.row('فرعية'), 'A', '    فرعية معدلة'))
    await drainOutbound(h)
    let puts = h.fake.callsTo('PUT', /^\/subtasks\/\d+\.json$/)
    expect(puts.map((p) => p.body)).toEqual([{ title: 'فرعية معدلة' }])

    await edit(l, (v) => {
      v.set(v.row('فرعية معدلة'), 'D', null)
      v.set(v.row('فرعية معدلة'), 'B', null)
    })
    await drainOutbound(h)
    puts = h.fake.callsTo('PUT', /^\/subtasks\/\d+\.json$/)
    expect(puts[1]?.body).toEqual({ due_on: null, assignee_ids: [] })
    const st = subtaskByTitle(h, 'فرعية معدلة')
    expect(st.dueOn).toBeNull()
    expect(st.assigneeIds).toEqual([])
  })
})

describe('retries and idempotency (§9.1, §9.2.8–9)', () => {
  it('5xx on create: retried with backoff, then created exactly once; a duplicate message creates nothing', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أولى' }] })
    await edit(l, (v) => {
      const row = Math.max(...Object.keys(v.cells).map(Number)) + 1
      v.cells[row] = { 0: { v: 'جديدة' }, [v.uidColumn]: { v: 'uid-new-1', t: 1 }, [v.uidColumn + 2]: { v: 0, t: 2 } }
    })
    const [pending] = h.outbound.take()
    expect(pending?.body.taskUid).toBe('uid-new-1')
    h.fake.fail((c) => c.method === 'POST' && /\/todos\.json$/.test(c.path), 503)
    const first = await runOutbound(h, [{ body: pending!.body, attempts: 1 }])
    expect(first.retryMessages).toHaveLength(1)
    expect(first.retryMessages[0]?.delaySeconds).toBe(10)
    expect(h.fake.todos.size).toBe(1)

    const second = await runOutbound(h, [{ body: pending!.body, attempts: 2 }])
    expect(second.explicitAcks).toHaveLength(1)
    expect([...h.fake.todos.values()].filter((t) => t.content === 'جديدة')).toHaveLength(1)
    const created = (await task('uid-new-1')).bc_recording_id
    expect(created).toBe(todoByTitle(h, 'جديدة').id)

    await runOutbound(h, [{ body: pending!.body }])
    expect([...h.fake.todos.values()].filter((t) => t.content === 'جديدة')).toHaveLength(1)
    expect(h.fake.callsTo('POST', /\/todos\.json$/).filter((c) => (c.body as { content: string }).content === 'جديدة')).toHaveLength(2)
  })

  it('two concurrent messages for the same new task create it once', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أولى' }] })
    await edit(l, (v) => {
      const row = Math.max(...Object.keys(v.cells).map(Number)) + 1
      v.cells[row] = { 0: { v: 'متزامنة' }, [v.uidColumn]: { v: 'uid-race-1', t: 1 }, [v.uidColumn + 2]: { v: 0, t: 2 } }
    })
    const [pending] = h.outbound.take()
    const results = await Promise.all([runOutbound(h, [{ body: pending!.body }]), runOutbound(h, [{ body: pending!.body }])])
    expect([...h.fake.todos.values()].filter((t) => t.content === 'متزامنة')).toHaveLength(1)
    const retried = results.flatMap((r) => r.retryMessages)
    const acked = results.flatMap((r) => r.explicitAcks)
    expect(retried.length + acked.length).toBe(2)
    // Whichever lost the race is a no-op when it comes back.
    for (const _ of retried) await runOutbound(h, [{ body: pending!.body }])
    expect([...h.fake.todos.values()].filter((t) => t.content === 'متزامنة')).toHaveLength(1)
  })

  it('429: waits the Retry-After seconds through message.retry', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أولى' }] })
    await edit(l, (v) => v.set(v.row('أولى'), 'D', '2026-12-24'))
    const [pending] = h.outbound.take()
    h.fake.fail((c) => c.method === 'PUT', 429, { headers: { 'Retry-After': '7' } })
    const result = await runOutbound(h, [{ body: pending!.body }])
    expect(result.retryMessages).toEqual([{ msgId: expect.any(String), delaySeconds: 7 }])
  })

  it('5xx backs off exponentially; after the 5th attempt: dead-letter queue, row error in Arabic', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أولى' }] })
    await edit(l, (v) => v.set(v.row('أولى'), 'D', '2026-12-24'))
    const [pending] = h.outbound.take()
    h.fake.fail((c) => c.method === 'PUT', 500, { times: 10 })
    const delays: number[] = []
    for (let attempt = 1; attempt <= 4; attempt++) {
      const r = await runOutbound(h, [{ body: pending!.body, attempts: attempt }])
      delays.push(r.retryMessages[0]?.delaySeconds as number)
    }
    expect(delays).toEqual([10, 20, 40, 80])
    const last = await runOutbound(h, [{ body: pending!.body, attempts: 5, id: 'dead-1' }])
    expect(last.explicitAcks).toEqual(['dead-1'])
    expect(h.dlq.sent.map((m) => m.body)).toEqual([pending!.body])
    const row = await task(pending!.body.taskUid)
    expect(row.sync_state).toBe('error')
    expect(row.last_error_code).toBe('retries_exhausted')
    expect(isArabic(row.last_error)).toBe(true)
    const dead = await env.DB.prepare(`SELECT queue, attempts FROM sync_dead_letters WHERE id = 'dead-1'`).first()
    expect(dead).toMatchObject({ queue: 'bc-outbound', attempts: 5 })
  })

  it('404 is never retried: the row goes to error with an Arabic message', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أولى' }] })
    await edit(l, (v) => v.set(v.row('أولى'), 'D', '2026-12-24'))
    const [pending] = h.outbound.take()
    h.fake.fail((c) => c.method === 'PUT', 404)
    const result = await runOutbound(h, [{ body: pending!.body }])
    expect(result.retryMessages).toEqual([])
    expect(result.explicitAcks).toHaveLength(1)
    const row = await task(pending!.body.taskUid)
    expect(row).toMatchObject({ sync_state: 'error', last_error_code: 'not_found' })
    expect(isArabic(row.last_error)).toBe(true)
  })

  it('Reason: Account Inactive stops the whole account and raises a notice; nothing else is sent', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أولى' }, { title: 'ثانية' }] })
    await edit(l, (v) => {
      v.set(v.row('أولى'), 'D', '2026-12-24')
      v.set(v.row('ثانية'), 'D', '2026-12-25')
    })
    const pending = h.outbound.take()
    h.fake.fail(() => true, 404, { headers: { Reason: 'Account Inactive' } })
    const first = await runOutbound(h, [{ body: pending[0]!.body }])
    expect(first.retryMessages).toEqual([])
    const account = await env.DB.prepare(`SELECT status FROM sync_accounts WHERE bc_account_id = ?1`).bind(h.fake.accountId).first<{ status: string }>()
    expect(account?.status).toBe('inactive')
    const calls = h.fake.calls.length
    await runOutbound(h, [{ body: pending[1]!.body }])
    expect(h.fake.calls.length).toBe(calls)
    expect((await task(pending[1]!.body.taskUid)).sync_state).toBe('pending')
    const state = await json<{ notice: string }>(await call(h.app, 'GET', `/api/workbooks/${l.wbId}/sync`, { user: l.owner, env: h.env }))
    expect(state.notice).toContain('غير نشط')
    const audit = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'basecamp.account.inactive' AND entity_id = ?1`).bind(String(h.fake.accountId)).first<{ n: number }>()
    expect(audit?.n).toBe(1)
  })
})

describe('the acting user (§3)', () => {
  it('each edit goes out with its author’s own token', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أولى' }, { title: 'ثانية' }] })
    const colleague = await seedMember('editor')
    await env.DB.prepare(`INSERT INTO workbook_members (workbook_id, user_id, role, added_by, added_at) VALUES (?1, ?2, 'editor', ?3, ?4)`).bind(l.wbId, colleague.id, l.owner.id, new Date().toISOString()).run()
    const colleaguePerson = h.fake.person('زميل')
    h.fake.projects.get(l.project.id)?.peopleIds.add(colleaguePerson.id)
    const colleagueToken = await linkUser(h, colleague.id, colleaguePerson)
    await edit(l, (v) => v.set(v.row('أولى'), 'D', '2026-12-01'))
    await edit(l, (v) => v.set(v.row('ثانية'), 'D', '2026-12-02'), { user: colleague })
    await drainOutbound(h)
    const puts = h.fake.callsTo('PUT', /^\/todos\/\d+\.json$/)
    const byTitle = new Map(puts.map((p) => [(p.body as { content: string }).content, p.token]))
    expect(byTitle.get('أولى')).toBe(l.token)
    expect(byTitle.get('ثانية')).toBe(colleagueToken)
  })

  it('an actor without an active link: row error asking to link, never the service token', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أولى' }], service: true })
    const stranger = await seedMember('editor')
    await env.DB.prepare(`INSERT INTO workbook_members (workbook_id, user_id, role, added_by, added_at) VALUES (?1, ?2, 'editor', ?3, ?4)`).bind(l.wbId, stranger.id, l.owner.id, new Date().toISOString()).run()
    const writes = h.fake.writes().length
    await edit(l, (v) => v.set(v.row('أولى'), 'D', '2026-12-01'), { user: stranger })
    await drainOutbound(h)
    expect(h.fake.writes().length).toBe(writes)
    const row = await task((await readSheetView(l)).uid('أولى'))
    expect(row.sync_state).toBe('error')
    expect(row.last_error_code).toBe('actor_not_linked')
    expect(row.last_error).toContain('اربط حسابك')
  })
})

describe('automatic assignment from the sheet (§8.1)', () => {
  it('a subtask re-assigned in the sheet: the to-do in auto mode follows, with the actor’s token and notify false', async () => {
    const h = harness()
    const l = await setupLinked(h, {
      people: ['سارة', 'بدر'],
      hierarchy: { mode: 'indent' },
      rows: [{ title: 'الأم' }, { title: 'ف1', indent: true, assignees: 'سارة' }, { title: 'ف2', indent: true, assignees: 'سارة' }],
    })
    const parent = todoByTitle(h, 'الأم')
    expect(parent.assigneeIds).toEqual([l.people['سارة']?.id])
    await edit(l, (v) => v.set(v.row('ف2'), 'B', 'بدر'))
    await drainOutbound(h)
    const put = h.fake.callsTo('PUT', new RegExp(`^/todos/${parent.id}\\.json$`)).at(-1)
    expect(put?.body).toMatchObject({ assignee_ids: [l.people['سارة']?.id, l.people['بدر']?.id].sort((a, b) => (a as number) - (b as number)), notify: false })
    expect(put?.token).toBe(l.token)
    const view = await readSheetView(l)
    expect(view.text(view.row('الأم'), 'B')).toBe('سارة، بدر')
    expect((await task(view.uid('الأم'))).assign_mode).toBe('auto')
  })
})

describe('the managed block (§8.2)', () => {
  it('externals go into the block at the end; the person’s own text is kept byte for byte', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'إطلاق', assignees: 'أحمد المالك' }] })
    const todo = todoByTitle(h, 'إطلاق')
    const human = '<div>نص كتبه شخص   بمسافات&nbsp;و<strong>تنسيق</strong></div><bc-attachment sgid="BAh7" filename="plan.pdf"></bc-attachment>'
    todo.description = human
    // The row learns the human text from Basecamp first (inbound read through reconciliation).
    await env.DB.prepare(`INSERT INTO external_contacts (id, name, organization, created_by, created_at) VALUES ('ext-sara', 'سارة الخارجية', 'وكالة الإعلام', ?1, ?2)`).bind(l.owner.id, new Date().toISOString()).run()
    await edit(l, (v) => v.set(v.row('إطلاق'), 'B', 'أحمد المالك، سارة الخارجية'))
    await drainOutbound(h)
    const put = h.fake.callsTo('PUT', /^\/todos\/\d+\.json$/).at(-1)
    const description = (put?.body as { description: string }).description
    expect(description.startsWith(human)).toBe(true)
    expect(description.slice(human.length)).toContain('بيانات من منصة الاتصال المؤسسي')
    expect(description.slice(human.length)).toContain('سارة الخارجية (وكالة الإعلام)')
    expect((put?.body as { assignee_ids: number[] }).assignee_ids).toEqual([l.ownerPerson.id])
    expect(todo.description.startsWith(human)).toBe(true)
  })
})
