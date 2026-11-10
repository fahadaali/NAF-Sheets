// Two (and more) editors in one room, end to end: headless Univer editors
// running the real room client and Univer adapter of apps/web, connected
// through the Worker route to the WorkbookRoom on local Miniflare.

import { env } from 'cloudflare:workers'
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { WorkbookRoom } from '../../src/room'
import { readSnapshot } from '../../src/snapshot'
import { addMember, call, createWorkbook, json, seedMember, testApp } from '../helpers'
import { HeadlessEditor, until } from './headless-editor'

const app = testApp()
vi.setConfig({ testTimeout: 60_000 })
beforeAll(async () => {
  await import('../../src/room/engine')
}, 120_000)

const editors: HeadlessEditor[] = []
afterEach(() => {
  for (const e of editors.splice(0)) e.stop()
})

type Snap = { sheets: Record<string, { cellData?: Record<string, Record<string, { v?: unknown; f?: string }>> }> }

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

async function live(user: { id: string }, id: string): Promise<HeadlessEditor> {
  const e = new HeadlessEditor(user, id).start()
  editors.push(e)
  await until(() => e.last?.status, (s) => s === 'live', 30_000, 'live')
  return e
}

const settled = (e: HeadlessEditor) => until(() => e.last?.pending, (p) => p === 0, 10_000, 'acks')

function room(id: string) {
  return env.WORKBOOK_ROOM.get(env.WORKBOOK_ROOM.idFromName(id))
}

function cell(snapshot: unknown, sheet: string, row: number, column: number) {
  return (snapshot as Snap).sheets[sheet]?.cellData?.[row]?.[column]
}

describe('two editors', () => {
  it('concurrent edits converge in both editors and in the room, formulas included', async () => {
    const { owner, editor, id, sheet } = await setup()
    const a = await live(owner, id)
    const b = await live(editor, id)
    expect([a.editable, b.editable]).toEqual([true, true])

    // Interleaved, without waiting for acks.
    await a.set(sheet, 'C2', 10)
    await b.set(sheet, 'D2', 5)
    await a.set(sheet, 'E2', '=C2+D2')
    await b.set(sheet, 'A3', 'مهمة من ب')
    await Promise.all([settled(a), settled(b)])

    for (const e of [a, b]) {
      await until(() => e.value(sheet, 'E2'), (v) => v === 15, 10_000, 'formula result')
      expect([e.value(sheet, 'C2'), e.value(sheet, 'D2'), e.formula(sheet, 'E2'), e.value(sheet, 'A3')]).toEqual([10, 5, '=C2+D2', 'مهمة من ب'])
    }
    expect(a.last?.seq).toBe(b.last?.seq)

    // The room computed the same, and commits it.
    await runDurableObjectAlarm(room(id))
    const saved = await readSnapshot(env, id, 2)
    expect([cell(saved, sheet, 1, 2)?.v, cell(saved, sheet, 1, 3)?.v, cell(saved, sheet, 1, 4)?.f, cell(saved, sheet, 1, 4)?.v, cell(saved, sheet, 2, 0)?.v]).toEqual([10, 5, '=C2+D2', 15, 'مهمة من ب'])
  })

  it('a remote row insertion shifts the other editor’s cells the same way and clears its undo history', async () => {
    const { owner, editor, id, sheet } = await setup()
    const a = await live(owner, id)
    const b = await live(editor, id)
    await b.set(sheet, 'A5', 'كانت في الصف الخامس')
    await settled(b)
    await until(() => a.value(sheet, 'A5'), (v) => v === 'كانت في الصف الخامس', 10_000, 'remote value')
    await a.insertRowAfter(sheet, 2)
    await settled(a)
    await until(() => b.value(sheet, 'A6'), (v) => v === 'كانت في الصف الخامس', 10_000, 'shifted row')
    expect(a.value(sheet, 'A6')).toBe('كانت في الصف الخامس')
    expect(b.undoCleared).toBeGreaterThan(0)
  })

  it('a stale conflicting edit is rejected; that editor resyncs to the room and both agree', async () => {
    const { owner, editor, id, sheet } = await setup()
    const a = await live(owner, id)
    const b = await live(editor, id)
    // B's edit is slow to arrive; A edits the same cell meanwhile.
    b.transport.hold()
    await b.set(sheet, 'C3', 'من ب')
    await a.set(sheet, 'C3', 'من أ')
    await settled(a)
    b.transport.release()
    await until(() => b.notices.map((n) => n.kind), (k) => k.includes('rejected'), 10_000, 'reject notice')
    await until(() => b.last?.status, (s) => s === 'live', 10_000, 'live again')
    expect(b.value(sheet, 'C3')).toBe('من أ')
    expect(a.value(sheet, 'C3')).toBe('من أ')
    expect(b.editable).toBe(true)
    // B carries on normally after the resync.
    await b.set(sheet, 'C4', 'بعد التحديث')
    await settled(b)
    await until(() => a.value(sheet, 'C4'), (v) => v === 'بعد التحديث', 10_000, 'edit after resync')
  })

  it('shows presence and soft locks to the other editor and releases them when the holder leaves', async () => {
    const { owner, editor, id, sheet } = await setup()
    const a = await live(owner, id)
    const b = await live(editor, id)
    const target = { sheetId: sheet, row: 4, column: 1 }
    a.select(target)
    await until(() => b.last?.peers.find((p) => p.userId === owner.id)?.cell, (c) => c?.row === 4, 10_000, 'presence')
    a.client.lockCell(target)
    await until(() => b.last?.locks.length, (n) => n === 1, 10_000, 'lock shown')
    expect(b.client.isLockedByOthers(target)).toBe(true)
    expect(a.client.isLockedByOthers(target)).toBe(false)
    b.client.lockCell(target)
    await until(() => b.notices.map((n) => n.kind), (k) => k.includes('lock_denied'), 10_000, 'lock denied')

    a.stop()
    await until(() => [b.last?.locks.length, b.last?.peers.length], ([l, p]) => l === 0 && p === 0, 10_000, 'lock released')
    expect(b.client.isLockedByOthers(target)).toBe(false)
  })

  it('keeps a viewer read-only: its grid is not editable and a forced local edit is undone by a resync', async () => {
    const { owner, viewer, id, sheet } = await setup()
    const a = await live(owner, id)
    const v = await live(viewer, id)
    expect(v.last?.readOnly).toBe(true)
    expect(v.editable).toBe(false)
    await v.set(sheet, 'B2', 'من القارئ')
    await until(() => v.value(sheet, 'B2'), (x) => x !== 'من القارئ', 10_000, 'viewer edit undone')
    expect(a.value(sheet, 'B2')).not.toBe('من القارئ')
    expect(v.last?.seq).toBe(0)
  })
})

describe('reconnect', () => {
  it('goes read-only while disconnected, reconnects by itself and catches up without reloading', async () => {
    const { owner, editor, id, sheet } = await setup()
    const a = await live(owner, id)
    const b = await live(editor, id)
    const loadsBefore = b.loads
    b.transport.drop()
    await until(() => b.last?.status, (s) => s === 'offline', 5_000, 'offline')
    expect(b.editable).toBe(false)
    await a.set(sheet, 'B6', 'أثناء الانقطاع')
    await a.set(sheet, 'B7', 7)
    await settled(a)
    await until(() => b.last?.status, (s) => s === 'live', 10_000, 'back')
    expect(b.transports).toHaveLength(2)
    // Caught up from the ops it missed: no reload of the workbook.
    expect(b.loads).toBe(loadsBefore)
    expect([b.value(sheet, 'B6'), b.value(sheet, 'B7')]).toEqual(['أثناء الانقطاع', 7])
    expect(b.editable).toBe(true)
    expect(b.last?.seq).toBe(a.last?.seq)
  })

  it('resends an edit that never reached the room, and the room applies it once', async () => {
    const { owner, editor, id, sheet } = await setup()
    const a = await live(owner, id)
    const b = await live(editor, id)
    b.transport.hold()
    await b.set(sheet, 'D8', 'لم يصل بعد')
    expect(b.last?.pending).toBe(1)
    b.transport.drop()
    await until(() => b.last?.status, (s) => s === 'live', 10_000, 'back')
    await settled(b)
    await until(() => a.value(sheet, 'D8'), (v) => v === 'لم يصل بعد', 10_000, 'resent edit')
    expect(a.last?.seq).toBe(1)
  })
})

describe('persistence across a room restart', () => {
  it('a later editor sees what earlier editors wrote, after they left and the room lost its memory', async () => {
    const { owner, editor, id, sheet } = await setup()
    const a = await live(owner, id)
    await a.set(sheet, 'A9', 'باقٍ بعد إعادة التشغيل')
    await settled(a)
    a.stop()
    // The last editor leaving commits; then the room forgets everything in memory.
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const row = await env.DB.prepare('SELECT current_snapshot_version AS v FROM workbooks WHERE id = ?1').bind(id).first<{ v: number }>()
      if (row?.v === 2) break
      await new Promise((r) => setTimeout(r, 50))
    }
    await runInDurableObject(room(id), (instance: WorkbookRoom) => {
      const r = instance as unknown as { live: { engine: { dispose(): void } } | null }
      r.live?.engine.dispose()
      r.live = null
    })
    const b = await live(editor, id)
    expect(b.value(sheet, 'A9')).toBe('باقٍ بعد إعادة التشغيل')
    expect(cell(await readSnapshot(env, id, 2), sheet, 8, 0)?.v).toBe('باقٍ بعد إعادة التشغيل')
  })
})
