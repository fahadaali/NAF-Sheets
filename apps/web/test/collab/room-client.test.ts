// The room client against a scripted room (fake socket), the Univer adapter
// against a fake command service, and the presence helpers. The end-to-end
// tests with the real room and real Univer are in apps/api/test/room.

import { afterEach, describe, expect, it } from 'vitest'
import { ROOM_CLOSE, toFrames } from '@naf-sheets/shared'
import type { RoomClientMessage, RoomMutation, RoomServerMessage } from '@naf-sheets/shared'
import { RoomClient } from '../../src/lib/room-client'
import type { RoomClientState, RoomEditorAdapter, RoomSocketLike } from '../../src/lib/room-client'
import { createUniverRoomAdapter } from '../../src/collab/univer-adapter'
import type { CollabCommandService } from '../../src/collab/univer-adapter'
import { PRESENCE_COLOURS, cellMarks, initials, presenceColour } from '../../src/collab/presence'
import { CollabSession } from '../../src/collab/session'

class FakeSocket implements RoomSocketLike {
  sent: RoomClientMessage[] = []
  closed: { code?: number } | null = null
  private message: Array<(e: { data: unknown }) => void> = []
  private close_: Array<(e: { code: number; reason: string }) => void> = []
  send(data: string): void {
    this.sent.push(JSON.parse(data) as RoomClientMessage)
  }
  close(code?: number): void {
    this.closed = { code }
  }
  addEventListener(type: 'message' | 'close', listener: (e: never) => void): void {
    if (type === 'message') this.message.push(listener as never)
    else this.close_.push(listener as never)
  }
  /** The room sends `msg` (chunked when `chunk` is given). */
  deliver(msg: RoomServerMessage, chunk?: number): void {
    for (const f of toFrames(JSON.stringify(msg), 'x', chunk)) for (const l of this.message) l({ data: f })
  }
  drop(code = 1006): void {
    for (const l of this.close_) l({ code, reason: '' })
  }
  ofType<K extends RoomClientMessage['type']>(type: K) {
    return this.sent.filter((m) => m.type === type) as Array<Extract<RoomClientMessage, { type: K }>>
  }
}

class FakeEditor implements RoomEditorAdapter {
  editable = false
  loads: Array<Record<string, unknown>> = []
  applied: Array<{ mutations: RoomMutation[]; structural: boolean }> = []
  private listener: ((m: RoomMutation[]) => void) | null = null
  onLocalOp(listener: (m: RoomMutation[]) => void) {
    this.listener = listener
    return () => {
      this.listener = null
    }
  }
  applyRemote(mutations: RoomMutation[], structural: boolean) {
    this.applied.push({ mutations, structural })
  }
  async load(snapshot: Record<string, unknown>) {
    this.loads.push(snapshot)
  }
  setEditable(editable: boolean) {
    this.editable = editable
  }
  edit(row: number) {
    this.listener?.([{ id: 'sheet.mutation.set-range-values', params: { unitId: 'wb', subUnitId: 's', cellValue: { [row]: { 0: { v: row } } } } }])
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const wait = async (ok: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const welcome = (over: Partial<Record<string, unknown>> = {}): RoomServerMessage =>
  ({ type: 'welcome', protocol: 1, connectionId: 'me', userId: 'u1', readOnly: false, epoch: 1, seq: 4, version: 2, peers: [], locks: [], mode: 'snapshot', snapshot: { id: 'wb' }, ...over }) as RoomServerMessage

const clients: RoomClient[] = []
const sessions: CollabSession[] = []
afterEach(() => {
  for (const c of clients.splice(0)) c.stop()
  for (const s of sessions.splice(0)) s.stop()
})

function setup(options: { delays?: number[] } = {}) {
  const sockets: FakeSocket[] = []
  const editor = new FakeEditor()
  const states: RoomClientState[] = []
  const notices: Array<{ message: string; kind: string }> = []
  const client = new RoomClient({
    adapter: editor,
    clientId: 'client-test-1',
    connect: async () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    reconnectDelaysMs: options.delays ?? [5],
    onState: (s) => states.push(s),
    onNotice: (message, kind) => notices.push({ message, kind }),
  })
  clients.push(client)
  client.start()
  const socket = () => sockets[sockets.length - 1]!
  return { client, editor, sockets, socket, states, notices }
}

describe('RoomClient', () => {
  it('says hello, loads the welcome snapshot and goes live and editable', async () => {
    const { client, editor, socket } = setup()
    await wait(() => socket()?.sent.length > 0)
    expect(socket().sent[0]).toEqual({ type: 'hello', protocol: 1, clientId: 'client-test-1', seq: null })
    expect(editor.editable).toBe(false)
    socket().deliver(welcome())
    await wait(() => client.state().status === 'live')
    expect(editor.loads).toEqual([{ id: 'wb' }])
    expect(editor.editable).toBe(true)
    expect(client.state()).toMatchObject({ seq: 4, version: 2, connectionId: 'me' })
  })

  it('sends local edits on the seq they were made on, and an ack clears them', async () => {
    const { client, editor, socket } = setup()
    await wait(() => socket()?.sent.length > 0)
    socket().deliver(welcome())
    await wait(() => client.state().status === 'live')
    editor.edit(1)
    editor.edit(2)
    const ops = socket().ofType('op')
    expect(ops.map((o) => [o.baseSeq, o.epoch])).toEqual([
      [4, 1],
      [4, 1],
    ])
    expect(client.state().pending).toBe(2)
    socket().deliver({ type: 'ack', opId: ops[0]!.opId, seq: 5 })
    socket().deliver({ type: 'ack', opId: ops[1]!.opId, seq: 6 })
    await wait(() => client.state().pending === 0)
    expect(client.state().seq).toBe(6)
    editor.edit(3)
    expect(socket().ofType('op')[2]!.baseSeq).toBe(6)
  })

  it('applies others’ ops (flagging structural ones) and keeps their seq', async () => {
    const { client, editor, socket } = setup()
    await wait(() => socket()?.sent.length > 0)
    socket().deliver(welcome())
    await wait(() => client.state().status === 'live')
    const insert = { id: 'sheet.mutation.insert-row', params: { unitId: 'wb' } }
    socket().deliver({ type: 'op', op: { seq: 5, origin: { kind: 'user', userId: 'u2', clientId: 'other' }, opId: 'x', mutations: [insert] } })
    await wait(() => editor.applied.length === 1)
    expect(editor.applied[0]).toEqual({ mutations: [insert], structural: true })
    expect(client.state().seq).toBe(5)
  })

  it('on a reject: read-only, drops pending ops, then loads the resync and goes live with the new epoch', async () => {
    const { client, editor, socket, notices } = setup()
    await wait(() => socket()?.sent.length > 0)
    socket().deliver(welcome())
    await wait(() => client.state().status === 'live')
    editor.edit(1)
    const op = socket().ofType('op')[0]!
    socket().deliver({ type: 'reject', opId: op.opId, reason: 'conflict', message: 'رسالة' })
    await wait(() => client.state().status === 'resyncing')
    expect(editor.editable).toBe(false)
    expect(notices).toEqual([{ message: 'رسالة', kind: 'rejected' }])
    // Broadcasts before the resync are ignored: the resync includes them.
    socket().deliver({ type: 'op', op: { seq: 6, origin: { kind: 'server', savedBy: 's' }, opId: null, mutations: [] } })
    socket().deliver({ type: 'resync', epoch: 2, seq: 7, version: 3, snapshot: { id: 'wb', v: 2 }, reason: 'rejected' })
    await wait(() => client.state().status === 'live')
    expect(editor.applied).toEqual([])
    expect(editor.loads.at(-1)).toEqual({ id: 'wb', v: 2 })
    expect(client.state()).toMatchObject({ pending: 0, seq: 7, version: 3 })
    editor.edit(2)
    expect(socket().ofType('op').at(-1)).toMatchObject({ baseSeq: 7, epoch: 2 })
  })

  it('goes read-only when the connection drops, reconnects, catches up and resends what did not arrive', async () => {
    const { client, editor, sockets, socket } = setup()
    await wait(() => socket()?.sent.length > 0)
    socket().deliver(welcome())
    await wait(() => client.state().status === 'live')
    editor.edit(1)
    editor.edit(2)
    const [first, second] = socket().ofType('op')
    socket().drop()
    expect(client.state().status).toBe('offline')
    expect(editor.editable).toBe(false)
    // Edits while offline are not sent (the grid is read-only; this one slipped through).
    editor.edit(3)
    await wait(() => sockets.length === 2 && sockets[1]!.sent.length > 0)
    expect(socket().sent[0]).toMatchObject({ type: 'hello', seq: 4 })
    // The room had applied the first op (its ack was lost) and another editor's.
    socket().deliver(
      welcome({
        mode: 'catchup',
        snapshot: undefined,
        seq: 6,
        ops: [
          { seq: 5, origin: { kind: 'user', userId: 'u1', clientId: 'client-test-1' }, opId: first!.opId, mutations: first!.mutations },
          { seq: 6, origin: { kind: 'user', userId: 'u2', clientId: 'other' }, opId: 'o', mutations: [] },
        ],
      }),
    )
    await wait(() => client.state().status === 'live')
    expect(editor.loads).toHaveLength(1)
    expect(editor.applied).toHaveLength(1)
    // Only the op that never arrived is sent again, on its original base.
    expect(socket().ofType('op')).toEqual([{ type: 'op', opId: second!.opId, baseSeq: 4, epoch: 1, mutations: second!.mutations }])
    expect(client.state()).toMatchObject({ seq: 6, pending: 1 })
  })

  it('stops for good on a fatal close or error, with an Arabic notice', async () => {
    const { client, socket, sockets, notices } = setup()
    await wait(() => socket()?.sent.length > 0)
    socket().drop(ROOM_CLOSE.protocolMismatch)
    expect(client.state().status).toBe('failed')
    await tick()
    await new Promise((r) => setTimeout(r, 30))
    expect(sockets).toHaveLength(1)
    expect(notices[0]?.kind).toBe('failed')
    expect(/[؀-ۿ]/.test(notices[0]!.message)).toBe(true)
  })

  it('reassembles chunked messages', async () => {
    const { client, editor, socket } = setup()
    await wait(() => socket()?.sent.length > 0)
    socket().deliver(welcome({ snapshot: { id: 'wb', big: 'خ'.repeat(5000) } }), 1000)
    await wait(() => client.state().status === 'live')
    expect(String(editor.loads[0]!.big)).toHaveLength(5000)
  })

  it('keeps a viewer read-only and asks for a resync instead of sending a stray edit', async () => {
    const { client, editor, socket } = setup()
    await wait(() => socket()?.sent.length > 0)
    socket().deliver(welcome({ readOnly: true }))
    await wait(() => client.state().status === 'live')
    expect(editor.editable).toBe(false)
    editor.edit(1)
    expect(socket().ofType('op')).toEqual([])
    expect(socket().ofType('resync')).toHaveLength(1)
  })

  it('throttles presence, sends lock and unlock, and reports others’ locks', async () => {
    const { client, socket } = setup()
    await wait(() => socket()?.sent.length > 0)
    const cell = { sheetId: 's', row: 1, column: 2 }
    socket().deliver(welcome({ locks: [{ connectionId: 'other', userId: 'u2', cell }] }))
    await wait(() => client.state().status === 'live')
    expect(client.isLockedByOthers(cell)).toBe(true)
    client.setSelection({ sheetId: 's', row: 0, column: 0 })
    client.setSelection(cell)
    await new Promise((r) => setTimeout(r, 150))
    expect(socket().ofType('presence')).toEqual([{ type: 'presence', cell }])
    client.lockCell({ sheetId: 's', row: 9, column: 9 })
    client.unlockCell()
    expect(socket().sent.slice(-2).map((m) => m.type)).toEqual(['lock', 'unlock'])
    socket().deliver({ type: 'locks', locks: [] })
    await wait(() => !client.isLockedByOthers(cell))
  })
})

describe('RoomClient: first join and confirmed deletions', () => {
  it('sends the version it shows on the first join only', async () => {
    const sockets: FakeSocket[] = []
    const editor = new FakeEditor()
    const client = new RoomClient({
      adapter: editor,
      clientId: 'client-test-2',
      initialVersion: 7,
      reconnectDelaysMs: [5],
      connect: async () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
    })
    clients.push(client)
    client.start()
    await wait(() => sockets[0]?.sent.length === 1)
    expect(sockets[0]!.sent[0]).toEqual({ type: 'hello', protocol: 1, clientId: 'client-test-2', seq: null, version: 7 })
    sockets[0]!.deliver(welcome({ mode: 'catchup', snapshot: undefined, ops: [] }))
    await wait(() => client.state().status === 'live')
    // An empty catch-up: nothing reloaded.
    expect(editor.loads).toEqual([])
    sockets[0]!.drop()
    await wait(() => sockets.length === 2 && sockets[1]!.sent.length === 1)
    expect(sockets[1]!.sent[0]).toEqual({ type: 'hello', protocol: 1, clientId: 'client-test-2', seq: 4 })
  })

  it('confirmed deletions travel on the next op only, and are dropped with a rejected op', async () => {
    const { client, editor, socket } = setup()
    await wait(() => socket()?.sent.length > 0)
    socket().deliver(welcome())
    await wait(() => client.state().status === 'live')
    client.confirmDeletions(['u-7', 'u-8'])
    editor.edit(7)
    editor.edit(8)
    const [first, second] = socket().ofType('op')
    expect(first?.confirmedDeletions).toEqual(['u-7', 'u-8'])
    expect(second?.confirmedDeletions).toBeUndefined()
    client.confirmDeletions(['u-9'])
    socket().deliver({ type: 'reject', opId: second!.opId, reason: 'conflict', message: 'x' })
    socket().deliver({ type: 'resync', epoch: 2, seq: 9, version: 3, snapshot: { id: 'wb' }, reason: 'rejected' })
    await wait(() => client.state().status === 'live')
    editor.edit(9)
    expect(socket().ofType('op').at(-1)?.confirmedDeletions).toBeUndefined()
  })
})

describe('CollabSession', () => {
  function session(connect: () => Promise<RoomSocketLike>, joinTimeoutMs = 2_000) {
    const reloads: Array<Record<string, unknown>> = []
    const s = new CollabSession({ workbookId: 'wb', version: 4, connect, reload: (snapshot) => reloads.push(snapshot), joinTimeoutMs })
    sessions.push(s)
    return { s, reloads }
  }

  it('falls back (unavailable, editable, not shared) when the first connection fails', async () => {
    const { s } = session(async () => {
      throw new Error('no room')
    })
    s.start()
    await wait(() => s.view().mode === 'unavailable')
    expect(s.allowsEdits()).toBe(true)
    expect(s.shared).toBe(false)
  })

  it('falls back when no welcome comes in time', async () => {
    const { s } = session(async () => new FakeSocket(), 30)
    s.start()
    await wait(() => s.view().mode === 'unavailable')
  })

  it('once live, a drop means offline and read-only, never the fallback; a snapshot welcome remounts through attach', async () => {
    const sockets: FakeSocket[] = []
    const { s, reloads } = session(async () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    })
    s.start()
    await wait(() => sockets[0]?.sent.length === 1)
    sockets[0]!.deliver(welcome({ snapshot: { id: 'wb', v: 2 } }))
    await wait(() => reloads.length === 1)
    expect(s.view().mode).toBe('resyncing')
    // The new editor instance is ready.
    const u = { listeners: 0 }
    s.attach({ collab: { commands: { onMutationExecutedForCollab: () => ((u.listeners += 1), { dispose: () => undefined }), syncExecuteCommand: () => true }, clearUndo: () => undefined } })
    await wait(() => s.view().mode === 'live')
    expect(s.allowsEdits()).toBe(true)
    expect(u.listeners).toBeGreaterThan(0)
    sockets[0]!.drop()
    await wait(() => s.view().mode === 'offline')
    expect(s.allowsEdits()).toBe(false)
    expect(s.shared).toBe(true)
  })

  it('a viewer is live but never editable', async () => {
    const sockets: FakeSocket[] = []
    const { s } = session(async () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    })
    s.start()
    await wait(() => sockets[0]?.sent.length === 1)
    sockets[0]!.deliver(welcome({ readOnly: true, mode: 'catchup', snapshot: undefined, ops: [] }))
    await wait(() => s.view().mode === 'live')
    expect(s.allowsEdits()).toBe(false)
  })
})

describe('Univer adapter', () => {
  function fakeUniver() {
    const listeners: Array<Parameters<CollabCommandService['onMutationExecutedForCollab']>[0]> = []
    const executed: Array<{ id: string; options: unknown }> = []
    const service: CollabCommandService = {
      onMutationExecutedForCollab(l) {
        listeners.push(l)
        return { dispose: () => listeners.splice(listeners.indexOf(l), 1) }
      },
      syncExecuteCommand(id, params, options) {
        executed.push({ id, options })
        // Univer reports the remote mutation to collab listeners too.
        for (const l of listeners) l({ id, type: 2, params }, options)
        return true
      },
    }
    const emit = (id: string, params: Record<string, unknown>, options?: Record<string, boolean>) => {
      for (const l of [...listeners]) l({ id, type: 2, params }, options)
    }
    return { service, emit, executed, listeners }
  }

  it('groups one task’s mutations into one op and keeps only this user’s changes to this workbook', async () => {
    const u = fakeUniver()
    const adapter = createUniverRoomAdapter({ unitId: 'wb', commands: () => u.service, load: () => undefined, setEditable: () => undefined })
    const ops: RoomMutation[][] = []
    adapter.onLocalOp((m) => ops.push(m))
    u.emit('sheet.mutation.insert-row', { unitId: 'wb' })
    u.emit('sheet.mutation.set-range-values', { unitId: 'wb' })
    u.emit('formula.mutation.set-formula-calculation-result', { unitId: 'wb' }, { onlyLocal: true })
    u.emit('sheet.mutation.set-range-values', { unitId: 'wb' }, { fromCollab: true })
    u.emit('doc.mutation.rich-text-editing', { unitId: '__INTERNAL_EDITOR__DOCS_NORMAL' })
    u.emit('sheet.mutation.copy-worksheet-end', { unitId: 'wb' }, { syncOnly: true })
    await tick()
    expect(ops.map((m) => m.map((x) => x.id))).toEqual([['sheet.mutation.insert-row', 'sheet.mutation.set-range-values', 'sheet.mutation.copy-worksheet-end']])
  })

  it('applies remote ops as a collaborator’s, never echoes them, and clears undo after a structural one', async () => {
    const u = fakeUniver()
    let cleared = 0
    const adapter = createUniverRoomAdapter({ unitId: 'wb', commands: () => u.service, load: () => undefined, setEditable: () => undefined, clearUndo: () => cleared++ })
    const ops: RoomMutation[][] = []
    adapter.onLocalOp((m) => ops.push(m))
    adapter.applyRemote([{ id: 'sheet.mutation.set-range-values', params: { unitId: 'wb' } }], false)
    adapter.applyRemote([{ id: 'sheet.mutation.insert-row', params: { unitId: 'wb' } }], true)
    await tick()
    expect(u.executed.map((e) => e.options)).toEqual([{ fromCollab: true }, { fromCollab: true }])
    expect(ops).toEqual([])
    expect(cleared).toBe(1)
  })

  it('subscribes to the new Univer after a load, and to none before the first mount', async () => {
    let current: ReturnType<typeof fakeUniver> | null = null
    const adapter = createUniverRoomAdapter({
      unitId: 'wb',
      commands: () => current?.service ?? null,
      load: () => {
        current = fakeUniver()
      },
      setEditable: () => undefined,
    })
    const ops: RoomMutation[][] = []
    adapter.onLocalOp((m) => ops.push(m))
    await adapter.load({ id: 'wb' })
    current!.emit('sheet.mutation.set-range-values', { unitId: 'wb' })
    await tick()
    expect(ops).toHaveLength(1)
    expect(current!.listeners).toHaveLength(1)
  })
})

describe('presence helpers', () => {
  it('gives each connection a stable colour index within the theme’s range', () => {
    const c = presenceColour('conn-1')
    expect(presenceColour('conn-1')).toBe(c)
    expect(c).toBeGreaterThanOrEqual(0)
    expect(c).toBeLessThan(PRESENCE_COLOURS)
  })

  it('makes initials from Arabic names', () => {
    expect(initials('سارة العتيبي')).toBe('سا')
    expect(initials(null)).toBe('؟')
  })

  it('marks other people’s selected and locked cells on the sheet shown', () => {
    const peers = [
      { connectionId: 'a', userId: 'u1', name: 'سارة', readOnly: false, cell: { sheetId: 's1', row: 1, column: 1 } },
      { connectionId: 'b', userId: 'u2', name: 'خالد', readOnly: false, cell: { sheetId: 's2', row: 0, column: 0 } },
    ]
    const locks = [{ connectionId: 'a', userId: 'u1', cell: { sheetId: 's1', row: 2, column: 2 } }]
    expect(cellMarks(peers, locks, 's1')).toEqual([{ cell: { sheetId: 's1', row: 2, column: 2 }, connectionId: 'a', userId: 'u1', name: 'سارة', colour: presenceColour('a'), locked: true }])
    expect(cellMarks(peers, [], 's2').map((m) => m.userId)).toEqual(['u2'])
  })
})
