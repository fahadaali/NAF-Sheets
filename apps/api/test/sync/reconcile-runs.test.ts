// Reconciliation cost and overlap (docs/load-test.md, finding L3): a to-do is
// read one by one only when its list entry shows a change; a run holds a lease
// so two never overlap; a run stops at its time budget and the next continues.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { runReconciliationWith } from '../../src/sync/inbound'
import { RECONCILE_JOB } from '../../src/sync/inbound/reconcile'
import { drainOutbound, edit, harness, readSheetView, reconcile, setupLinked, task, todoByTitle } from './harness'
import type { Harness } from './harness'

const todoReads = (h: Harness, from: number) => h.fake.calls.slice(from).filter((c) => c.method === 'GET' && /^\/todos\/\d+\.json$/.test(c.path))

describe('reading to-dos only when the list shows a change', () => {
  it('after linking, completed to-dos (204, no updated_at) are confirmed from the list, not read one by one', async () => {
    const h = harness()
    const l = await setupLinked(h, { service: true, rows: [{ title: 'منجزة 1', done: true }, { title: 'منجزة 2', done: true }, { title: 'مفتوحة' }] })
    expect(h.fake.callsTo('POST', /^\/todos\/\d+\/completion\.json$/)).toHaveLength(2)
    const from = h.fake.calls.length
    const first = await reconcile(h)
    expect(todoReads(h, from)).toEqual([])
    expect(first.todosConfirmedFromList).toBeGreaterThanOrEqual(2)
    // The confirmed updated_at is stored: the next run is quiet.
    const view = await readSheetView(l)
    expect((await task(view.uid('منجزة 1'))).sync_state).toBe('synced')
    const stored = await env.DB.prepare(`SELECT last_remote_change_at AS at FROM tasks WHERE task_uid = ?1`).bind(view.uid('منجزة 1')).first<{ at: string }>()
    expect(stored?.at).toBe(todoByTitle(h, 'منجزة 1').updatedAt)
    const again = h.fake.calls.length
    await reconcile(h)
    expect(todoReads(h, again)).toEqual([])
  })

  it('a change made in Basecamp is still read and applied; so is a change of completion subscribers alone', async () => {
    const h = harness()
    const l = await setupLinked(h, { service: true, rows: [{ title: 'أولى' }, { title: 'ثانية' }] })
    await reconcile(h)
    const one = todoByTitle(h, 'أولى')
    one.content = 'أولى معدّلة'
    one.updatedAt = h.fake.tick()
    const two = todoByTitle(h, 'ثانية')
    two.completionSubscriberIds = [l.ownerPerson.id]
    two.updatedAt = h.fake.tick()
    const from = h.fake.calls.length
    const report = await reconcile(h)
    expect(todoReads(h, from).map((c) => Number(/\d+/.exec(c.path)?.[0])).sort()).toEqual([one.id, two.id].sort())
    expect(report.todosRead).toBeGreaterThanOrEqual(2)
    const view = await readSheetView(l)
    expect(view.row('أولى معدّلة')).toBeGreaterThan(0)
  })

  it('a to-do with subtasks is read when its updated_at moved, even if its own fields did not change', async () => {
    const h = harness()
    const l = await setupLinked(h, {
      service: true,
      hierarchy: { mode: 'indent' },
      rows: [{ title: 'رئيسية' }, { title: 'فرعية', indent: true }],
    })
    await drainOutbound(h)
    await reconcile(h)
    const parent = todoByTitle(h, 'رئيسية')
    const sub = [...h.fake.subtasks.values()].find((s) => s.title === 'فرعية')!
    sub.title = 'فرعية معدّلة'
    sub.updatedAt = h.fake.tick()
    parent.updatedAt = h.fake.tick()
    const from = h.fake.calls.length
    await reconcile(h)
    expect(todoReads(h, from).some((c) => c.path === `/todos/${parent.id}.json`)).toBe(true)
    expect((await readSheetView(l)).row('فرعية معدّلة')).toBeGreaterThan(0)
  })

  it('a row with a change of its own still pending is not confirmed from the list', async () => {
    const h = harness()
    const l = await setupLinked(h, { service: true, rows: [{ title: 'معلّقة', done: true }] })
    await edit(l, (v) => v.set(v.row('معلّقة'), 'D', '2026-12-30'))
    h.outbound.take()
    const from = h.fake.calls.length
    await reconcile(h)
    // pending → read as before (the step leaves the local change to its author's message).
    expect(todoReads(h, from)).toHaveLength(1)
  })
})

describe('the cron run: one at a time, within its budget', () => {
  it('skips a run while another holds the lease, without reading Basecamp', async () => {
    const h = harness()
    await setupLinked(h, { service: true, rows: [{ title: 'أ' }] })
    await reconcile(h)
    await env.DB.prepare(`UPDATE sync_jobs SET lease_id = 'another-run', lease_until = ?2 WHERE name = ?1`)
      .bind(RECONCILE_JOB, new Date(Date.now() + 5 * 60_000).toISOString())
      .run()
    try {
      const from = h.fake.calls.length
      const report = await reconcile(h)
      expect(report.stopped).toBe('already_running')
      expect(h.fake.calls.length).toBe(from)
    } finally {
      await env.DB.prepare(`UPDATE sync_jobs SET lease_id = NULL, lease_until = NULL WHERE name = ?1`).bind(RECONCILE_JOB).run()
    }
    // An expired lease (a run that died) does not block the next one.
    await env.DB.prepare(`UPDATE sync_jobs SET lease_id = 'dead-run', lease_until = ?2 WHERE name = ?1`)
      .bind(RECONCILE_JOB, new Date(Date.now() - 1000).toISOString())
      .run()
    expect((await reconcile(h)).stopped).toBeNull()
  })

  it('stops between lists at its budget and the next run continues where it stopped, until every list was read', async () => {
    const h = harness()
    const a = await setupLinked(h, { service: true, rows: [{ title: 'أ' }] })
    const b = await setupLinked(h, { rows: [{ title: 'ب' }] })
    await reconcile(h)
    // A clock that jumps 10 minutes at every read of a list: each run (budget 12 minutes) does a list or two.
    let t = Date.now()
    const clock = () => t
    const fetch = h.deps.fetch
    const deps = {
      ...h.deps,
      fetch: async (url: string, init: RequestInit) => {
        if (/\/todolists\/\d+\/todos\.json/.test(url)) t += 10 * 60_000
        return fetch(url, init)
      },
    }
    const listsRead = new Set<number>()
    const from = h.fake.calls.length
    let runs = 0
    let continued = 0
    let resumed = 0
    for (; runs < 200; runs++) {
      const report = await runReconciliationWith(h.env, deps, { clock })
      expect(report.stopped).toBeNull()
      expect(report.lists).toBeGreaterThanOrEqual(1)
      if (report.resumedFrom) resumed++
      if (!report.continued) break
      continued++
    }
    for (const c of h.fake.calls.slice(from)) {
      const m = /^\/todolists\/(\d+)\/todos\.json$/.exec(c.path)
      if (m) listsRead.add(Number(m[1]))
    }
    expect(continued).toBeGreaterThan(0)
    expect(resumed).toBe(continued)
    expect(listsRead.has(a.list.id)).toBe(true)
    expect(listsRead.has(b.list.id)).toBe(true)
    const job = await env.DB.prepare(`SELECT lease_id, cursor_json FROM sync_jobs WHERE name = ?1`).bind(RECONCILE_JOB).first<{ lease_id: string | null; cursor_json: string | null }>()
    expect(job).toEqual({ lease_id: null, cursor_json: null })
  })
})
