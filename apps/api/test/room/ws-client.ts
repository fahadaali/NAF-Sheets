// A raw protocol client for room tests: connects through the Worker route
// (so the access check runs), reassembles chunked frames and lets a test wait
// for the next message of a type.

import { FrameAssembler, ROOM_LIMITS, ROOM_PROTOCOL_VERSION } from '@naf-sheets/shared'
import type { RoomChunk, RoomClientMessage, RoomServerMessage } from '@naf-sheets/shared'
import { call, testApp } from '../helpers'

type ServerType = RoomServerMessage['type']
type Of<K extends ServerType> = Extract<RoomServerMessage, { type: K }>

export class TestSocket {
  readonly queue: RoomServerMessage[] = []
  closed: { code: number; reason: string } | null = null
  private wake: Array<() => void> = []
  private readonly assembler = new FrameAssembler(ROOM_LIMITS.maxMessageChars * 4)
  /** Frames received (after chunking), for the chunking test. */
  frames = 0

  constructor(readonly ws: WebSocket) {
    ws.accept()
    ws.addEventListener('message', (event) => {
      this.frames++
      let msg = JSON.parse(String(event.data)) as RoomServerMessage
      if (msg.type === 'chunk') {
        const text = this.assembler.push(msg as RoomChunk)
        if (text === null) return
        msg = JSON.parse(text) as RoomServerMessage
      }
      this.queue.push(msg)
      this.notify()
    })
    ws.addEventListener('close', (event) => {
      this.closed = { code: event.code, reason: event.reason }
      this.notify()
    })
  }

  private notify(): void {
    const wake = this.wake
    this.wake = []
    for (const w of wake) w()
  }

  send(msg: RoomClientMessage | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg))
  }

  hello(clientId: string, seq: number | null = null): void {
    this.send({ type: 'hello', protocol: ROOM_PROTOCOL_VERSION, clientId, seq })
  }

  /** Removes and returns the first queued message of `type` (and matching `when`), waiting for it. */
  async take<K extends ServerType>(type: K, when: (m: Of<K>) => boolean = () => true, timeoutMs = 10_000): Promise<Of<K>> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const i = this.queue.findIndex((m) => m.type === type && when(m as Of<K>))
      if (i >= 0) return this.queue.splice(i, 1)[0] as Of<K>
      if (this.closed) throw new Error(`socket closed (${this.closed.code}) while waiting for ${type}`)
      const left = deadline - Date.now()
      if (left <= 0) throw new Error(`timed out waiting for ${type}; queue: ${this.queue.map((m) => m.type).join(',')}`)
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(left, 200))
        this.wake.push(() => {
          clearTimeout(t)
          resolve()
        })
      })
    }
  }

  /** True when no message of `type` arrives within `ms`. */
  async none(type: ServerType, ms = 300): Promise<boolean> {
    await new Promise((r) => setTimeout(r, ms))
    return !this.queue.some((m) => m.type === type)
  }

  async waitClosed(timeoutMs = 5_000): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + timeoutMs
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error('socket did not close')
      await new Promise((r) => setTimeout(r, 25))
    }
    return this.closed
  }

  close(): void {
    try {
      this.ws.close(1000, 'done')
    } catch {
      // Already closed.
    }
  }
}

const app = testApp()

/** Opens the room of `workbookId` as `user` through GET /api/workbooks/:id/room. */
export async function openRoom(user: { id: string }, workbookId: string): Promise<TestSocket> {
  const res = await call(app, 'GET', `/api/workbooks/${workbookId}/room`, { user, headers: { upgrade: 'websocket' } })
  if (res.status !== 101 || !res.webSocket) throw new Error(`room upgrade: ${res.status}`)
  return new TestSocket(res.webSocket)
}

export function setValue(workbookId: string, sheetId: string, row: number, column: number, cell: Record<string, unknown> | null) {
  return { id: 'sheet.mutation.set-range-values', params: { unitId: workbookId, subUnitId: sheetId, cellValue: { [row]: { [column]: cell } } } }
}

export function insertRow(workbookId: string, sheetId: string, row: number) {
  return { id: 'sheet.mutation.insert-row', params: { unitId: workbookId, subUnitId: sheetId, range: { startRow: row, endRow: row, startColumn: 0, endColumn: 25 } } }
}

let opCounter = 0
export function opId(): string {
  return `op-${++opCounter}-${crypto.randomUUID().slice(0, 8)}`
}

export function clientId(): string {
  return `client-${crypto.randomUUID()}`
}
