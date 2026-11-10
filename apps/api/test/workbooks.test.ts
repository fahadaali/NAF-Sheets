import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { DEFAULT_COLUMNS } from '@naf-sheets/shared'
import type { WorkbookListResponse, WorkbookResponse } from '@naf-sheets/shared'
import { snapshotKey } from '../src/snapshot'
import { addMember, call, createWorkbook, isArabic, json, seedMember, testApp } from './helpers'

const app = testApp()

async function workbookRow(id: string) {
  return env.DB.prepare('SELECT * FROM workbooks WHERE id = ?1').bind(id).first<Record<string, unknown>>()
}

async function expectApiError(res: Response, status: number, error: string) {
  expect(res.status).toBe(status)
  const body = await json(res)
  expect(body.ok).toBe(false)
  expect(body.error).toBe(error)
  expect(isArabic(body.message)).toBe(true)
}

describe('POST /api/workbooks', () => {
  it('gives the blank sheet Thmanyah as its default font, not Univer\'s Arial (spec §4.1)', async () => {
    const owner = await seedMember('editor')
    const id = await createWorkbook(app, owner)
    const res = await call(app, 'GET', `/api/workbooks/${id}`, { user: owner })
    const { snapshot } = await json<{ snapshot: { sheets: Record<string, { defaultStyle?: { ff?: string } }> } }>(res)
    const sheets = Object.values(snapshot.sheets)
    expect(sheets).toHaveLength(1)
    expect(sheets[0]?.defaultStyle?.ff).toBe('Thmanyah Sans')
  })

  it('creates a blank workbook: row, sheet «ورقة 1», snapshot v1 in R2 with the §7.1 columns, audit entry', async () => {
    const owner = await seedMember('editor')
    const res = await call(app, 'POST', '/api/workbooks', { user: owner, body: { title: '  خطة رمضان  ', source: 'blank' } })
    expect(res.status).toBe(201)
    const { id } = await json<{ id: string }>(res)

    const row = await workbookRow(id)
    expect(row).toMatchObject({ title: 'خطة رمضان', owner_id: owner.id, source: 'blank', bc_project_id: null, current_snapshot_version: 1, archived_at: null })

    const { results: sheets } = await env.DB.prepare('SELECT * FROM sheets WHERE workbook_id = ?1').bind(id).all<Record<string, unknown>>()
    expect(sheets).toHaveLength(1)
    expect(sheets[0]).toMatchObject({ title: 'ورقة 1', position: 1, sync_mode: 'local', bc_todolist_id: null, header_row: 1 })

    const object = await env.SNAPSHOTS.get(`workbooks/${id}/snapshots/1.json`)
    expect(object).not.toBeNull()
    const snapshot = (await object!.json()) as {
      id: string
      name: string
      locale: string
      sheetOrder: string[]
      sheets: Record<string, { name: string; cellData: Record<string, Record<string, { v: string }>> }>
    }
    expect(snapshot).toMatchObject({ id, name: 'خطة رمضان', locale: 'arSA', sheetOrder: [sheets[0]!.univer_sheet_id] })
    const sheet = snapshot.sheets[sheets[0]!.univer_sheet_id as string]!
    expect(sheet.name).toBe('ورقة 1')
    const header = Object.entries(sheet.cellData['0']!)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, cell]) => cell.v)
    expect(header).toEqual([...DEFAULT_COLUMNS])

    const audit = await env.DB.prepare(`SELECT * FROM audit_log WHERE entity_id = ?1 AND action = 'workbook.create'`).bind(id).first<Record<string, unknown>>()
    expect(audit).toMatchObject({ actor_id: owner.id, entity_type: 'workbook', workbook_id: id })
  })

  it('lets an admin create too', async () => {
    const admin = await seedMember('admin')
    const res = await call(app, 'POST', '/api/workbooks', { user: admin, body: { title: 'ملف المسؤول', source: 'blank' } })
    expect(res.status).toBe(201)
  })

  it('refuses a viewer with 403 and creates nothing', async () => {
    const viewer = await seedMember('viewer')
    const res = await call(app, 'POST', '/api/workbooks', { user: viewer, body: { title: 'لن يُنشأ', source: 'blank' } })
    await expectApiError(res, 403, 'forbidden')
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM workbooks WHERE owner_id = ?1').bind(viewer.id).first<{ n: number }>()
    expect(count?.n).toBe(0)
  })

  it('validates the body', async () => {
    const editor = await seedMember('editor')
    await expectApiError(await call(app, 'POST', '/api/workbooks', { user: editor, body: { title: '   ', source: 'blank' } }), 400, 'invalid_title')
    await expectApiError(await call(app, 'POST', '/api/workbooks', { user: editor, body: { title: 'x'.repeat(201), source: 'blank' } }), 400, 'invalid_title')
    await expectApiError(await call(app, 'POST', '/api/workbooks', { user: editor, body: { title: 42, source: 'blank' } }), 400, 'invalid_title')
    await expectApiError(await call(app, 'POST', '/api/workbooks', { user: editor, body: { title: 'مستورد', source: 'gsheets' } }), 400, 'unsupported_source')
    await expectApiError(await call(app, 'POST', '/api/workbooks', { user: editor, body: { title: 'بلا مصدر' } }), 400, 'unsupported_source')
    await expectApiError(await call(app, 'POST', '/api/workbooks', { user: editor, rawBody: '{not json' }), 400, 'invalid_json')
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM workbooks WHERE owner_id = ?1').bind(editor.id).first<{ n: number }>()
    expect(count?.n).toBe(0)
  })
})

describe('GET /api/workbooks', () => {
  it('lists what the caller owns or is a member of; admin sees all', async () => {
    const owner = await seedMember('editor')
    const memberEditor = await seedMember('editor')
    const memberViewer = await seedMember('viewer')
    const outsider = await seedMember('editor')
    const admin = await seedMember('admin')

    const a = await createWorkbook(app, owner, 'ملف أ')
    const b = await createWorkbook(app, outsider, 'ملف ب')
    await addMember(a, memberEditor.id, 'editor', owner.id)
    await addMember(a, memberViewer.id, 'viewer', owner.id)

    const list = async (user: { id: string }, q?: string) => {
      const res = await call(app, 'GET', `/api/workbooks${q === undefined ? '' : `?q=${encodeURIComponent(q)}`}`, { user })
      expect(res.status).toBe(200)
      return (await json<WorkbookListResponse>(res)).workbooks
    }

    const ownerList = await list(owner)
    expect(ownerList.map((w) => w.id)).toEqual([a])
    expect(ownerList[0]).toMatchObject({ title: 'ملف أ', bcProjectId: null, sheetCount: 1, completion: null, syncState: 'unlinked', access: 'owner' })
    expect(typeof ownerList[0]!.updatedAt).toBe('string')

    expect((await list(memberEditor)).map((w) => [w.id, w.access])).toEqual([[a, 'editor']])
    expect((await list(memberViewer)).map((w) => [w.id, w.access])).toEqual([[a, 'viewer']])
    expect((await list(outsider)).map((w) => w.id)).toEqual([b])

    const adminIds = (await list(admin)).filter((w) => w.id === a || w.id === b)
    expect(adminIds.map((w) => w.access)).toEqual(['admin', 'admin'])
  })

  it('searches titles with q, treating % and _ literally', async () => {
    const owner = await seedMember('editor')
    const ramadan = await createWorkbook(app, owner, 'حملة رمضان 2026')
    const hajj = await createWorkbook(app, owner, 'تغطية الحج')
    const percent = await createWorkbook(app, owner, 'نسبة 100% إنجاز')

    const search = async (q: string) =>
      (await json<WorkbookListResponse>(await call(app, 'GET', `/api/workbooks?q=${encodeURIComponent(q)}`, { user: owner }))).workbooks.map((w) => w.id).sort()

    expect(await search('رمضان')).toEqual([ramadan])
    expect(await search('  الحج ')).toEqual([hajj])
    expect(await search('%')).toEqual([percent])
    expect(await search('_')).toEqual([])
    expect(await search('')).toEqual([ramadan, hajj, percent].sort())
  })

  it('derives completion and sync state from synced tasks', async () => {
    const owner = await seedMember('editor')
    const id = await createWorkbook(app, owner, 'ملف مربوط')
    const now = new Date().toISOString()
    await env.DB.prepare('UPDATE workbooks SET bc_project_id = ?1 WHERE id = ?2').bind(Math.floor(Math.random() * 1e12), id).run()
    const sheetId = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO sheets (id, workbook_id, univer_sheet_id, title, position, sync_mode, bc_todolist_id, created_at) VALUES (?1, ?2, ?3, 'المهام', 2, 'synced', ?4, ?5)`,
    )
      .bind(sheetId, id, crypto.randomUUID(), Math.floor(Math.random() * 1e12), now)
      .run()
    const insertTask = (completed: number, state: string) =>
      env.DB.prepare(`INSERT INTO tasks (task_uid, sheet_id, level, completed, sync_state, created_at) VALUES (?1, ?2, 0, ?3, ?4, ?5)`)
        .bind(crypto.randomUUID(), sheetId, completed, state, now)
        .run()
    await insertTask(1, 'synced')
    await insertTask(0, 'synced')
    await insertTask(1, 'synced')
    await insertTask(0, 'pending')

    const summary = (await json<WorkbookListResponse>(await call(app, 'GET', '/api/workbooks', { user: owner }))).workbooks.find((w) => w.id === id)!
    expect(summary).toMatchObject({ sheetCount: 2, completion: 0.5, syncState: 'pending' })

    await insertTask(0, 'error')
    const after = (await json<WorkbookListResponse>(await call(app, 'GET', '/api/workbooks', { user: owner }))).workbooks.find((w) => w.id === id)!
    expect(after).toMatchObject({ completion: 0.4, syncState: 'error' })
  })

  it('leaves archived workbooks out', async () => {
    const owner = await seedMember('editor')
    const id = await createWorkbook(app, owner, 'مؤرشف')
    await env.DB.prepare('UPDATE workbooks SET archived_at = ?1 WHERE id = ?2').bind(new Date().toISOString(), id).run()
    const list = (await json<WorkbookListResponse>(await call(app, 'GET', '/api/workbooks', { user: owner }))).workbooks
    expect(list.map((w) => w.id)).not.toContain(id)
    await expectApiError(await call(app, 'GET', `/api/workbooks/${id}`, { user: owner }), 404, 'not_found')
  })
})

describe('GET /api/workbooks/:id', () => {
  it('returns metadata, sheets and the latest snapshot', async () => {
    const owner = await seedMember('editor')
    const id = await createWorkbook(app, owner, 'ملف للقراءة')
    const res = await call(app, 'GET', `/api/workbooks/${id}`, { user: owner })
    expect(res.status).toBe(200)
    const body = await json<WorkbookResponse>(res)
    expect(body.version).toBe(1)
    expect(body.workbook).toMatchObject({ id, title: 'ملف للقراءة', ownerId: owner.id, source: 'blank', access: 'owner', sheetCount: 1 })
    expect(typeof body.workbook.createdAt).toBe('string')
    expect(body.sheets).toHaveLength(1)
    expect(body.sheets[0]).toMatchObject({ title: 'ورقة 1', position: 1, syncMode: 'local', bcTodolistId: null, headerRow: 1 })
    expect((body.snapshot as { sheetOrder: string[] }).sheetOrder).toEqual([body.sheets[0]!.univerSheetId])
  })

  it('answers 404 — never 403 — to a non-member, and to an unknown id', async () => {
    const owner = await seedMember('editor')
    const outsider = await seedMember('editor')
    const outsiderViewer = await seedMember('viewer')
    const id = await createWorkbook(app, owner)

    const missing = await call(app, 'GET', `/api/workbooks/${crypto.randomUUID()}`, { user: outsider })
    const hidden = await call(app, 'GET', `/api/workbooks/${id}`, { user: outsider })
    await expectApiError(hidden, 404, 'not_found')
    await expectApiError(missing, 404, 'not_found')
    await expectApiError(await call(app, 'GET', `/api/workbooks/${id}`, { user: outsiderViewer }), 404, 'not_found')
  })

  it('lets members and admins read', async () => {
    const owner = await seedMember('editor')
    const viewer = await seedMember('viewer')
    const admin = await seedMember('admin')
    const id = await createWorkbook(app, owner)
    await addMember(id, viewer.id, 'viewer', owner.id)

    const asViewer = await json<WorkbookResponse>(await call(app, 'GET', `/api/workbooks/${id}`, { user: viewer }))
    expect(asViewer.workbook.access).toBe('viewer')
    const asAdmin = await json<WorkbookResponse>(await call(app, 'GET', `/api/workbooks/${id}`, { user: admin }))
    expect(asAdmin.workbook.access).toBe('admin')
  })
})

describe('PUT /api/workbooks/:id/snapshot', () => {
  const newSnapshot = (marker: string) => ({ id: 'wb', name: marker, sheetOrder: ['s1'], sheets: { s1: { id: 's1', name: 'ورقة 1', cellData: { 0: { 0: { v: marker } } } } } })

  it('saves a new version and returns it on the next GET', async () => {
    const owner = await seedMember('editor')
    const id = await createWorkbook(app, owner)
    const before = await workbookRow(id)

    const res = await call(app, 'PUT', `/api/workbooks/${id}/snapshot`, { user: owner, body: { baseVersion: 1, snapshot: newSnapshot('v2') } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ version: 2 })

    const stored = await env.SNAPSHOTS.get(snapshotKey(id, 2))
    expect(await stored!.json()).toEqual(newSnapshot('v2'))
    // The previous version stays (versioned snapshots, spec §14).
    expect(await env.SNAPSHOTS.head(snapshotKey(id, 1))).not.toBeNull()

    const after = await workbookRow(id)
    expect(after?.current_snapshot_version).toBe(2)
    expect(String(after?.updated_at) >= String(before?.updated_at)).toBe(true)

    const read = await json<WorkbookResponse>(await call(app, 'GET', `/api/workbooks/${id}`, { user: owner }))
    expect(read.version).toBe(2)
    expect(read.snapshot).toEqual(newSnapshot('v2'))
  })

  it('answers a stale baseVersion with 409 version_conflict and writes nothing', async () => {
    const owner = await seedMember('editor')
    const id = await createWorkbook(app, owner)
    expect((await call(app, 'PUT', `/api/workbooks/${id}/snapshot`, { user: owner, body: { baseVersion: 1, snapshot: newSnapshot('first') } })).status).toBe(200)

    const stale = await call(app, 'PUT', `/api/workbooks/${id}/snapshot`, { user: owner, body: { baseVersion: 1, snapshot: newSnapshot('stale') } })
    await expectApiError(stale, 409, 'version_conflict')
    const ahead = await call(app, 'PUT', `/api/workbooks/${id}/snapshot`, { user: owner, body: { baseVersion: 7, snapshot: newSnapshot('ahead') } })
    await expectApiError(ahead, 409, 'version_conflict')

    expect((await workbookRow(id))?.current_snapshot_version).toBe(2)
    expect(await (await env.SNAPSHOTS.get(snapshotKey(id, 2)))!.json()).toEqual(newSnapshot('first'))
    expect(await env.SNAPSHOTS.head(snapshotKey(id, 3))).toBeNull()
    expect(await env.SNAPSHOTS.head(snapshotKey(id, 8))).toBeNull()
  })

  it('lets exactly one of two concurrent saves on the same base win', async () => {
    const owner = await seedMember('editor')
    const id = await createWorkbook(app, owner)
    const [r1, r2] = await Promise.all([
      call(app, 'PUT', `/api/workbooks/${id}/snapshot`, { user: owner, body: { baseVersion: 1, snapshot: newSnapshot('one') } }),
      call(app, 'PUT', `/api/workbooks/${id}/snapshot`, { user: owner, body: { baseVersion: 1, snapshot: newSnapshot('two') } }),
    ])
    expect([r1.status, r2.status].sort()).toEqual([200, 409])
    const winner = r1.status === 200 ? 'one' : 'two'
    expect((await workbookRow(id))?.current_snapshot_version).toBe(2)
    expect(await (await env.SNAPSHOTS.get(snapshotKey(id, 2)))!.json()).toEqual(newSnapshot(winner))
  })

  it('replaces a leftover object of a save that died before reaching D1, only once it is old', async () => {
    const owner = await seedMember('editor')
    const id = await createWorkbook(app, owner)
    await env.SNAPSHOTS.put(snapshotKey(id, 2), JSON.stringify(newSnapshot('orphan')))

    // A young object counts as a save in flight.
    const blocked = await call(app, 'PUT', `/api/workbooks/${id}/snapshot`, { user: owner, body: { baseVersion: 1, snapshot: newSnapshot('mine') } })
    await expectApiError(blocked, 409, 'version_conflict')
    expect((await workbookRow(id))?.current_snapshot_version).toBe(1)

    // Old enough (age threshold 0 for the test): replaced and committed.
    const takeover = testApp({ snapshotOrphanAgeMs: 0 })
    const res = await call(takeover, 'PUT', `/api/workbooks/${id}/snapshot`, { user: owner, body: { baseVersion: 1, snapshot: newSnapshot('mine') } })
    expect(res.status).toBe(200)
    expect(await (await env.SNAPSHOTS.get(snapshotKey(id, 2)))!.json()).toEqual(newSnapshot('mine'))
    expect((await workbookRow(id))?.current_snapshot_version).toBe(2)
  })

  it('never replaces a committed version, whatever its age', async () => {
    const owner = await seedMember('editor')
    const id = await createWorkbook(app, owner)
    const takeover = testApp({ snapshotOrphanAgeMs: 0 })
    expect((await call(takeover, 'PUT', `/api/workbooks/${id}/snapshot`, { user: owner, body: { baseVersion: 1, snapshot: newSnapshot('kept') } })).status).toBe(200)
    const stale = await call(takeover, 'PUT', `/api/workbooks/${id}/snapshot`, { user: owner, body: { baseVersion: 1, snapshot: newSnapshot('lost') } })
    await expectApiError(stale, 409, 'version_conflict')
    expect(await (await env.SNAPSHOTS.get(snapshotKey(id, 2)))!.json()).toEqual(newSnapshot('kept'))
  })

  it('enforces roles: editor member and admin write; viewers get 403; outsiders 404', async () => {
    const owner = await seedMember('editor')
    const editor = await seedMember('editor')
    const workbookViewer = await seedMember('editor')
    const platformViewer = await seedMember('viewer')
    const admin = await seedMember('admin')
    const outsider = await seedMember('editor')
    const id = await createWorkbook(app, owner)
    await addMember(id, editor.id, 'editor', owner.id)
    await addMember(id, workbookViewer.id, 'viewer', owner.id)
    // A platform viewer stays read-only even with an editor seat on the workbook.
    await addMember(id, platformViewer.id, 'editor', owner.id)

    const save = (user: { id: string }, baseVersion: number) =>
      call(app, 'PUT', `/api/workbooks/${id}/snapshot`, { user, body: { baseVersion, snapshot: newSnapshot(user.id) } })

    expect((await save(editor, 1)).status).toBe(200)
    expect((await save(admin, 2)).status).toBe(200)
    await expectApiError(await save(workbookViewer, 3), 403, 'forbidden')
    await expectApiError(await save(platformViewer, 3), 403, 'forbidden')
    await expectApiError(await save(outsider, 3), 404, 'not_found')

    expect((await workbookRow(id))?.current_snapshot_version).toBe(3)
    expect(await env.SNAPSHOTS.head(snapshotKey(id, 4))).toBeNull()
  })

  it('keeps an owner demoted to viewer read-only', async () => {
    const owner = await seedMember('editor')
    const id = await createWorkbook(app, owner)
    await env.DB.prepare(`UPDATE members SET role = 'viewer' WHERE user_id = ?1`).bind(owner.id).run()
    const res = await call(app, 'PUT', `/api/workbooks/${id}/snapshot`, { user: owner, body: { baseVersion: 1, snapshot: newSnapshot('x') } })
    await expectApiError(res, 403, 'forbidden')
    const read = await json<WorkbookResponse>(await call(app, 'GET', `/api/workbooks/${id}`, { user: owner }))
    expect(read.workbook.access).toBe('viewer')
  })

  it('validates the body', async () => {
    const owner = await seedMember('editor')
    const id = await createWorkbook(app, owner)
    const put = (body: unknown) => call(app, 'PUT', `/api/workbooks/${id}/snapshot`, { user: owner, body })
    await expectApiError(await put({ snapshot: {} }), 400, 'invalid_base_version')
    await expectApiError(await put({ baseVersion: '1', snapshot: {} }), 400, 'invalid_base_version')
    await expectApiError(await put({ baseVersion: 1.5, snapshot: {} }), 400, 'invalid_base_version')
    await expectApiError(await put({ baseVersion: 1, snapshot: [] }), 400, 'invalid_snapshot')
    await expectApiError(await put({ baseVersion: 1, snapshot: null }), 400, 'invalid_snapshot')
    await expectApiError(await call(app, 'PUT', `/api/workbooks/${id}/snapshot`, { user: owner, rawBody: 'nope' }), 400, 'invalid_json')
    expect((await workbookRow(id))?.current_snapshot_version).toBe(1)
  })
})

describe('platform viewer', () => {
  it('is read-only in every mutating route, even with an editor seat on the workbook', async () => {
    const owner = await seedMember('editor')
    const viewer = await seedMember('viewer')
    const other = await seedMember('editor')
    const id = await createWorkbook(app, owner)
    await addMember(id, viewer.id, 'editor', owner.id)

    const attempts: Array<[string, string, unknown]> = [
      ['POST', '/api/workbooks', { title: 'x', source: 'blank' }],
      ['PUT', `/api/workbooks/${id}/snapshot`, { baseVersion: 1, snapshot: {} }],
      ['PUT', `/api/workbooks/${id}/members`, { members: [{ userId: other.id, role: 'editor' }] }],
    ]
    for (const [method, path, body] of attempts) {
      const res = await call(app, method, path, { user: viewer, body })
      expect(res.status, `${method} ${path}`).toBe(403)
    }

    // …while reading still works.
    expect((await call(app, 'GET', `/api/workbooks/${id}`, { user: viewer })).status).toBe(200)
    expect((await workbookRow(id))?.current_snapshot_version).toBe(1)
    const { results } = await env.DB.prepare('SELECT user_id FROM workbook_members WHERE workbook_id = ?1').bind(id).all()
    expect(results).toEqual([{ user_id: viewer.id }])
  })
})
