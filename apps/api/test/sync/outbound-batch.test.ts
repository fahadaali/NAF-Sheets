// The bc-outbound consumer loads each workbook once per batch (docs/load-test.md,
// finding L2) and keeps every per-message guarantee: its own lease, its own
// actor's token, its own retry and dead letter.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { lastBatchLoads } from '../../src/sync/outbound/consumer'
import { drainOutbound, edit, harness, linkUser, readSheetView, runOutbound, seedMember, setupLinked, task, todoByTitle } from './harness'
import type { BcOutboundMessage } from '../../src/env'

const rows = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ title: `${prefix} ${i + 1}` }))

describe('one workbook load per batch', () => {
  it('creates every task of two workbooks in one batch with one load each, each with its own author’s token', async () => {
    const h = harness()
    const a = await setupLinked(h, { rows: rows(6, 'أ'), noDrain: true })
    const b = await setupLinked(h, { rows: rows(4, 'ب'), noDrain: true })
    const pending = h.outbound.take()
    expect(pending).toHaveLength(10)
    // Interleaved, as a real batch may be.
    const order = [...pending].sort((x, y) => (x.body.taskUid < y.body.taskUid ? -1 : 1))
    const result = await runOutbound(h, order.map((p) => ({ body: p.body })))
    expect(result.explicitAcks).toHaveLength(10)
    expect(result.retryMessages).toEqual([])
    expect(lastBatchLoads.map((g) => [g.workbookId, g.messages, g.loads]).sort()).toEqual(
      [
        [a.wbId, 6, 1],
        [b.wbId, 4, 1],
      ].sort(),
    )
    for (const t of [...rows(6, 'أ'), ...rows(4, 'ب')]) expect(todoByTitle(h, t.title)).toBeTruthy()
    const creates = h.fake.callsTo('POST', /^\/todolists\/\d+\/todos\.json$/)
    expect(creates).toHaveLength(10)
    // Never a read before a create.
    expect(h.fake.callsTo('GET', /^\/todos\/\d+\.json$/)).toHaveLength(0)
    expect(creates.filter((c) => c.token === a.token)).toHaveLength(6)
    expect(creates.filter((c) => c.token === b.token)).toHaveLength(4)
    const view = await readSheetView(a)
    for (let i = 1; i <= 6; i++) expect((await task(view.uid(`أ ${i}`))).sync_state).toBe('synced')
  })

  it('a save between two messages of the batch is seen by the later one (the snapshot is refreshed, not reused)', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: rows(2, 'مهمة') })
    // Two edits queued, then the second row edited again before the batch runs.
    await edit(l, (v) => {
      v.set(v.row('مهمة 1'), 'D', '2026-12-01')
      v.set(v.row('مهمة 2'), 'D', '2026-12-02')
    })
    const queued = h.outbound.take()
    expect(queued).toHaveLength(2)
    const first = queued.find((q) => q.body.taskUid === (queued[0] as { body: BcOutboundMessage }).body.taskUid)!
    const rest = queued.filter((q) => q !== first)
    await runOutbound(h, [{ body: first.body }])
    await edit(l, (v) => v.set(v.row('مهمة 2'), 'D', '2026-12-09'))
    h.outbound.take()
    // The batch: the second row's (older) message, delivered after the newer save.
    await runOutbound(h, rest.map((q) => ({ body: q.body })))
    expect(todoByTitle(h, 'مهمة 2').dueOn).toBe('2026-12-09')
  })

  it('keeps per-message outcomes: one task’s 503 is retried alone, with its own attempts; one at its 5th attempt goes to the dead-letter queue', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: rows(3, 'صف'), noDrain: true })
    const pending = h.outbound.take()
    let creates = 0
    h.fake.fail((c) => c.method === 'POST' && /\/todos\.json$/.test(c.path) && ++creates === 2, 503, { times: 1 })
    const ids = pending.map((_, i) => `m-${i}`)
    const result = await runOutbound(h, pending.map((p, i) => ({ body: p.body, id: ids[i], attempts: i === 1 ? 2 : 1 })))
    expect(result.explicitAcks.sort()).toEqual([ids[0], ids[2]].sort())
    expect(result.retryMessages).toEqual([{ msgId: ids[1], delaySeconds: 20 }])
    expect(lastBatchLoads[0]?.loads).toBeLessThanOrEqual(2)

    // The same failure at the 5th attempt: dead letter for that message only.
    let again = 0
    h.fake.fail((c) => c.method === 'POST' && /\/todos\.json$/.test(c.path) && ++again === 1, 503, { times: 1 })
    const last = await runOutbound(h, [{ body: pending[1]!.body, id: 'm-last', attempts: 5 }])
    expect(last.explicitAcks).toEqual(['m-last'])
    expect(h.dlq.sent.map((m) => m.body.taskUid)).toEqual([pending[1]!.body.taskUid])
    expect((await task(pending[1]!.body.taskUid)).last_error_code).toBe('retries_exhausted')
    const dead = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sync_dead_letters WHERE id = 'm-last'`).first<{ n: number }>()
    expect(dead?.n).toBe(1)
    void l
  })

  it('a task leased by another step is retried (busy) without holding up the rest of the batch', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: rows(2, 'سطر'), noDrain: true })
    const pending = h.outbound.take()
    const leased = pending[0]!.body.taskUid
    await env.DB.prepare(`UPDATE tasks SET sync_lease_id = 'other', sync_lease_until = ?2 WHERE task_uid = ?1`)
      .bind(leased, new Date(Date.now() + 60_000).toISOString())
      .run()
    const result = await runOutbound(h, pending.map((p, i) => ({ body: p.body, id: `b-${i}` })))
    expect(result.retryMessages).toEqual([{ msgId: 'b-0', delaySeconds: 5 }])
    expect(result.explicitAcks).toEqual(['b-1'])
    void l
  })

  it('a second message for the same task and actor is acknowledged without a second step; another actor’s is not', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'واحدة' }] })
    const other = await seedMember('editor')
    const otherPerson = h.fake.person('محرّر آخر')
    h.fake.projects.get(l.project.id)!.peopleIds.add(otherPerson.id)
    await linkUser(h, other.id, otherPerson)
    await edit(l, (v) => v.set(v.row('واحدة'), 'D', '2026-12-05'))
    const [message] = h.outbound.take()
    const reads = () => h.fake.callsTo('GET', /^\/todos\/\d+\.json$/).length
    const before = reads()
    await runOutbound(h, [{ body: message!.body }, { body: message!.body }, { body: { ...message!.body, actorUserId: other.id } }])
    // One step for the owner (one read, one write), one for the other actor (one read, nothing to write).
    expect(reads() - before).toBe(2)
    expect(h.fake.callsTo('PUT', /^\/todos\/\d+\.json$/)).toHaveLength(1)
    await drainOutbound(h)
  })

  it('after a 429, the rest of the batch is retried at Retry-After without another request, and the limiter is paused', async () => {
    const h = harness()
    const paused: number[] = []
    h.deps.limiter = { acquire: async () => {}, pauseFor: (ms) => void paused.push(ms) }
    await setupLinked(h, { rows: rows(3, 'حد'), noDrain: true })
    const pending = h.outbound.take()
    h.fake.fail((c) => c.method === 'POST' && /\/todos\.json$/.test(c.path), 429, { headers: { 'Retry-After': '7' }, times: 1 })
    const before = h.fake.calls.length
    const result = await runOutbound(h, pending.map((p, i) => ({ body: p.body, id: `r-${i}` })))
    expect(h.fake.calls.length - before).toBe(1)
    expect(result.explicitAcks).toEqual([])
    expect(result.retryMessages.map((r) => r.msgId)).toEqual(['r-0', 'r-1', 'r-2'])
    for (const r of result.retryMessages) expect(r.delaySeconds).toBeGreaterThanOrEqual(6)
    expect(result.retryMessages[0]?.delaySeconds).toBe(7)
    expect(paused).toEqual([7000])
  })
})
