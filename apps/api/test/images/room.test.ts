// Floating images in the workbook room (spec §11; owner 2026-11-11): the
// drawing mutation is accepted, classified as one sheet's plugin data,
// broadcast and saved in the snapshot (resource SHEET_DRAWING_PLUGIN, URL
// source only), refused on the dashboard sheet and from viewers, and never
// counted as a task row change for outbound sync.

import { env } from 'cloudflare:workers'
import { runDurableObjectAlarm } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DASHBOARD_SHEET_ID, imagePath } from '@naf-sheets/shared'
import { classifyOp, footprintsConflict } from '../../src/room/footprint'
import { loadHeadlessWorkbook } from '../../src/room/engine'
import { outboundDetection, setOutboundDetection } from '../../src/room/outbound-seam'
import type { OutboundDetection } from '../../src/room/outbound-seam'
import { detectAfterRoomCommit } from '../../src/sync/room-commit'
import { readSnapshot } from '../../src/snapshot'
import { addMember, call, createWorkbook, json, seedMember, testApp } from '../helpers'
import { harness, readSheetView, setupLinked } from '../sync/harness'
import { clientId, opId, openRoom, setValue } from '../room/ws-client'
import { DRAWING_MUTATION, DrawingOps } from './drawing-ops'

vi.setConfig({ testTimeout: 60_000 })
beforeAll(async () => {
  await import('../../src/room/engine')
}, 120_000)

const app = testApp()
const IMG = 'b'.repeat(32)

type Resource = { name: string; data: string }
type Snap = { id: string; sheets: Record<string, unknown>; resources?: Resource[] }

function drawingsOf(snapshot: unknown, sheet: string): Record<string, Record<string, unknown>> {
  const res = (snapshot as Snap).resources?.find((r) => r.name === 'SHEET_DRAWING_PLUGIN')
  if (!res) return {}
  const data = JSON.parse(res.data) as Record<string, { data?: Record<string, Record<string, unknown>> }>
  return data[sheet]?.data ?? {}
}

async function workbookSnapshot(id: string, user: { id: string }) {
  const res = await call(app, 'GET', `/api/workbooks/${id}`, { user })
  return json<{ snapshot: Snap; version: number; sheets: Array<{ univerSheetId: string }> }>(res)
}

function room(id: string) {
  return env.WORKBOOK_ROOM.get(env.WORKBOOK_ROOM.idFromName(id))
}

async function joined(user: { id: string }, workbookId: string) {
  const socket = await openRoom(user, workbookId)
  socket.hello(clientId())
  const welcome = await socket.take('welcome')
  return { socket, seq: welcome.seq }
}

describe('footprint of the drawing mutation', () => {
  const op = (sheet: string) => [{ id: DRAWING_MUTATION, params: { unitId: 'u', subUnitId: sheet, op: [], objects: {}, type: 0 } }]

  it('is plugin data of one sheet: it conflicts with another drawing op on that sheet only, never with cells', () => {
    const a = classifyOp(op('s1'), 'u')
    if (!a.ok) throw new Error(a.detail)
    expect(a.footprint).toMatchObject({ structural: false, cells: [], keys: ['drawing:s1'] })
    const b = classifyOp(op('s2'), 'u')
    const cells = classifyOp([setValue('u', 's1', 1, 0, { v: 'x' })], 'u')
    if (!b.ok || !cells.ok) throw new Error('classify')
    expect(footprintsConflict(a.footprint, a.footprint)).toBe(true)
    expect(footprintsConflict(a.footprint, b.footprint)).toBe(false)
    expect(footprintsConflict(a.footprint, cells.footprint)).toBe(false)
  })

  it('is refused on the dashboard sheet', () => {
    const out = classifyOp(op(DASHBOARD_SHEET_ID), 'u', DASHBOARD_SHEET_ID)
    expect(out.ok).toBe(false)
  })
})

describe('the headless room keeps floating images', () => {
  it('applies insert, move and remove from Univer’s own service and saves them in SHEET_DRAWING_PLUGIN', async () => {
    const owner = await seedMember('editor')
    const id = await createWorkbook(app, owner)
    const { snapshot, sheets } = await workbookSnapshot(id, owner)
    const sheet = sheets[0]!.univerSheetId
    const ops = new DrawingOps(snapshot)
    const wb = loadHeadlessWorkbook(snapshot)
    try {
      const source = imagePath(id, IMG)
      expect(wb.apply([ops.insert(sheet, { drawingId: 'pic1', source, column: 2, row: 3 })]).failedAt).toBe(-1)
      let saved = drawingsOf(wb.snapshot(), sheet)
      expect(saved.pic1).toMatchObject({ source, imageSourceType: 'URL', sheetTransform: { from: { column: 2, row: 3 } } })
      // Reloaded from its own save: still there.
      const again = loadHeadlessWorkbook(wb.snapshot())
      expect(drawingsOf(again.snapshot(), sheet).pic1).toBeDefined()
      again.dispose()

      expect(wb.apply([ops.move(sheet, 'pic1', { column: 5, row: 7 })]).failedAt).toBe(-1)
      saved = drawingsOf(wb.snapshot(), sheet)
      expect(saved.pic1).toMatchObject({ sheetTransform: { from: { column: 5, row: 7 } } })

      expect(wb.apply([ops.remove(sheet, 'pic1')]).failedAt).toBe(-1)
      expect(drawingsOf(wb.snapshot(), sheet).pic1).toBeUndefined()
    } finally {
      wb.dispose()
      ops.dispose()
    }
  })
})

describe('floating images through the room', () => {
  it('an editor inserts and moves a picture: acked, broadcast, saved as a URL (no bytes), kept after a reload', async () => {
    const owner = await seedMember('editor')
    const editor = await seedMember('editor')
    const id = await createWorkbook(app, owner)
    await addMember(id, editor.id, 'editor', owner.id)
    const { snapshot, sheets } = await workbookSnapshot(id, owner)
    const sheet = sheets[0]!.univerSheetId
    const ops = new DrawingOps(snapshot)
    const a = await joined(owner, id)
    const b = await joined(editor, id)
    const source = imagePath(id, IMG)

    const insert = ops.insert(sheet, { drawingId: 'pic1', source, column: 1, row: 1 })
    a.socket.send({ type: 'op', opId: opId(), baseSeq: a.seq, epoch: 1, mutations: [insert] })
    expect((await a.socket.take('ack')).seq).toBe(1)
    expect((await b.socket.take('op')).op.mutations[0]!.id).toBe(DRAWING_MUTATION)
    a.socket.send({ type: 'op', opId: opId(), baseSeq: 1, epoch: 1, mutations: [ops.move(sheet, 'pic1', { column: 4, row: 6 })] })
    expect((await a.socket.take('ack')).seq).toBe(2)
    await runDurableObjectAlarm(room(id))

    const stored = await readSnapshot(env, id, (await workbookSnapshot(id, owner)).version)
    const pic = drawingsOf(stored, sheet).pic1
    expect(pic).toMatchObject({ source, sheetTransform: { from: { column: 4, row: 6 } } })
    expect(JSON.stringify(stored)).not.toContain('base64')
    a.socket.close()
    b.socket.close()

    // A new session opens with the picture.
    const c = await openRoom(owner, id)
    c.hello(clientId())
    const welcome = await c.take('welcome')
    expect(welcome.mode === 'snapshot' && drawingsOf(welcome.snapshot, sheet).pic1).toBeTruthy()
    c.close()
    ops.dispose()
  })

  it('a viewer’s drawing op is refused and nothing is applied', async () => {
    const owner = await seedMember('editor')
    const viewer = await seedMember('viewer')
    const id = await createWorkbook(app, owner)
    await addMember(id, viewer.id, 'viewer', owner.id)
    const { snapshot, sheets } = await workbookSnapshot(id, owner)
    const ops = new DrawingOps(snapshot)
    const v = await joined(viewer, id)
    v.socket.send({ type: 'op', opId: opId(), baseSeq: v.seq, epoch: 1, mutations: [ops.insert(sheets[0]!.univerSheetId, { drawingId: 'p', source: imagePath(id, IMG), column: 0, row: 0 })] })
    expect((await v.socket.take('reject')).reason).toBe('forbidden')
    v.socket.close()
    ops.dispose()
  })

  it('the dashboard sheet refuses a drawing op', async () => {
    const owner = await seedMember('editor')
    const id = await createWorkbook(app, owner)
    const { snapshot } = await workbookSnapshot(id, owner)
    const ops = new DrawingOps(snapshot)
    const a = await joined(owner, id)
    a.socket.send({ type: 'op', opId: opId(), baseSeq: a.seq, epoch: 1, mutations: [ops.insert(DASHBOARD_SHEET_ID, { drawingId: 'p', source: imagePath(id, IMG), column: 0, row: 0 })] })
    expect((await a.socket.take('reject')).reason).toBe('invalid')
    a.socket.close()
    ops.dispose()
  })
})

describe('floating images and outbound sync', () => {
  let installed: OutboundDetection | null = null
  afterEach(() => {
    if (installed) setOutboundDetection(installed)
    installed = null
  })

  it('adding, moving and removing a picture on a synced sheet queues nothing for Basecamp', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'إعداد الخطة' }, { title: 'تصميم' }] })
    const view = await readSheetView(l)
    h.outbound.take()
    const writesBefore = h.fake.writes().length
    installed = outboundDetection()
    let detections = 0
    setOutboundDetection(async (_env, event) => {
      detections++
      await detectAfterRoomCommit(h.env, event)
    })
    const ops = new DrawingOps(view.snapshot as unknown as Record<string, unknown>)
    const a = await joined(l.owner, l.wbId)
    const source = imagePath(l.wbId, IMG)
    const mutations = [
      ops.insert(l.univerSheetId, { drawingId: 'p1', source, column: 0, row: view.row('إعداد الخطة') }),
      ops.move(l.univerSheetId, 'p1', { column: 2, row: view.row('تصميم') }),
    ]
    let seq = a.seq
    for (const m of mutations) {
      a.socket.send({ type: 'op', opId: opId(), baseSeq: seq, epoch: 1, mutations: [m] })
      seq = (await a.socket.take('ack')).seq
    }
    await runDurableObjectAlarm(room(l.wbId))
    a.socket.send({ type: 'op', opId: opId(), baseSeq: seq, epoch: 1, mutations: [ops.remove(l.univerSheetId, 'p1')] })
    await a.socket.take('ack')
    await runDurableObjectAlarm(room(l.wbId))

    expect(detections).toBeGreaterThan(0)
    expect(h.outbound.sent).toEqual([])
    const { results } = await env.DB.prepare(`SELECT sync_state FROM tasks t JOIN sheets s ON s.id = t.sheet_id WHERE s.workbook_id = ?1`).bind(l.wbId).all<{ sync_state: string }>()
    expect(results.every((r) => r.sync_state === 'synced')).toBe(true)
    expect(h.fake.writes().length).toBe(writesBefore)
    a.socket.close()
    ops.dispose()
  })
})
