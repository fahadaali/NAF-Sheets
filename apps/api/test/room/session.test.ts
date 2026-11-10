// The workbook room over its WebSocket protocol (spec §11, §5.3 default (a)),
// with raw protocol clients connected through the Worker route.

import { env } from 'cloudflare:workers'
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { ROOM_CLOSE } from '@naf-sheets/shared'
import type { RoomOp } from '@naf-sheets/shared'
import { readSnapshot } from '../../src/snapshot'
import { updateLatestSnapshot } from '../../src/sync/workbook-writer'
import { setOutboundDetection } from '../../src/room/outbound-seam'
import type { RoomCommitted } from '../../src/room/outbound-seam'
import type { WorkbookRoom } from '../../src/room'
import { addMember, call, createWorkbook, isArabic, json, seedMember, testApp } from '../helpers'
import { clientId, insertRow, opId, openRoom, setValue } from './ws-client'

const app = testApp()

// The room loads Univer on first use; the first load in a test run is slow.
vi.setConfig({ testTimeout: 30_000 })
beforeAll(async () => {
  await import('../../src/room/engine')
}, 120_000)

type Snap = { sheets: Record<string, { cellData?: Record<string, Record<string, { v?: unknown; f?: string }>> }>; sheetOrder?: string[] }

async function setup() {
  const owner = await seedMember('editor')
  const editor = await seedMember('editor')
  const viewer = await seedMember('viewer')
  const id = await createWorkbook(app, owner)
  await addMember(id, editor.id, 'editor', owner.id)
  await addMember(id, viewer.id, 'viewer', owner.id)
  const res = await call(app, 'GET', `/api/workbooks/${id}`, { user: owner })
  const sheet = (await json<{ sheets: Array<{ univerSheetId: string }> }>(res)).sheets[0]!.univerSheetId
  return { owner, editor, viewer, id, sheet }
}

async function joined(user: { id: string }, workbookId: string, seq: number | null = null, cid = clientId()) {
  const socket = await openRoom(user, workbookId)
  socket.hello(cid, seq)
  const welcome = await socket.take('welcome')
  return { socket, welcome, cid }
}

function cell(snapshot: unknown, sheet: string, row: number, column: number) {
  return (snapshot as Snap).sheets[sheet]?.cellData?.[row]?.[column]
}

async function version(id: string): Promise<number> {
  return (await env.DB.prepare('SELECT current_snapshot_version AS v FROM workbooks WHERE id = ?1').bind(id).first<{ v: number }>())!.v
}

function room(id: string) {
  return env.WORKBOOK_ROOM.get(env.WORKBOOK_ROOM.idFromName(id))
}

/** Runs the room's persistence alarm now. */
async function flush(id: string): Promise<void> {
  await runDurableObjectAlarm(room(id))
}

describe('joining', () => {
  it('welcomes each editor with the snapshot, the seq, its access and who is here', async () => {
    const { owner, viewer, id, sheet } = await setup()
    const a = await joined(owner, id)
    expect(a.welcome).toMatchObject({ mode: 'snapshot', seq: 0, version: 1, readOnly: false, userId: owner.id, epoch: 1 })
    expect(a.welcome.mode === 'snapshot' && cell(a.welcome.snapshot, sheet, 0, 0)?.v).toBe('المهمة')

    const v = await joined(viewer, id)
    expect(v.welcome).toMatchObject({ readOnly: true, userId: viewer.id })
    expect(v.welcome.peers.map((p) => p.userId).sort()).toEqual([owner.id, viewer.id].sort())
    // The first editor learns about the second.
    const presence = await a.socket.take('presence', (m) => m.peers.length === 2)
    expect(presence.peers.find((p) => p.userId === viewer.id)).toMatchObject({ readOnly: true, cell: null })
    a.socket.close()
    v.socket.close()
  })

  it('closes a connection that speaks another protocol version, with an Arabic reason', async () => {
    const { owner, id } = await setup()
    const socket = await openRoom(owner, id)
    socket.send({ type: 'hello', protocol: 99, clientId: clientId(), seq: null })
    const error = await socket.take('error')
    expect(error.code).toBe('protocol_mismatch')
    expect(isArabic(error.message)).toBe(true)
    expect((await socket.waitClosed()).code).toBe(ROOM_CLOSE.protocolMismatch)
  })

  it('closes a connection that sends a malformed frame', async () => {
    const { owner, id } = await setup()
    const socket = await openRoom(owner, id)
    socket.ws.send('not json')
    expect((await socket.take('error')).code).toBe('bad_message')
    expect((await socket.waitClosed()).code).toBe(ROOM_CLOSE.badMessage)
  })

  it('answers an op sent before hello with not_joined', async () => {
    const { owner, id, sheet } = await setup()
    const socket = await openRoom(owner, id)
    socket.send({ type: 'op', opId: opId(), baseSeq: 0, epoch: 1, mutations: [setValue(id, sheet, 1, 0, { v: 'x' })] })
    expect((await socket.take('error')).code).toBe('not_joined')
    socket.close()
  })
})

describe('ops', () => {
  it('acks the sender, broadcasts to the others, and both converge on the room state', async () => {
    const { owner, editor, id, sheet } = await setup()
    const a = await joined(owner, id)
    const b = await joined(editor, id)
    const op = opId()
    a.socket.send({ type: 'op', opId: op, baseSeq: 0, epoch: 1, mutations: [setValue(id, sheet, 1, 0, { v: 'خطة الإطلاق' })] })
    expect(await a.socket.take('ack')).toEqual({ type: 'ack', opId: op, seq: 1 })
    const broadcast = await b.socket.take('op')
    expect(broadcast.op).toMatchObject({ seq: 1, opId: op, origin: { kind: 'user', userId: owner.id, clientId: a.cid } })
    expect(await a.socket.none('op')).toBe(true)

    // Concurrent edits of different cells from the same base both apply.
    b.socket.send({ type: 'op', opId: opId(), baseSeq: 0, epoch: 1, mutations: [setValue(id, sheet, 2, 0, { v: 'تصميم' })] })
    expect((await b.socket.take('ack')).seq).toBe(2)
    expect((await a.socket.take('op')).op.seq).toBe(2)

    // A third editor sees both.
    const c = await joined(owner, id)
    expect(c.welcome.seq).toBe(2)
    expect(c.welcome.mode === 'snapshot' && [cell(c.welcome.snapshot, sheet, 1, 0)?.v, cell(c.welcome.snapshot, sheet, 2, 0)?.v]).toEqual(['خطة الإطلاق', 'تصميم'])
    for (const s of [a, b, c]) s.socket.close()
  })

  it('applies a resent op once (same op id) and acks it with its first seq', async () => {
    const { owner, id, sheet } = await setup()
    const a = await joined(owner, id)
    const op = { type: 'op' as const, opId: opId(), baseSeq: 0, epoch: 1, mutations: [setValue(id, sheet, 1, 0, { v: 'مرة' })] }
    a.socket.send(op)
    a.socket.send(op)
    expect((await a.socket.take('ack')).seq).toBe(1)
    expect((await a.socket.take('ack')).seq).toBe(1)
    a.socket.close()
  })

  it('rejects a stale op on the same cell, resyncs the sender, and drops its ops from the old epoch', async () => {
    const { owner, editor, id, sheet } = await setup()
    const a = await joined(owner, id)
    const b = await joined(editor, id)
    a.socket.send({ type: 'op', opId: opId(), baseSeq: 0, epoch: 1, mutations: [setValue(id, sheet, 1, 0, { v: 'من أ' })] })
    await a.socket.take('ack')

    const late = opId()
    b.socket.send({ type: 'op', opId: late, baseSeq: 0, epoch: 1, mutations: [setValue(id, sheet, 1, 0, { v: 'من ب' })] })
    const reject = await b.socket.take('reject')
    expect(reject).toMatchObject({ opId: late, reason: 'conflict' })
    expect(isArabic(reject.message)).toBe(true)
    const resync = await b.socket.take('resync')
    expect(resync).toMatchObject({ reason: 'rejected', epoch: 2, seq: 1 })
    expect(cell(resync.snapshot, sheet, 1, 0)?.v).toBe('من أ')

    // An op made before the resync arrives late: dropped, no second resync.
    b.socket.send({ type: 'op', opId: opId(), baseSeq: 0, epoch: 1, mutations: [setValue(id, sheet, 5, 5, { v: 'قديم' })] })
    expect((await b.socket.take('reject')).reason).toBe('stale_epoch')
    expect(await b.socket.none('resync')).toBe(true)
    // After the resync B edits normally.
    b.socket.send({ type: 'op', opId: opId(), baseSeq: 1, epoch: 2, mutations: [setValue(id, sheet, 1, 0, { v: 'من ب بعد التحديث' })] })
    expect((await b.socket.take('ack')).seq).toBe(2)
    a.socket.close()
    b.socket.close()
  })

  it('rejects any op concurrent with a structural change, in either order', async () => {
    const { owner, editor, id, sheet } = await setup()
    const a = await joined(owner, id)
    const b = await joined(editor, id)
    // A cell edit lands first; a structural op from the same base is refused.
    a.socket.send({ type: 'op', opId: opId(), baseSeq: 0, epoch: 1, mutations: [setValue(id, sheet, 10, 3, { v: 1 })] })
    await a.socket.take('ack')
    b.socket.send({ type: 'op', opId: opId(), baseSeq: 0, epoch: 1, mutations: [insertRow(id, sheet, 2)] })
    expect((await b.socket.take('reject')).reason).toBe('conflict')
    const resync = await b.socket.take('resync')

    // Structural op first; a cell edit far away from the same base is refused too.
    b.socket.send({ type: 'op', opId: opId(), baseSeq: resync.seq, epoch: resync.epoch, mutations: [insertRow(id, sheet, 2)] })
    expect((await b.socket.take('ack')).seq).toBe(2)
    a.socket.send({ type: 'op', opId: opId(), baseSeq: 1, epoch: 1, mutations: [setValue(id, sheet, 40, 9, { v: 2 })] })
    expect((await a.socket.take('reject')).reason).toBe('conflict')
    a.socket.close()
    b.socket.close()
  })

  it('refuses mutations outside the allow-list, for another unit, or malformed', async () => {
    const { owner, id, sheet } = await setup()
    const a = await joined(owner, id)
    const cases = [
      { id: 'formula.mutation.set-formula-calculation-start', params: { unitId: id, commands: [] } },
      setValue('another-workbook', sheet, 1, 1, { v: 1 }),
      { id: 'sheet.mutation.set-range-values', params: { unitId: id, subUnitId: sheet, cellValue: { x: { 1: { v: 1 } } } } },
    ]
    let epoch = 1
    for (const m of cases) {
      a.socket.send({ type: 'op', opId: opId(), baseSeq: 0, epoch, mutations: [m] })
      expect((await a.socket.take('reject')).reason).toBe('invalid')
      epoch = (await a.socket.take('resync')).epoch
    }
    a.socket.close()
  })

  it('never lets a viewer write or lock, whatever its client sends', async () => {
    const { owner, viewer, id, sheet } = await setup()
    const a = await joined(owner, id)
    const v = await joined(viewer, id)
    v.socket.send({ type: 'op', opId: opId(), baseSeq: 0, epoch: 1, mutations: [setValue(id, sheet, 1, 0, { v: 'قارئ' })] })
    const reject = await v.socket.take('reject')
    expect(reject.reason).toBe('forbidden')
    expect(isArabic(reject.message)).toBe(true)
    await v.socket.take('resync')
    v.socket.send({ type: 'lock', cell: { sheetId: sheet, row: 1, column: 0 } })
    expect(await v.socket.take('lock-denied')).toMatchObject({ heldBy: null })
    expect(await a.socket.none('op')).toBe(true)
    // Nothing was applied.
    const c = await joined(owner, id)
    expect(c.welcome.seq).toBe(0)
    for (const s of [a, v, c]) s.socket.close()
  })
})

describe('presence and soft locks', () => {
  it('shows the selected cell, grants one lock per cell, refuses edits of a locked cell, and releases locks when the holder drops', async () => {
    const { owner, editor, id, sheet } = await setup()
    const a = await joined(owner, id)
    const b = await joined(editor, id)
    const target = { sheetId: sheet, row: 3, column: 1 }

    a.socket.send({ type: 'presence', cell: target })
    const seen = await b.socket.take('presence', (m) => m.peers.some((p) => p.userId === owner.id && p.cell !== null))
    expect(seen.peers.find((p) => p.userId === owner.id)?.cell).toEqual(target)

    a.socket.send({ type: 'lock', cell: target })
    const locks = await b.socket.take('locks', (m) => m.locks.length === 1)
    expect(locks.locks[0]).toMatchObject({ userId: owner.id, connectionId: a.welcome.connectionId, cell: target })

    b.socket.send({ type: 'lock', cell: target })
    const denied = await b.socket.take('lock-denied')
    expect(denied.heldBy).toEqual({ connectionId: a.welcome.connectionId, userId: owner.id })
    expect(isArabic(denied.message)).toBe(true)

    b.socket.send({ type: 'op', opId: opId(), baseSeq: 0, epoch: 1, mutations: [setValue(id, sheet, 3, 1, { v: 'ب' })] })
    expect((await b.socket.take('reject')).reason).toBe('locked')
    const resync = await b.socket.take('resync')

    // The holder commits its own edit, then the connection drops: the lock goes with it.
    a.socket.send({ type: 'op', opId: opId(), baseSeq: 0, epoch: 1, mutations: [setValue(id, sheet, 3, 1, { v: 'أ' })] })
    await a.socket.take('ack')
    a.socket.close()
    await b.socket.take('locks', (m) => m.locks.length === 0)
    await b.socket.take('presence', (m) => m.peers.length === 1)
    b.socket.send({ type: 'lock', cell: target })
    expect((await b.socket.take('locks', (m) => m.locks.length === 1)).locks[0]?.userId).toBe(editor.id)
    expect(resync.epoch).toBe(2)
    b.socket.close()
  })

  it('releases a lock on unlock', async () => {
    const { owner, editor, id, sheet } = await setup()
    const a = await joined(owner, id)
    const b = await joined(editor, id)
    a.socket.send({ type: 'lock', cell: { sheetId: sheet, row: 1, column: 1 } })
    await b.socket.take('locks', (m) => m.locks.length === 1)
    a.socket.send({ type: 'unlock' })
    await b.socket.take('locks', (m) => m.locks.length === 0)
    a.socket.close()
    b.socket.close()
  })
})

describe('reconnect', () => {
  it('catches a reconnecting client up with the ops it missed, its own included', async () => {
    const { owner, editor, id, sheet } = await setup()
    const a = await joined(owner, id)
    const b = await joined(editor, id)
    a.socket.send({ type: 'op', opId: opId(), baseSeq: 0, epoch: 1, mutations: [setValue(id, sheet, 1, 0, { v: 'واحد' })] })
    await b.socket.take('op')
    const bOp = opId()
    b.socket.send({ type: 'op', opId: bOp, baseSeq: 1, epoch: 1, mutations: [setValue(id, sheet, 2, 0, { v: 'اثنان' })] })
    // B drops before reading its ack.
    b.socket.close()
    a.socket.send({ type: 'op', opId: opId(), baseSeq: 2, epoch: 1, mutations: [setValue(id, sheet, 3, 0, { v: 'ثلاثة' })] })
    await a.socket.take('ack', (m) => m.seq === 3)

    const again = await joined(editor, id, 1, b.cid)
    expect(again.welcome.mode).toBe('catchup')
    const ops = again.welcome.mode === 'catchup' ? again.welcome.ops : []
    expect(ops.map((o: RoomOp) => o.seq)).toEqual([2, 3])
    // Its own op is recognisable, so the client treats it as acknowledged.
    expect(ops[0]).toMatchObject({ opId: bOp, origin: { kind: 'user', clientId: b.cid } })
    a.socket.close()
    again.socket.close()
  })

  it('sends the snapshot when the client is too far behind or ahead', async () => {
    const { owner, id } = await setup()
    const a = await joined(owner, id, 50)
    expect(a.welcome.mode).toBe('snapshot')
    a.socket.close()
  })
})

describe('persistence', () => {
  it('commits through the browser save path after the debounce (R2 version N+1, then D1), and says so', async () => {
    const { owner, id, sheet } = await setup()
    const a = await joined(owner, id)
    a.socket.send({ type: 'op', opId: opId(), baseSeq: 0, epoch: 1, mutations: [setValue(id, sheet, 1, 0, { v: 'محفوظ' })] })
    await a.socket.take('ack')
    expect(await version(id)).toBe(1)
    await flush(id)
    expect(await a.socket.take('saved')).toEqual({ type: 'saved', version: 2, seq: 1 })
    expect(await version(id)).toBe(2)
    expect(cell(await readSnapshot(env, id, 2), sheet, 1, 0)?.v).toBe('محفوظ')
    const object = await env.SNAPSHOTS.head(`workbooks/${id}/snapshots/2.json`)
    expect(object?.customMetadata).toMatchObject({ workbookId: id, version: '2', savedBy: owner.id })
    // The browser reads the room's commit like any version.
    const res = await call(app, 'GET', `/api/workbooks/${id}`, { user: owner })
    expect(await json<{ version: number }>(res)).toMatchObject({ version: 2 })
    a.socket.close()
  })

  it('commits when the last editor leaves', async () => {
    const { owner, editor, id, sheet } = await setup()
    const a = await joined(owner, id)
    const b = await joined(editor, id)
    a.socket.send({ type: 'op', opId: opId(), baseSeq: 0, epoch: 1, mutations: [setValue(id, sheet, 4, 2, { v: 'عند الخروج' })] })
    await a.socket.take('ack')
    a.socket.close()
    await b.socket.take('presence', (m) => m.peers.length === 1)
    expect(await version(id)).toBe(1)
    b.socket.close()
    const deadline = Date.now() + 5_000
    while ((await version(id)) === 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    expect(await version(id)).toBe(2)
    expect(cell(await readSnapshot(env, id, 2), sheet, 4, 2)?.v).toBe('عند الخروج')
  })

  it('survives a room restart: unsaved ops are replayed from the room log and committed', async () => {
    const { owner, id, sheet } = await setup()
    const a = await joined(owner, id)
    a.socket.send({ type: 'op', opId: opId(), baseSeq: 0, epoch: 1, mutations: [setValue(id, sheet, 6, 0, { v: 'قبل إعادة التشغيل' })] })
    await a.socket.take('ack')
    // The room loses its memory (eviction, hibernation, deploy) while the op is not committed.
    await runInDurableObject(room(id), (instance: WorkbookRoom) => {
      const r = instance as unknown as { live: { engine: { dispose(): void } } | null }
      r.live?.engine.dispose()
      r.live = null
    })
    expect(await version(id)).toBe(1)
    const b = await joined(owner, id, 0)
    expect(b.welcome.seq).toBe(1)
    expect(b.welcome.mode).toBe('catchup')
    const c = await joined(owner, id)
    expect(c.welcome.mode === 'snapshot' && cell(c.welcome.snapshot, sheet, 6, 0)?.v).toBe('قبل إعادة التشغيل')
    await flush(id)
    expect(await version(id)).toBe(2)
    expect(cell(await readSnapshot(env, id, 2), sheet, 6, 0)?.v).toBe('قبل إعادة التشغيل')
    for (const s of [a, b, c]) s.socket.close()
  })

  it('survives a real restart of the Durable Object (abort): editors reconnect and catch up, nothing is lost', async () => {
    const { owner, id, sheet } = await setup()
    const a = await joined(owner, id)
    a.socket.send({ type: 'op', opId: opId(), baseSeq: 0, epoch: 1, mutations: [setValue(id, sheet, 7, 1, { v: 'قبل الإيقاف' })] })
    await a.socket.take('ack')
    await runInDurableObject(room(id), (_instance: WorkbookRoom, state) => {
      try {
        state.abort('test restart')
      } catch {
        // abort() throws in the caller by design.
      }
    }).catch(() => undefined)
    await a.socket.waitClosed(10_000)
    expect(await version(id)).toBe(1)

    const again = await joined(owner, id, 1, a.cid)
    expect(again.welcome).toMatchObject({ mode: 'catchup', seq: 1 })
    const fresh = await joined(owner, id)
    expect(fresh.welcome.mode === 'snapshot' && cell(fresh.welcome.snapshot, sheet, 7, 1)?.v).toBe('قبل الإيقاف')
    await flush(id)
    expect(await version(id)).toBe(2)
    again.socket.close()
    fresh.socket.close()
  })

  it('a stale browser save never overwrites the room: it is refused after a commit, superseded before one', async () => {
    const { owner, id, sheet } = await setup()
    const loaded = await readSnapshot(env, id, 1)
    const a = await joined(owner, id)
    a.socket.send({ type: 'op', opId: opId(), baseSeq: 0, epoch: 1, mutations: [setValue(id, sheet, 1, 0, { v: 'من الغرفة' })] })
    await a.socket.take('ack')

    // Before the room commits, a tab that is not in the room saves version 2.
    const put = await call(app, 'PUT', `/api/workbooks/${id}/snapshot`, { user: owner, body: { baseVersion: 1, snapshot: loaded } })
    expect(put.status).toBe(200)
    await flush(id)
    // The room committed on top (3); the browser's version 2 stays in R2 untouched.
    expect(await version(id)).toBe(3)
    expect(cell(await readSnapshot(env, id, 3), sheet, 1, 0)?.v).toBe('من الغرفة')
    expect(cell(await readSnapshot(env, id, 2), sheet, 1, 0)).toBeUndefined()
    const events = await runInDurableObject(room(id), (instance: WorkbookRoom) =>
      (instance as unknown as { store: { events(): Array<{ kind: string }> } }).store.events().map((e) => e.kind),
    )
    expect(events).toContain('superseded')

    // After a commit, the same stale tab is refused (409) as before phase 6.
    const again = await call(app, 'PUT', `/api/workbooks/${id}/snapshot`, { user: owner, body: { baseVersion: 2, snapshot: loaded } })
    expect(again.status).toBe(409)
    a.socket.close()
  })

  it('when the workbook is archived mid-session: editors are told and disconnected, the room stops retrying, the ops stay logged', async () => {
    const { owner, id, sheet } = await setup()
    const a = await joined(owner, id)
    a.socket.send({ type: 'op', opId: opId(), baseSeq: 0, epoch: 1, mutations: [setValue(id, sheet, 1, 0, { v: 'قبل الأرشفة' })] })
    await a.socket.take('ack')
    await env.DB.prepare('UPDATE workbooks SET archived_at = ?1 WHERE id = ?2').bind(new Date().toISOString(), id).run()
    await flush(id)
    const error = await a.socket.take('error')
    expect(error.code).toBe('unavailable')
    expect(isArabic(error.message)).toBe(true)
    expect((await a.socket.waitClosed()).code).toBe(ROOM_CLOSE.unavailable)
    // No retry is scheduled; the op is still in the room's log.
    expect(await runDurableObjectAlarm(room(id))).toBe(false)
    const logged = await runInDurableObject(room(id), (instance: WorkbookRoom) => {
      const store = (instance as unknown as { store: { range(a: number, b: number): unknown[]; events(): Array<{ kind: string }> } }).store
      return { ops: store.range(0, 10).length, events: store.events().map((e) => e.kind) }
    })
    expect(logged).toEqual({ ops: 1, events: ['commit_gone'] })
  })

  it('calls the outbound seam after a commit with the edits it included and who made them', async () => {
    const { owner, editor, id, sheet } = await setup()
    const seen: RoomCommitted[] = []
    setOutboundDetection(async (_env, event) => {
      if (event.workbookId === id) seen.push(event)
    })
    try {
      const a = await joined(owner, id)
      const b = await joined(editor, id)
      a.socket.send({ type: 'op', opId: opId(), baseSeq: 0, epoch: 1, mutations: [setValue(id, sheet, 1, 1, { v: 'أ' })] })
      await a.socket.take('ack')
      b.socket.send({ type: 'op', opId: opId(), baseSeq: 1, epoch: 1, mutations: [setValue(id, sheet, 2, 1, { v: 'ب' })] })
      await b.socket.take('ack')
      await flush(id)
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ version: 2, previousVersion: 1 })
      expect(seen[0]!.edits.map((e) => [e.seq, e.userId, e.origin])).toEqual([
        [1, owner.id, 'user'],
        [2, editor.id, 'user'],
      ])
      expect(seen[0]!.edits[1]!.footprint.cells).toEqual([{ sheet, r0: 2, r1: 2, c0: 1, c1: 1 }])
      a.socket.close()
      b.socket.close()
    } finally {
      setOutboundDetection(null)
    }
  })
})

describe('server changes while a session is live (updateLatestSnapshot)', () => {
  it('runs on the live state, commits, and broadcasts a cell change as an op', async () => {
    const { owner, editor, id, sheet } = await setup()
    const a = await joined(owner, id)
    const b = await joined(editor, id)
    a.socket.send({ type: 'op', opId: opId(), baseSeq: 0, epoch: 1, mutations: [setValue(id, sheet, 1, 0, { v: 'مهمة' })] })
    await a.socket.take('ack')
    await b.socket.take('op')

    const out = await updateLatestSnapshot(env, id, 'system', (snapshot, base) => {
      // The change sees the editor's unsaved op.
      expect(cell(snapshot, sheet, 1, 0)?.v).toBe('مهمة')
      const next = structuredClone(snapshot) as Snap
      next.sheets[sheet]!.cellData![1]![3] = { v: '2026-11-30' }
      return { snapshot: next, result: base }
    })
    expect(out).toEqual({ status: 'written', version: 2, result: 1 })
    expect(cell(await readSnapshot(env, id, 2), sheet, 1, 3)?.v).toBe('2026-11-30')
    for (const s of [a, b]) {
      const { op } = await s.socket.take('op', (m) => m.op.origin.kind === 'server')
      expect(op).toMatchObject({ seq: 2, origin: { kind: 'server', savedBy: 'system' } })
      expect(JSON.stringify(op.mutations)).toContain('2026-11-30')
      expect((await s.socket.take('saved')).version).toBe(2)
    }
    // A stale editor op on that cell is now refused.
    a.socket.send({ type: 'op', opId: opId(), baseSeq: 1, epoch: 1, mutations: [setValue(id, sheet, 1, 3, { v: 'قديم' })] })
    expect((await a.socket.take('reject')).reason).toBe('conflict')
    a.socket.close()
    b.socket.close()
  })

  it('reloads every editor when the change is structural (a new sheet)', async () => {
    const { owner, id } = await setup()
    const a = await joined(owner, id)
    const out = await updateLatestSnapshot(env, id, owner.id, (snapshot) => {
      const next = structuredClone(snapshot) as Snap & { sheetOrder: string[] }
      next.sheets['sheet-new'] = { cellData: { 0: { 0: { v: 'غير مصنّف' } } } }
      ;(next.sheets['sheet-new'] as Record<string, unknown>).id = 'sheet-new'
      ;(next.sheets['sheet-new'] as Record<string, unknown>).name = 'غير مصنّف'
      next.sheetOrder = [...next.sheetOrder, 'sheet-new']
      return { snapshot: next, result: 'ok' }
    })
    expect(out).toEqual({ status: 'written', version: 2, result: 'ok' })
    const resync = await a.socket.take('resync')
    expect(resync).toMatchObject({ reason: 'server_change', epoch: 2, version: 2 })
    expect(cell(resync.snapshot, 'sheet-new', 0, 0)?.v).toBe('غير مصنّف')
    a.socket.close()
  })

  it('passes the change’s own error to the caller and writes nothing', async () => {
    const { owner, id } = await setup()
    const a = await joined(owner, id)
    class SyncError extends Error {
      readonly code = 'X'
    }
    await expect(
      updateLatestSnapshot(env, id, owner.id, () => {
        throw new SyncError('من التغيير')
      }),
    ).rejects.toBeInstanceOf(SyncError)
    expect(await version(id)).toBe(1)
    a.socket.close()
  })
})

describe('framing', () => {
  it('sends a large snapshot in chunks that the client reassembles', async () => {
    const { owner, id, sheet } = await setup()
    // ~1 MB of cell text through a server change, so the welcome needs several frames.
    await updateLatestSnapshot(env, id, owner.id, (snapshot) => {
      const next = structuredClone(snapshot) as Snap
      const data = next.sheets[sheet]!.cellData!
      for (let r = 1; r <= 400; r++) data[r] = { 0: { v: 'نص طويل '.repeat(150) } }
      // ~480,000 characters: two frames at 256 Ki characters each.
      return { snapshot: next, result: null }
    })
    const socket = await openRoom(owner, id)
    socket.hello(clientId())
    const welcome = await socket.take('welcome')
    expect(socket.frames).toBeGreaterThan(1)
    expect(welcome.mode === 'snapshot' && String(cell(welcome.snapshot, sheet, 400, 0)?.v).length).toBeGreaterThan(1000)
    socket.close()
  })
})

