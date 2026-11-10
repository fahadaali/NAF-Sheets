// A headless "editor" for two-client tests: a Univer 1.4.0 instance (the
// room's model plugins plus the Facade) driven by the real room client and
// Univer adapter of apps/web, connected through the Worker route.

import { ICommandService, IUndoRedoService } from '@univerjs/core'
import type { Univer } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import '@univerjs/sheets/facade'
import type { FWorkbook } from '@univerjs/sheets/facade'
import type { RoomCell } from '@naf-sheets/shared'
import { createUniverRoomAdapter } from '../../../web/src/collab/univer-adapter'
import { RoomClient } from '../../../web/src/lib/room-client'
import type { RoomClientState, RoomSocketLike } from '../../../web/src/lib/room-client'
import { advanceHeadlessLifecycle, createModelUniver } from '../../src/room/engine'
import { call, testApp } from '../helpers'

const app = testApp()

/** A socket the test can slow down (hold frames) or cut (drop). */
export class TestTransport implements RoomSocketLike {
  private held: string[] | null = null
  private readonly closeListeners: Array<(event: { code: number; reason: string }) => void> = []
  dropped = false

  constructor(private readonly ws: WebSocket) {
    ws.accept()
    ws.addEventListener('close', (event) => this.emitClose(event.code, event.reason))
  }

  send(data: string): void {
    if (this.dropped) return
    if (this.held) this.held.push(data)
    else this.ws.send(data)
  }

  close(code?: number, reason?: string): void {
    try {
      this.ws.close(code ?? 1000, reason ?? '')
    } catch {
      // Already closed.
    }
  }

  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', listener: (event: { code: number; reason: string }) => void): void
  addEventListener(type: 'message' | 'close', listener: (event: never) => void): void {
    if (type === 'message') this.ws.addEventListener('message', (event) => (listener as (e: { data: unknown }) => void)({ data: event.data }))
    else this.closeListeners.push(listener as (e: { code: number; reason: string }) => void)
  }

  /** Frames sent from now on wait until `release`. */
  hold(): void {
    this.held ??= []
  }

  release(): void {
    const frames = this.held ?? []
    this.held = null
    for (const f of frames) this.ws.send(f)
  }

  /** Cuts the connection as a network failure would. */
  drop(): void {
    this.dropped = true
    this.close(1001, 'dropped')
    this.emitClose(1006, 'dropped')
  }

  private emitClose(code: number, reason: string): void {
    const listeners = this.closeListeners.splice(0)
    for (const l of listeners) l({ code, reason })
  }
}

export class HeadlessEditor {
  univer: Univer | null = null
  api: FUniver | null = null
  editable = false
  undoCleared = 0
  /** Times the whole workbook was (re)loaded from a room snapshot. */
  loads = 0
  readonly notices: Array<{ message: string; kind: string }> = []
  readonly transports: TestTransport[] = []
  readonly client: RoomClient
  last: RoomClientState | null = null

  constructor(
    readonly user: { id: string },
    readonly workbookId: string,
  ) {
    const adapter = createUniverRoomAdapter({
      unitId: workbookId,
      commands: () => (this.univer ? (this.injectorGet(ICommandService) as never) : null),
      load: (snapshot) => this.load(snapshot),
      setEditable: (editable) => {
        this.editable = editable
      },
      clearUndo: () => {
        this.undoCleared++
        this.injectorGet<IUndoRedoService>(IUndoRedoService).clearUndoRedo(workbookId)
      },
    })
    this.client = new RoomClient({
      adapter,
      connect: async () => {
        const res = await call(app, 'GET', `/api/workbooks/${workbookId}/room`, { user, headers: { upgrade: 'websocket' } })
        if (res.status !== 101 || !res.webSocket) throw new Error(`upgrade ${res.status}`)
        const transport = new TestTransport(res.webSocket)
        this.transports.push(transport)
        return transport
      },
      reconnectDelaysMs: [50, 100],
      presenceMs: 10,
      onState: (state) => {
        this.last = state
      },
      onNotice: (message, kind) => this.notices.push({ message, kind }),
    })
  }

  private injectorGet<T>(token: unknown): T {
    if (!this.univer) throw new Error('editor not loaded')
    return this.univer.__getInjector().get(token as never) as T
  }

  /** Mounts the workbook (what the editor screen does with the welcome snapshot). */
  load(snapshot: Record<string, unknown>): void {
    this.loads++
    this.univer?.dispose()
    const univer = createModelUniver()
    this.univer = univer
    this.api = FUniver.newAPI(univer)
    this.api.createWorkbook(structuredClone(snapshot) as never)
    advanceHeadlessLifecycle(univer)
  }

  get transport(): TestTransport {
    return this.transports[this.transports.length - 1]!
  }

  workbook(): FWorkbook {
    const wb = this.api?.getActiveWorkbook()
    if (!wb) throw new Error('no workbook')
    return wb
  }

  /** A user edit through Univer's own command (the Facade), as the toolbar or a keystroke would. */
  async set(sheetId: string, a1: string, value: string | number): Promise<void> {
    const sheet = this.workbook().getSheetBySheetId(sheetId)
    if (!sheet) throw new Error(`no sheet ${sheetId}`)
    await sheet.getRange(a1).setValue(value)
  }

  async insertRowAfter(sheetId: string, row: number): Promise<void> {
    await this.workbook().getSheetBySheetId(sheetId)!.insertRowAfter(row)
  }

  value(sheetId: string, a1: string): unknown {
    return this.workbook().getSheetBySheetId(sheetId)?.getRange(a1).getValue()
  }

  formula(sheetId: string, a1: string): string {
    return this.workbook().getSheetBySheetId(sheetId)?.getRange(a1).getFormula() ?? ''
  }

  select(cell: RoomCell | null): void {
    this.client.setSelection(cell)
  }

  start(): this {
    this.client.start()
    return this
  }

  stop(): void {
    this.client.stop()
    this.univer?.dispose()
    this.univer = null
  }
}

export async function until<T>(read: () => T, ok: (v: T) => boolean, timeoutMs = 10_000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = read()
    if (ok(v)) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}
