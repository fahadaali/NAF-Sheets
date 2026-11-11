// The dashboard tab «اللوحة» in the room (spec §11; @naf-sheets/shared
// dashboard-sheet.ts): a workbook that predates it gets it when the room loads,
// exactly as GET /api/workbooks/:id adds it, and no op may remove, rename,
// hide or move it, put a sheet before it, or write into it.

import { env } from 'cloudflare:workers'
import { runDurableObjectAlarm } from 'cloudflare:test'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { DASHBOARD_SHEET_ID, DASHBOARD_SHEET_TITLE, SHEET_ROLE_KEY, isDashboardSheet, withoutDashboardSheet } from '@naf-sheets/shared'
import type { WorkbookResponse } from '@naf-sheets/shared'
import { classifyOp } from '../../src/room/footprint'
import { loadHeadlessWorkbook } from '../../src/room/engine'
import { readSnapshot } from '../../src/snapshot'
import { call, createWorkbook, json, seedMember, testApp } from '../helpers'
import { clientId, opId, openRoom, setValue } from './ws-client'

const app = testApp()
const D = DASHBOARD_SHEET_ID

vi.setConfig({ testTimeout: 30_000 })
beforeAll(async () => {
  await import('../../src/room/engine')
}, 120_000)

type Snap = { sheetOrder: string[]; sheets: Record<string, Record<string, unknown>> }

describe('classifyOp with the dashboard sheet', () => {
  const U = 'wb-1'
  const op = (id: string, params: Record<string, unknown>) => [{ id, params: { unitId: U, ...params } }]

  it('refuses removing, renaming, hiding, moving, writing into it and putting a sheet before it', () => {
    const refused = [
      op('sheet.mutation.remove-sheet', { subUnitId: D, subUnitName: DASHBOARD_SHEET_TITLE }),
      op('sheet.mutation.set-worksheet-name', { subUnitId: D, name: 'لوحتي' }),
      op('sheet.mutation.set-worksheet-hidden', { subUnitId: D, hidden: 1 }),
      op('sheet.mutation.set-worksheet-order', { subUnitId: D, fromOrder: 0, toOrder: 1 }),
      op('sheet.mutation.set-worksheet-order', { subUnitId: 's1', fromOrder: 1, toOrder: 0 }),
      op('sheet.mutation.insert-sheet', { index: 0, sheet: { id: 'new', name: 'ورقة' } }),
      op('sheet.mutation.insert-sheet', { index: 2, sheet: { id: 'new', name: 'نسخة', custom: { [SHEET_ROLE_KEY]: 'dashboard' } } }),
      op('sheet.mutation.set-range-values', { subUnitId: D, cellValue: { 0: { 0: { v: 'نص' } } } }),
      op('sheet.mutation.insert-row', { subUnitId: D, range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 5 } }),
    ]
    for (const mutations of refused) {
      const out = classifyOp(mutations, U, D)
      expect(out.ok, mutations[0]!.id).toBe(false)
      if (!out.ok) expect(out.detail).toContain('dashboard sheet')
    }
  })

  it('accepts the same ops on other sheets, and layout on it; without a dashboard id nothing changes', () => {
    expect(classifyOp(op('sheet.mutation.remove-sheet', { subUnitId: 's2', subUnitName: 'ب' }), U, D).ok).toBe(true)
    expect(classifyOp(op('sheet.mutation.set-worksheet-order', { subUnitId: 's2', fromOrder: 2, toOrder: 1 }), U, D).ok).toBe(true)
    expect(classifyOp(op('sheet.mutation.insert-sheet', { index: 1, sheet: { id: 'new', name: 'ورقة' } }), U, D).ok).toBe(true)
    expect(classifyOp(op('sheet.mutation.set-range-values', { subUnitId: 's1', cellValue: { 0: { 0: { v: 1 } } } }), U, D).ok).toBe(true)
    expect(classifyOp(op('sheet.mutation.set-worksheet-row-auto-height', { subUnitId: D, rowsAutoHeightInfo: [{ row: 0, autoHeight: 20 }] }), U, D).ok).toBe(true)
    expect(classifyOp(op('sheet.mutation.remove-sheet', { subUnitId: D, subUnitName: 'x' }), U).ok).toBe(true)
  })

  it('the headless engine names the dashboard sheet of what it loaded', () => {
    const engine = loadHeadlessWorkbook({
      id: U,
      sheetOrder: [D, 's1'],
      sheets: { [D]: { id: D, name: DASHBOARD_SHEET_TITLE, custom: { [SHEET_ROLE_KEY]: 'dashboard' } }, s1: { id: 's1', name: 'المهام' } },
    })
    try {
      expect(engine.dashboardSheetId).toBe(D)
      const saved = engine.snapshot() as unknown as Snap
      expect(saved.sheetOrder).toEqual([D, 's1'])
      expect(isDashboardSheet(saved.sheets[D])).toBe(true)
    } finally {
      engine.dispose()
    }
  })
})

describe('the room and a workbook that predates the dashboard sheet', () => {
  it('adds it on load (same model as GET), refuses ops against it, and commits it with the next save', async () => {
    const owner = await seedMember('editor')
    const id = await createWorkbook(app, owner)
    // Store a snapshot without the dashboard sheet, as saved before it existed.
    const first = await json<WorkbookResponse>(await call(app, 'GET', `/api/workbooks/${id}`, { user: owner }))
    const sheet = first.sheets[0]!.univerSheetId
    const old = withoutDashboardSheet(first.snapshot as Snap)
    expect(old.sheetOrder).toEqual([sheet])
    expect((await call(app, 'PUT', `/api/workbooks/${id}/snapshot`, { user: owner, body: { baseVersion: 1, snapshot: old } })).status).toBe(200)
    expect(((await readSnapshot(env, id, 2)) as Snap).sheetOrder).toEqual([sheet])

    const viaGet = (await json<WorkbookResponse>(await call(app, 'GET', `/api/workbooks/${id}`, { user: owner }))).snapshot as Snap
    expect(viaGet.sheetOrder).toEqual([D, sheet])

    const socket = await openRoom(owner, id)
    socket.hello(clientId(), null)
    const welcome = await socket.take('welcome')
    expect(welcome.mode).toBe('snapshot')
    const inRoom = (welcome.mode === 'snapshot' ? welcome.snapshot : null) as Snap
    expect(inRoom.sheetOrder).toEqual([D, sheet])
    expect(inRoom.sheets[D]).toMatchObject({ id: D, name: DASHBOARD_SHEET_TITLE })
    expect(isDashboardSheet(inRoom.sheets[D])).toBe(true)
    expect(inRoom.sheets[D]!.custom).toEqual((viaGet.sheets[D] as { custom: unknown }).custom)

    // Removing it, writing into it, or moving a sheet before it: refused.
    let epoch = welcome.epoch
    for (const m of [
      { id: 'sheet.mutation.remove-sheet', params: { unitId: id, subUnitId: D, subUnitName: DASHBOARD_SHEET_TITLE } },
      setValue(id, D, 0, 0, { v: 'نص' }),
      { id: 'sheet.mutation.set-worksheet-order', params: { unitId: id, subUnitId: sheet, fromOrder: 1, toOrder: 0 } },
    ]) {
      socket.send({ type: 'op', opId: opId(), baseSeq: 0, epoch, mutations: [m] })
      expect((await socket.take('reject')).reason).toBe('invalid')
      epoch = (await socket.take('resync')).epoch
    }

    // An ordinary edit goes through, and the commit carries the dashboard sheet.
    socket.send({ type: 'op', opId: opId(), baseSeq: 0, epoch, mutations: [setValue(id, sheet, 1, 0, { v: 'مهمة' })] })
    await socket.take('ack')
    await runDurableObjectAlarm(env.WORKBOOK_ROOM.get(env.WORKBOOK_ROOM.idFromName(id)))
    expect(await socket.take('saved')).toMatchObject({ version: 3 })
    socket.close()
    const committed = (await readSnapshot(env, id, 3)) as Snap
    expect(committed.sheetOrder).toEqual([D, sheet])
    expect(isDashboardSheet(committed.sheets[D])).toBe(true)
    // D1 never lists it: the file list counts one sheet.
    const { results } = await env.DB.prepare('SELECT univer_sheet_id FROM sheets WHERE workbook_id = ?1').bind(id).all<{ univer_sheet_id: string }>()
    expect(results.map((r) => r.univer_sheet_id)).toEqual([sheet])
    const list = await json<{ workbooks: Array<{ id: string; sheetCount: number }> }>(await call(app, 'GET', '/api/workbooks', { user: owner }))
    expect(list.workbooks.find((w) => w.id === id)?.sheetCount).toBe(1)
  })
})
