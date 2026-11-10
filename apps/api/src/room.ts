// WorkbookRoom — one Durable Object per workbook (spec §4.2, §11).
//
// Phase 6 stub: it accepts a WebSocket once the Worker has checked that the
// caller may open the workbook, and does nothing more. Ordering and broadcast
// of operations, presence and soft cell locks come in phase 6 (default (a) of
// spec §5.3 until §17-2 is decided).
//
// The Worker is the only way in: a Durable Object has no public address, so
// the identity headers below can only have been set by the Worker after
// `loadWorkbook` resolved the caller's access (spec §14: checked on every
// request and every WebSocket connection).

import { DurableObject } from 'cloudflare:workers'
import type { WorkbookAccess } from './access'
import type { Env } from './env'
import { errorResponse } from './errors'

export const ROOM_HEADERS = {
  workbook: 'x-naf-room-workbook',
  user: 'x-naf-room-user',
  access: 'x-naf-room-access',
} as const

const ACCESS_VALUES: ReadonlySet<string> = new Set<WorkbookAccess>(['admin', 'owner', 'editor', 'viewer'])

/** The request forwarded to the room, carrying the identity the Worker verified. */
export function roomRequest(original: Request, identity: { workbookId: string; userId: string; access: WorkbookAccess }): Request {
  const headers = new Headers(original.headers)
  // The room never needs the session cookie.
  headers.delete('cookie')
  headers.set(ROOM_HEADERS.workbook, identity.workbookId)
  headers.set(ROOM_HEADERS.user, identity.userId)
  headers.set(ROOM_HEADERS.access, identity.access)
  return new Request(original.url, { method: 'GET', headers })
}

export class WorkbookRoom extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    if ((request.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
      return errorResponse(426, 'websocket_required')
    }

    const workbookId = request.headers.get(ROOM_HEADERS.workbook)
    const userId = request.headers.get(ROOM_HEADERS.user)
    const access = request.headers.get(ROOM_HEADERS.access)
    if (!workbookId || !userId || !access || !ACCESS_VALUES.has(access)) {
      return errorResponse(403, 'room_forbidden')
    }

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    // Hibernation API; the tags let phase 6 find a user's sockets and their access.
    this.ctx.acceptWebSocket(server, [`user:${userId}`, `access:${access}`])
    return new Response(null, { status: 101, webSocket: client })
  }

  // TODO(phase 6): apply, order and broadcast operations; presence; soft locks (§11).
  override async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {}

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason)
    } catch {
      // Already closed by the runtime.
    }
  }
}
