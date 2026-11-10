// Outbound detection after room commits (spec §3, §9.2, §11): each changed
// task row goes to Basecamp with the token of the person whose edit touched
// it, confirmed deletions travel on the room op that removes the rows, and
// server edits are never credited to a person.

import { env } from 'cloudflare:workers'
import { runDurableObjectAlarm } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { BcOutboundMessage } from '../../src/env'
import { outboundDetection, setOutboundDetection } from '../../src/room/outbound-seam'
import type { OutboundDetection } from '../../src/room/outbound-seam'
import { commitAuthors, detectAfterRoomCommit } from '../../src/sync/room-commit'
import { updateLatestSnapshot } from '../../src/sync/workbook-writer'
import { addMember } from '../helpers'
import { drainOutbound, harness, linkUser, readSheetView, seedMember, setupLinked, task, todoByTitle } from '../sync/harness'
import type { Harness, Linked } from '../sync/harness'
import { clientId, opId, openRoom, setValue } from './ws-client'
import type { TestSocket } from './ws-client'

vi.setConfig({ testTimeout: 60_000 })
beforeAll(async () => {
  await import('../../src/room/engine')
}, 120_000)

const D = 3
let installed: OutboundDetection | null = null
afterEach(() => {
  if (installed) setOutboundDetection(installed)
  installed = null
})

/** Runs the real detection against the harness (its recording queue and fake Basecamp). */
function detectInto(h: Harness): { calls: number } {
  installed ??= outboundDetection()
  const counter = { calls: 0 }
  setOutboundDetection(async (_env, event) => {
    counter.calls++
    await detectAfterRoomCommit(h.env, event)
  })
  return counter
}

async function join(user: { id: string }, l: Linked): Promise<{ socket: TestSocket; seq: number }> {
  const socket = await openRoom(user, l.wbId)
  socket.hello(clientId())
  const welcome = await socket.take('welcome')
  return { socket, seq: welcome.seq }
}

function room(id: string) {
  return env.WORKBOOK_ROOM.get(env.WORKBOOK_ROOM.idFromName(id))
}

const sent = (h: Harness): BcOutboundMessage[] => h.outbound.sent.map((m) => m.body)

async function pendingActor(uid: string): Promise<string | null> {
  return (await env.DB.prepare('SELECT pending_actor_id AS a FROM tasks WHERE task_uid = ?1').bind(uid).first<{ a: string | null }>())?.a ?? null
}

describe('who changed what (pure)', () => {
  const span = (sheet: string, row: number) => ({ structural: false, cells: [{ sheet, r0: row, r1: row, c0: 0, c1: 3 }], rows: [], columns: [], keys: [] })
  const STRUCT = { structural: true, cells: [], rows: [], columns: [], keys: [] }

  it('credits each row to the last person whose edit touched it; never the server', () => {
    const a = commitAuthors([
      { seq: 1, origin: 'user', userId: 'u-a', footprint: span('s', 1) },
      { seq: 2, origin: 'user', userId: 'u-b', footprint: span('s', 2) },
      { seq: 3, origin: 'user', userId: 'u-a', footprint: span('s', 2) },
      { seq: 4, origin: 'server', userId: 'system', footprint: span('s', 4) },
    ])
    expect(a.lastUser).toBe('u-a')
    expect(a.attribution.authorOf({ sheet: 's', row: 1 })).toEqual({ kind: 'user', userId: 'u-a' })
    expect(a.attribution.authorOf({ sheet: 's', row: 2 })).toEqual({ kind: 'user', userId: 'u-a' })
    expect(a.attribution.authorOf({ sheet: 's', row: 4 })).toEqual({ kind: 'server' })
    // Untouched (a formula result): the commit's last author.
    expect(a.attribution.authorOf({ sheet: 's', row: 9 })).toEqual({ kind: 'fallback', userId: 'u-a' })
    expect(a.attribution.authorOf({ sheet: 'other', row: 1 })).toEqual({ kind: 'fallback', userId: 'u-a' })
  })

  it('a person editing a row after the server changed it is credited; behind a structural edit, the last author or the server', () => {
    const a = commitAuthors([
      { seq: 1, origin: 'user', userId: 'u-a', footprint: span('s', 1) },
      { seq: 2, origin: 'server', userId: 'system', footprint: span('s', 1) },
      { seq: 3, origin: 'user', userId: 'u-b', footprint: span('s', 1) },
    ])
    expect(a.attribution.authorOf({ sheet: 's', row: 1 })).toEqual({ kind: 'user', userId: 'u-b' })
    const userStructural = commitAuthors([
      { seq: 1, origin: 'user', userId: 'u-a', footprint: span('s', 1) },
      { seq: 2, origin: 'user', userId: 'u-b', footprint: STRUCT },
    ])
    expect(userStructural.attribution.authorOf({ sheet: 's', row: 1 })).toEqual({ kind: 'fallback', userId: 'u-b' })
    const serverReload = commitAuthors([
      { seq: 1, origin: 'user', userId: 'u-a', footprint: span('s', 1) },
      { seq: 2, origin: 'server', userId: 'system', footprint: STRUCT },
    ])
    expect(serverReload.attribution.authorOf({ sheet: 's', row: 1 })).toEqual({ kind: 'server' })
    expect(commitAuthors([{ seq: 1, origin: 'server', userId: 'system', footprint: span('s', 1) }]).lastUser).toBeNull()
  })

  it('confirmed deletions are credited to the op’s author', () => {
    const a = commitAuthors([
      { seq: 1, origin: 'user', userId: 'u-a', footprint: STRUCT, confirmedDeletions: ['t1', 't2'] },
      { seq: 2, origin: 'user', userId: 'u-b', footprint: STRUCT, confirmedDeletions: ['t2'] },
    ])
    expect([...a.deletionsBy]).toEqual([
      ['t1', 'u-a'],
      ['t2', 'u-b'],
    ])
  })
})

describe('detection after a room commit', () => {
  it('the Worker entry installs it as the room’s outbound seam', async () => {
    await import('../../src/index')
    expect(outboundDetection()).toBe(detectAfterRoomCommit)
  })

  it('two people editing different rows in one commit: each row is queued with its own editor as actor', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أولى' }, { title: 'ثانية' }] })
    const other = await seedMember('editor')
    await addMember(l.wbId, other.id, 'editor', l.owner.id)
    await linkUser(h, other.id, h.fake.person('سارة'))
    const view = await readSheetView(l)
    h.outbound.take()
    detectInto(h)

    const a = await join(l.owner, l)
    const b = await join(other, l)
    a.socket.send({ type: 'op', opId: opId(), baseSeq: a.seq, epoch: 1, mutations: [setValue(l.wbId, l.univerSheetId, view.row('أولى'), D, { v: '2026-12-24', t: 1 })] })
    await a.socket.take('ack')
    b.socket.send({ type: 'op', opId: opId(), baseSeq: b.seq, epoch: 1, mutations: [setValue(l.wbId, l.univerSheetId, view.row('ثانية'), D, { v: '2026-12-25', t: 1 })] })
    await b.socket.take('ack')
    await runDurableObjectAlarm(room(l.wbId))

    const byTask = new Map(sent(h).map((m) => [m.taskUid, m.actorUserId]))
    expect(byTask.get(view.uid('أولى'))).toBe(l.owner.id)
    expect(byTask.get(view.uid('ثانية'))).toBe(other.id)
    expect(byTask.size).toBe(2)
    expect(await pendingActor(view.uid('أولى'))).toBe(l.owner.id)
    expect(await pendingActor(view.uid('ثانية'))).toBe(other.id)
    a.socket.close()
    b.socket.close()
  })

  it('a deletion confirmed on the room op that removes the row reaches Basecamp, with the confirming person’s token', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'تبقى' }, { title: 'تُحذف' }] })
    const view = await readSheetView(l)
    const uid = view.uid('تُحذف')
    const row = view.row('تُحذف')
    h.outbound.take()
    detectInto(h)

    const a = await join(l.owner, l)
    a.socket.send({
      type: 'op',
      opId: opId(),
      baseSeq: a.seq,
      epoch: 1,
      mutations: [{ id: 'sheet.mutation.remove-rows', params: { unitId: l.wbId, subUnitId: l.univerSheetId, range: { startRow: row, endRow: row, startColumn: 0, endColumn: 25, rangeType: 1 } } }],
      confirmedDeletions: [uid],
    })
    await a.socket.take('ack')
    await runDurableObjectAlarm(room(l.wbId))

    expect(sent(h).find((m) => m.taskUid === uid)?.actorUserId).toBe(l.owner.id)
    const deletion = await env.DB.prepare(`SELECT state, requested_by FROM task_deletions WHERE task_uid = ?1`).bind(uid).first<{ state: string; requested_by: string }>()
    expect(deletion).toEqual({ state: 'requested', requested_by: l.owner.id })
    await drainOutbound(h)
    const todo = todoByTitle(h, 'تُحذف')
    const trash = h.fake.callsTo('PUT', new RegExp(`^/recordings/${todo.id}/status/trashed\\.json$`))
    expect(trash).toHaveLength(1)
    expect(trash[0]?.token).toBe(l.token)
    expect(todo.status).toBe('trashed')
    expect(todoByTitle(h, 'تبقى').status).toBe('active')
    a.socket.close()
  })

  it('an unconfirmed removal never touches Basecamp: the row is held as missing', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'تبقى' }, { title: 'تختفي' }] })
    const view = await readSheetView(l)
    const uid = view.uid('تختفي')
    const row = view.row('تختفي')
    h.outbound.take()
    detectInto(h)

    const a = await join(l.owner, l)
    a.socket.send({
      type: 'op',
      opId: opId(),
      baseSeq: a.seq,
      epoch: 1,
      mutations: [{ id: 'sheet.mutation.remove-rows', params: { unitId: l.wbId, subUnitId: l.univerSheetId, range: { startRow: row, endRow: row, startColumn: 0, endColumn: 25, rangeType: 1 } } }],
    })
    await a.socket.take('ack')
    await runDurableObjectAlarm(room(l.wbId))

    expect(sent(h).some((m) => m.taskUid === uid)).toBe(false)
    expect(await task(uid)).toMatchObject({ sync_state: 'error', last_error_code: 'row_missing', trashed_at: null })
    await drainOutbound(h)
    expect(h.fake.callsTo('PUT', /\/status\/trashed\.json$/)).toHaveLength(0)
    expect(todoByTitle(h, 'تختفي').status).toBe('active')
    a.socket.close()
  })

  it('a commit with only server edits runs no detection; in a mixed commit the server’s rows are never credited to a person', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أولى' }, { title: 'ثانية' }] })
    const view = await readSheetView(l)
    h.outbound.take()
    const counter = detectInto(h)
    const a = await join(l.owner, l)

    // Server only (e.g. inbound sync while someone has the file open).
    const setDue = (row: number, value: string) => (snapshot: unknown) => {
      const next = structuredClone(snapshot) as { sheets: Record<string, { cellData: Record<number, Record<number, unknown>> }> }
      next.sheets[l.univerSheetId]!.cellData[row]![D] = { v: value, t: 1 }
      return { snapshot: next, result: null }
    }
    const out = await updateLatestSnapshot(env, l.wbId, 'system', setDue(view.row('ثانية'), '2027-01-02'))
    expect(out.status).toBe('written')
    expect(counter.calls).toBe(1)
    expect(sent(h)).toEqual([])
    expect((await task(view.uid('ثانية'))).sync_state).toBe('synced')

    // A person's unsaved edit on one row, then a server change on another, in one commit.
    const serverOp = await a.socket.take('op', (m) => m.op.origin.kind === 'server')
    a.socket.send({ type: 'op', opId: opId(), baseSeq: serverOp.op.seq, epoch: 1, mutations: [setValue(l.wbId, l.univerSheetId, view.row('أولى'), D, { v: '2027-02-01', t: 1 })] })
    await a.socket.take('ack')
    await updateLatestSnapshot(env, l.wbId, 'system', setDue(view.row('ثانية'), '2027-01-03'))
    expect(sent(h).map((m) => [m.taskUid, m.actorUserId])).toEqual([[view.uid('أولى'), l.owner.id]])
    expect(await pendingActor(view.uid('ثانية'))).toBeNull()
    a.socket.close()
  })
})
