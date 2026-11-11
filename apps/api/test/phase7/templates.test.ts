// Templates (spec §7.1 option 2, §15 phase 7): an admin turns a workbook into
// a template; anyone who may create workbooks makes a new one from it.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { DASHBOARD_SHEET_ID, DEFAULT_COLUMNS, isDashboardSheet } from '@naf-sheets/shared'
import type { TemplateListResponse, TemplateSummary, WorkbookResponse } from '@naf-sheets/shared'
import { templateKey } from '../../src/phase7'
import { call, createWorkbook, isArabic, json, seedMember, testApp } from '../helpers'
import { edit, harness, readSheetView, setupLinked } from '../sync/harness'

const app = testApp()

type Snap = { id: string; name: string; sheetOrder: string[]; sheets: Record<string, { name: string; cellData: Record<string, Record<string, { v?: unknown }>>; columnData?: Record<string, { hd?: number }> }> }

async function expectApiError(res: Response, status: number, error: string) {
  expect(res.status).toBe(status)
  const body = await json(res)
  expect(body.ok).toBe(false)
  expect(body.error).toBe(error)
  expect(isArabic(body.message)).toBe(true)
}

function headerOf(snapshot: Snap, sheetId: string): string[] {
  const line = snapshot.sheets[sheetId]?.cellData['0'] ?? {}
  return Object.entries(line)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, c]) => String(c.v ?? ''))
}

async function makeTemplate(admin: { id: string }, workbookId: string, title = 'قالب حملة', description?: string): Promise<TemplateSummary> {
  const res = await call(app, 'POST', '/api/admin/templates', { user: admin, body: { workbookId, title, description } })
  if (res.status !== 201) throw new Error(`template: ${res.status} ${await res.text()}`)
  return json<TemplateSummary>(res)
}

describe('templates', () => {
  it('an admin turns a blank workbook into a template; an editor creates a workbook from it with the default columns', async () => {
    const admin = await seedMember('admin')
    const editor = await seedMember('editor')
    const sourceId = await createWorkbook(app, admin, 'ملف المصدر')
    const template = await makeTemplate(admin, sourceId, '  قالب الحملات  ', 'خطة حملة قياسية')
    expect(template).toMatchObject({ title: 'قالب الحملات', description: 'خطة حملة قياسية', sheetCount: 1, sourceWorkbookId: sourceId, sourceTitle: 'ملف المصدر' })

    const list = await json<TemplateListResponse>(await call(app, 'GET', '/api/templates', { user: editor }))
    expect(list.templates.map((t) => t.id)).toContain(template.id)

    const created = await call(app, 'POST', '/api/workbooks', { user: editor, body: { title: 'حملة رمضان', source: 'template', templateId: template.id } })
    expect(created.status).toBe(201)
    const { id } = await json<{ id: string }>(created)
    expect(id).not.toBe(sourceId)

    const wb = await json<WorkbookResponse>(await call(app, 'GET', `/api/workbooks/${id}`, { user: editor }))
    expect(wb.workbook).toMatchObject({ title: 'حملة رمضان', source: 'template', ownerId: editor.id, access: 'owner', bcProjectId: null })
    expect(wb.version).toBe(1)
    const snapshot = wb.snapshot as Snap
    expect(snapshot.id).toBe(id)
    expect(snapshot.name).toBe('حملة رمضان')
    expect(wb.sheets).toHaveLength(1)
    expect(wb.sheets[0]).toMatchObject({ title: 'ورقة 1', syncMode: 'local', bcTodolistId: null, headerRow: 1, position: 1 })
    expect(headerOf(snapshot, wb.sheets[0]!.univerSheetId)).toEqual([...DEFAULT_COLUMNS])
    // The dashboard tab «اللوحة»: not in the template, re-created first in the new workbook, never in D1.
    const stored = (await (await env.SNAPSHOTS.get(templateKey(template.id)))!.json()) as Snap
    expect(stored.sheetOrder).not.toContain(DASHBOARD_SHEET_ID)
    expect(Object.values(stored.sheets).some(isDashboardSheet)).toBe(false)
    expect(snapshot.sheetOrder).toEqual([DASHBOARD_SHEET_ID, wb.sheets[0]!.univerSheetId])
    expect(isDashboardSheet(snapshot.sheets[DASHBOARD_SHEET_ID])).toBe(true)

    const row = await env.DB.prepare(`SELECT source, source_ref FROM workbooks WHERE id = ?1`).bind(id).first()
    expect(row).toEqual({ source: 'template', source_ref: template.id })
    const audit = await env.DB.prepare(`SELECT action, details_json FROM audit_log WHERE entity_id IN (?1, ?2) ORDER BY id`).bind(id, template.id).all<{ action: string; details_json: string }>()
    expect(audit.results.map((a) => a.action)).toEqual(['template.create', 'workbook.create'])
    expect(JSON.parse(audit.results[1]!.details_json)).toMatchObject({ source: 'template', templateId: template.id })
  })

  it('a template of a synced workbook carries no task identity, and later edits to the source do not change it', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'إعداد الخطة', due: '2026-12-01' }, { title: 'نشر المقال' }], service: true })
    const admin = l.admin!
    const before = await readSheetView(l)
    expect(before.uidColumn).toBeGreaterThanOrEqual(0)

    const res = await call(h.app, 'POST', '/api/admin/templates', { user: admin, env: h.env, body: { workbookId: l.wbId, title: 'قالب من ملف مربوط' } })
    expect(res.status).toBe(201)
    const template = await json<TemplateSummary>(res)

    // The source is never changed: same version, same uids.
    const after = await readSheetView(l)
    expect(after.version).toBe(before.version)
    expect(after.uid('إعداد الخطة')).toBe(before.uid('إعداد الخطة'))

    // Edit the source after the template was made.
    await edit(l, (v) => v.set(v.row('نشر المقال'), 'A', 'نشر المقال المعدّل'))

    const stored = (await (await env.SNAPSHOTS.get(templateKey(template.id)))!.json()) as Snap
    const text = JSON.stringify(stored)
    expect(text).not.toContain('__uid')
    expect(text).not.toContain(before.uid('إعداد الخطة'))
    expect(text).not.toContain('nafSheets')
    expect(text).not.toContain('نشر المقال المعدّل')
    expect(text).toContain('إعداد الخطة')

    const created = await call(h.app, 'POST', '/api/workbooks', { user: l.owner, env: h.env, body: { title: 'نسخة', source: 'template', templateId: template.id } })
    expect(created.status).toBe(201)
    const { id } = await json<{ id: string }>(created)
    const wb = await json<WorkbookResponse>(await call(h.app, 'GET', `/api/workbooks/${id}`, { user: l.owner, env: h.env }))
    expect(wb.workbook.bcProjectId).toBeNull()
    expect(wb.workbook.syncState).toBe('unlinked')
    expect(wb.sheets.every((s) => s.syncMode === 'local' && s.bcTodolistId === null)).toBe(true)
    expect(JSON.stringify(wb.snapshot)).not.toContain('__uid')
    const tasks = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tasks t JOIN sheets s ON s.id = t.sheet_id WHERE s.workbook_id = ?1`).bind(id).first<{ n: number }>()
    expect(tasks?.n).toBe(0)
  })

  it('only platform admins manage templates; viewers cannot create workbooks from one', async () => {
    const admin = await seedMember('admin')
    const editor = await seedMember('editor')
    const viewer = await seedMember('viewer')
    const sourceId = await createWorkbook(app, editor, 'ملف المحرّر')
    await expectApiError(await call(app, 'POST', '/api/admin/templates', { user: editor, body: { workbookId: sourceId, title: 'قالب' } }), 403, 'forbidden')
    const template = await makeTemplate(admin, sourceId)
    await expectApiError(await call(app, 'PUT', `/api/admin/templates/${template.id}`, { user: editor, body: { title: 'جديد' } }), 403, 'forbidden')
    await expectApiError(await call(app, 'POST', `/api/admin/templates/${template.id}/archive`, { user: viewer }), 403, 'forbidden')
    await expectApiError(await call(app, 'POST', '/api/workbooks', { user: viewer, body: { title: 'ممنوع', source: 'template', templateId: template.id } }), 403, 'forbidden')
    // Reading the list is harmless for anyone signed in.
    expect((await call(app, 'GET', '/api/templates', { user: viewer })).status).toBe(200)
    expect((await call(app, 'GET', '/api/templates')).status).toBe(401)
  })

  it('refuses bad input with Arabic messages and writes nothing', async () => {
    const admin = await seedMember('admin')
    const sourceId = await createWorkbook(app, admin)
    const count = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM templates').first<{ n: number }>())!.n
    const n = await count()
    await expectApiError(await call(app, 'POST', '/api/admin/templates', { user: admin, body: { workbookId: sourceId, title: '   ' } }), 400, 'invalid_title')
    await expectApiError(await call(app, 'POST', '/api/admin/templates', { user: admin, body: { workbookId: sourceId, title: 'ق', description: 'و'.repeat(501) } }), 400, 'invalid_title')
    await expectApiError(await call(app, 'POST', '/api/admin/templates', { user: admin, body: { workbookId: 'missing', title: 'ق' } }), 400, 'invalid_request')
    await expectApiError(await call(app, 'POST', '/api/admin/templates', { user: admin, body: { title: 'ق' } }), 400, 'invalid_request')
    expect(await count()).toBe(n)
    await expectApiError(await call(app, 'POST', '/api/workbooks', { user: admin, body: { title: 'ملف', source: 'template', templateId: 'nope' } }), 404, 'template_not_found')
    await expectApiError(await call(app, 'POST', '/api/workbooks', { user: admin, body: { title: 'ملف', source: 'template' } }), 404, 'template_not_found')
    await expectApiError(await call(app, 'POST', '/api/workbooks', { user: admin, body: { title: '', source: 'template', templateId: 'nope' } }), 400, 'invalid_title')
  })

  it('rename changes the list; archive hides it, keeps the row and the R2 copy, and leaves workbooks made from it alone', async () => {
    const admin = await seedMember('admin')
    const sourceId = await createWorkbook(app, admin)
    const template = await makeTemplate(admin, sourceId)
    const made = await json<{ id: string }>(await call(app, 'POST', '/api/workbooks', { user: admin, body: { title: 'قبل الأرشفة', source: 'template', templateId: template.id } }))

    const renamed = await call(app, 'PUT', `/api/admin/templates/${template.id}`, { user: admin, body: { title: 'اسم جديد', description: '' } })
    expect(renamed.status).toBe(200)
    expect(await json<TemplateSummary>(renamed)).toMatchObject({ id: template.id, title: 'اسم جديد', description: null })

    const archived = await call(app, 'POST', `/api/admin/templates/${template.id}/archive`, { user: admin })
    expect(await json(archived)).toEqual({ archived: true })
    const list = await json<TemplateListResponse>(await call(app, 'GET', '/api/templates', { user: admin }))
    expect(list.templates.map((t) => t.id)).not.toContain(template.id)
    expect(await env.SNAPSHOTS.head(templateKey(template.id))).not.toBeNull()
    const row = await env.DB.prepare('SELECT archived_at, archived_by FROM templates WHERE id = ?1').bind(template.id).first<{ archived_at: string | null; archived_by: string }>()
    expect(row?.archived_at).not.toBeNull()
    expect(row?.archived_by).toBe(admin.id)
    await expectApiError(await call(app, 'POST', '/api/workbooks', { user: admin, body: { title: 'بعد', source: 'template', templateId: template.id } }), 404, 'template_not_found')
    await expectApiError(await call(app, 'POST', `/api/admin/templates/${template.id}/archive`, { user: admin }), 404, 'template_not_found')
    expect((await call(app, 'GET', `/api/workbooks/${made.id}`, { user: admin })).status).toBe(200)
  })

  it('keeps every sheet, in order, with its header row', async () => {
    const admin = await seedMember('admin')
    const sourceId = await createWorkbook(app, admin)
    const wb = await json<WorkbookResponse>(await call(app, 'GET', `/api/workbooks/${sourceId}`, { user: admin }))
    const snapshot = wb.snapshot as Snap
    const first = wb.sheets[0]!.univerSheetId
    snapshot.sheets['second'] = { name: 'الميزانية', cellData: { 0: { 0: { v: 'البند' } } } } as never
    snapshot.sheetOrder = [first, 'second']
    expect((await call(app, 'PUT', `/api/workbooks/${sourceId}/snapshot`, { user: admin, body: { baseVersion: wb.version, snapshot } })).status).toBe(200)
    await env.DB.prepare(
      `INSERT INTO sheets (id, workbook_id, univer_sheet_id, title, position, sync_mode, header_row, created_at) VALUES (?1, ?2, 'second', 'الميزانية', 2, 'local', 3, ?3)`,
    )
      .bind(crypto.randomUUID(), sourceId, new Date().toISOString())
      .run()

    const template = await makeTemplate(admin, sourceId)
    expect(template.sheetCount).toBe(2)
    const made = await json<{ id: string }>(await call(app, 'POST', '/api/workbooks', { user: admin, body: { title: 'ورقتان', source: 'template', templateId: template.id } }))
    const copy = await json<WorkbookResponse>(await call(app, 'GET', `/api/workbooks/${made.id}`, { user: admin }))
    expect(copy.sheets.map((s) => [s.title, s.position, s.headerRow])).toEqual([
      ['ورقة 1', 1, 1],
      ['الميزانية', 2, 3],
    ])
  })
})
