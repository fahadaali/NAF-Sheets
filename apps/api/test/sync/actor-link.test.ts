// The acting person's Basecamp link (spec §3, S17) and the one documented use
// of the service token for a write (§8.1): when the person whose change is
// being sent has no usable link, their edits stay pending with the re-link
// message and are never sent under another account — except the automatic
// union of a to-do's subtasks' assignees, and only when nothing else changed.

import { describe, expect, it } from 'vitest'
import { call, drainOutbound, dropLink, edit, harness, json, linkUser, readSheetView, reconcile, runOutbound, setupLinked, syncLog, task, todoByTitle } from './harness'
import type { Linked } from './harness'

const RELINK = /أعد ربط|اربط حسابك/

async function autoParent(): Promise<Linked> {
  const h = harness()
  return setupLinked(h, {
    people: ['سارة', 'بدر'],
    service: true,
    hierarchy: { mode: 'indent' },
    rows: [{ title: 'الأم' }, { title: 'ف1', indent: true, assignees: 'سارة' }],
  })
}

/** Basecamp calls made with the service account's token since `from`. */
function serviceCalls(l: Linked, from: number) {
  return l.h.fake.calls.slice(from).filter((c) => l.h.fake.tokens.get(c.token) === l.servicePerson?.id)
}

describe('§8.1 with an author whose link is gone', () => {
  it('(i) only the automatic union changed: written with the service token, notify false, logged «قاعدة تلقائية»', async () => {
    const l = await autoParent()
    const { h } = l
    const parent = todoByTitle(h, 'الأم')
    await edit(l, (v) => v.set(v.row('ف1'), 'B', 'بدر'))
    // The subtask goes out with the owner's token; its to-do is queued after it…
    const [subtaskMessage] = h.outbound.take()
    await runOutbound(h, [{ body: subtaskMessage!.body }])
    const [parentMessage] = h.outbound.take()
    expect(parentMessage?.body.taskUid).toBe((await readSheetView(l)).uid('الأم'))
    // …and the owner's link is revoked before the to-do's turn.
    await dropLink(l.owner.id, 'revoked')
    const from = h.fake.calls.length
    await runOutbound(h, [{ body: parentMessage!.body }])

    const put = h.fake.callsTo('PUT', new RegExp(`^/todos/${parent.id}\\.json$`)).at(-1)
    expect(put?.body).toMatchObject({ assignee_ids: [l.people['بدر']?.id], notify: false })
    expect(h.fake.tokens.get(put?.token ?? '')).toBe(l.servicePerson?.id)
    expect(serviceCalls(l, from).filter((c) => c.method !== 'GET').map((c) => c.path)).toEqual([`/todos/${parent.id}.json`])
    expect((await syncLog(l.wbId, 'update_todo')).at(-1)?.actor).toBe('قاعدة تلقائية')
    const row = await task(parentMessage!.body.taskUid)
    expect(row).toMatchObject({ sync_state: 'synced', assign_mode: 'auto' })
  })

  it('(ii) auto mode but a person’s own change too: nothing goes with the service token; pending with the re-link message', async () => {
    const l = await autoParent()
    const { h } = l
    await dropLink(l.owner.id, 'revoked')
    await edit(l, (v) => {
      v.set(v.row('ف1'), 'B', 'بدر')
      v.set(v.row('الأم'), 'D', '2026-12-31')
      v.set(v.row('الأم'), 'A', 'الأم بعنوان جديد')
      v.set(v.row('الأم بعنوان جديد'), 'E', 'منجز')
    })
    const from = h.fake.calls.length
    await drainOutbound(h)
    expect(h.fake.calls.slice(from).filter((c) => c.method !== 'GET')).toEqual([])
    expect(serviceCalls(l, from).filter((c) => c.method !== 'GET')).toEqual([])
    expect((await syncLog(l.wbId)).filter((r) => r.actor === 'قاعدة تلقائية')).toEqual([])
    const view = await readSheetView(l)
    for (const title of ['الأم بعنوان جديد', 'ف1']) {
      const row = await task(view.uid(title))
      expect(row).toMatchObject({ sync_state: 'pending', last_error_code: 'actor_link_revoked' })
      expect(row.last_error).toMatch(RELINK)
    }
    const parent = todoByTitle(h, 'الأم')
    expect(parent).toMatchObject({ dueOn: null, completed: false, assigneeIds: [l.people['سارة']?.id] })

    // Linking again sends both, with the owner's own (new) token.
    const token = await linkUser(h, l.owner.id, l.ownerPerson)
    await call(h.app, 'GET', `/api/workbooks/${l.wbId}/sync`, { user: l.owner, env: h.env })
    await drainOutbound(h)
    expect(todoByTitle(h, 'الأم بعنوان جديد')).toMatchObject({ dueOn: '2026-12-31', completed: true })
    const writes = h.fake.calls.slice(from).filter((c) => c.method !== 'GET')
    expect(writes.length).toBeGreaterThan(0)
    for (const c of writes) expect(c.token).toBe(token)
  })

  it('(iii) a to-do assigned by hand (manual mode): the service token is never used', async () => {
    const h = harness()
    const l = await setupLinked(h, {
      people: ['سارة'],
      service: true,
      hierarchy: { mode: 'indent' },
      rows: [{ title: 'الأم', assignees: 'أحمد المالك' }, { title: 'ف1', indent: true, assignees: 'سارة' }],
    })
    const uid = (await readSheetView(l)).uid('الأم')
    expect((await task(uid)).assign_mode).toBe('manual')
    await dropLink(l.owner.id, 'revoked')
    const from = h.fake.calls.length
    await edit(l, (v) => v.set(v.row('الأم'), 'D', '2026-12-31'))
    await drainOutbound(h)
    expect(serviceCalls(l, from)).toEqual([])
    expect(h.fake.calls.slice(from).filter((c) => c.method !== 'GET')).toEqual([])
    expect(await task(uid)).toMatchObject({ sync_state: 'pending', last_error_code: 'actor_link_revoked' })
  })
})

describe('a link that expired', () => {
  it('keeps the row pending with the expiry message; reconciliation sends it as soon as the link is active again', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أولى' }], service: true })
    await dropLink(l.owner.id, 'expired')
    await edit(l, (v) => v.set(v.row('أولى'), 'D', '2026-12-31'))
    await drainOutbound(h)
    const uid = (await readSheetView(l)).uid('أولى')
    const held = await task(uid)
    expect(held).toMatchObject({ sync_state: 'pending', last_error_code: 'actor_link_expired' })
    expect(held.last_error).toContain('انتهت صلاحيته')
    const body = await json<{ tasks: Array<{ uid: string; message: string | null }> }>(await call(h.app, 'GET', `/api/workbooks/${l.wbId}/sync`, { user: l.owner, env: h.env }))
    expect(body.tasks.find((t) => t.uid === uid)?.message).toBe(held.last_error)

    // Still unlinked: reconciliation leaves it alone (no churn).
    await reconcile(h)
    expect(h.outbound.sent).toEqual([])

    // Linked again: the very next reconciliation queues it (no 10-minute wait).
    const token = await linkUser(h, l.owner.id, l.ownerPerson)
    await reconcile(h)
    expect(h.outbound.sent.map((m) => [m.body.taskUid, m.body.actorUserId])).toEqual([[uid, l.owner.id]])
    await drainOutbound(h)
    const put = h.fake.callsTo('PUT', /^\/todos\/\d+\.json$/).at(-1)
    expect(put?.token).toBe(token)
    expect(await task(uid)).toMatchObject({ sync_state: 'synced', last_error: null })
  })
})
