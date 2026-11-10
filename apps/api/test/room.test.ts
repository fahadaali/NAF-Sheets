import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { ROOM_HEADERS } from '../src/room'
import { addMember, call, createWorkbook, isArabic, json, seedMember, testApp } from './helpers'

const app = testApp()
const upgrade = { upgrade: 'websocket' }

describe('WorkbookRoom (phase 6 stub)', () => {
  it('accepts a WebSocket from anyone with access to the workbook', async () => {
    const owner = await seedMember('editor')
    const viewer = await seedMember('viewer')
    const id = await createWorkbook(app, owner)
    await addMember(id, viewer.id, 'viewer', owner.id)

    for (const user of [owner, viewer]) {
      const res = await call(app, 'GET', `/api/workbooks/${id}/room`, { user, headers: upgrade })
      expect(res.status).toBe(101)
      const socket = res.webSocket
      expect(socket).not.toBeNull()
      socket!.accept()
      socket!.close(1000, 'done')
    }
  })

  it('checks access first: an outsider gets 404 and no socket', async () => {
    const owner = await seedMember('editor')
    const outsider = await seedMember('editor')
    const id = await createWorkbook(app, owner)
    const res = await call(app, 'GET', `/api/workbooks/${id}/room`, { user: outsider, headers: upgrade })
    expect(res.status).toBe(404)
    expect(res.webSocket).toBeNull()
  })

  it('answers 426 to a request that is not a WebSocket upgrade', async () => {
    const owner = await seedMember('editor')
    const id = await createWorkbook(app, owner)
    const res = await call(app, 'GET', `/api/workbooks/${id}/room`, { user: owner })
    expect(res.status).toBe(426)
    expect(isArabic((await json(res)).message)).toBe(true)
  })

  it('refuses a connection that did not come through the Worker check', async () => {
    const stub = env.WORKBOOK_ROOM.get(env.WORKBOOK_ROOM.idFromName('any-workbook'))
    const res = await stub.fetch('https://room/connect', { headers: upgrade })
    expect(res.status).toBe(403)

    const forged = await stub.fetch('https://room/connect', {
      headers: { ...upgrade, [ROOM_HEADERS.workbook]: 'w', [ROOM_HEADERS.user]: 'u', [ROOM_HEADERS.access]: 'superuser' },
    })
    expect(forged.status).toBe(403)
  })
})
