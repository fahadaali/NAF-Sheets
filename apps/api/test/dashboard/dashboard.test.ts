// The workbook dashboard («اللوحة», src/dashboard): the automatic figures of
// task sheets, custom widgets on any sheet (formulas through their computed
// values), the permissions of opening the workbook, widget CRUD, and the
// admin-only appearance palette.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { AppearanceResponse, DashboardResponse, DashboardWidgetConfig, WidgetListResponse, WidgetResponse, WidgetResult } from '@naf-sheets/shared'
import { contrastRatio, contrastWarnings } from '@naf-sheets/shared'
import { registerDashboardRoutes } from '../../src/dashboard'
import { readValue, weekOf, linkFor, parseRange } from '../../src/dashboard'
import { addMember, call, createWorkbook, isArabic, json, seedMember, testApp } from '../helpers'
import { harness, setupLinked } from '../sync/harness'

const NOW = () => new Date('2026-11-10T09:00:00Z') // a Tuesday, Riyadh time 12:00

function app() {
  const a = testApp()
  registerDashboardRoutes(a, { now: NOW })
  return a
}

describe('helpers', () => {
  it('weeks run Sunday to Saturday', () => {
    expect(weekOf('2026-11-10')).toEqual({ start: '2026-11-08', end: '2026-11-14' })
    expect(weekOf('2026-11-08')).toEqual({ start: '2026-11-08', end: '2026-11-14' })
    expect(weekOf('2026-11-14')).toEqual({ start: '2026-11-08', end: '2026-11-14' })
    expect(weekOf('2026-11-15')).toEqual({ start: '2026-11-15', end: '2026-11-21' })
  })

  it('reads numbers, numeric text, formulas through their computed value', () => {
    expect(readValue(undefined)).toEqual({ kind: 'empty' })
    expect(readValue({ v: 12 })).toEqual({ kind: 'number', value: 12 })
    expect(readValue({ v: '1,250' })).toEqual({ kind: 'number', value: 1250 })
    expect(readValue({ v: '٣٤' })).toEqual({ kind: 'number', value: 34 })
    expect(readValue({ v: 'منجز' })).toEqual({ kind: 'text' })
    expect(readValue({ v: true, t: 3 })).toEqual({ kind: 'text' })
    expect(readValue({ f: '=A1*2', v: 8 })).toEqual({ kind: 'number', value: 8 })
    expect(readValue({ f: '=A1*2' })).toEqual({ kind: 'uncomputed' })
    expect(readValue({ si: 'abc', v: 3 })).toEqual({ kind: 'number', value: 3 })
  })

  it('links a set of cells to the bounding range in the sheet holding most of them', () => {
    expect(linkFor([])).toBeNull()
    expect(linkFor([{ sheetId: 's1', row: 4, column: 3 }])).toEqual({ sheetId: 's1', range: 'D5' })
    expect(
      linkFor([
        { sheetId: 's1', row: 1, column: 1 },
        { sheetId: 's2', row: 3, column: 1 },
        { sheetId: 's2', row: 9, column: 1 },
      ]),
    ).toEqual({ sheetId: 's2', range: 'B4:B10' })
    expect(parseRange('c10:b4')).toEqual({ startRow: 3, startColumn: 1, endRow: 9, endColumn: 2 })
    expect(parseRange('B')).toBeNull()
  })

  it('computes WCAG contrast and warns below the minimum', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2)
    expect(contrastWarnings({ text: '#777777', surface: '#ffffff' })).toEqual([{ foreground: 'text', background: 'surface', ratio: 4.48, minimum: 4.5 }])
    expect(contrastWarnings({ text: '#202124', surface: '#ffffff' })).toEqual([])
  })
})

describe('automatic dashboard of a task sheet', () => {
  it('counts completion, overdue, this week, people (externals and unmatched names), the timeline, subtasks, activity and sync', async () => {
    const h = harness()
    registerDashboardRoutes(h.app, { now: NOW })
    const l = await setupLinked(h, {
      people: ['سارة'],
      hierarchy: { mode: 'indent' },
      rows: [
        { title: 'مهمة متأخرة', assignees: 'سارة', due: '2026-11-01' },
        { title: 'مهمة هذا الأسبوع', assignees: 'سارة، خالد المجهول', due: '2026-11-12' },
        { title: 'مهمة منجزة', due: '2026-11-03', done: true },
        { title: 'مهمة لاحقة', due: '2026-12-20' },
        { title: 'بلا تاريخ' },
        { title: 'الأم' },
        { title: 'ابنة أولى', done: true, indent: true },
        { title: 'ابنة ثانية', assignees: 'سارة', indent: true },
      ],
    })
    const res = await call(h.app, 'GET', `/api/workbooks/${l.wbId}/dashboard`, { user: l.owner, env: h.env })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const d = await json<DashboardResponse>(res)
    expect(d).toMatchObject({ asOf: '2026-11-10', weekStart: '2026-11-08', weekEnd: '2026-11-14', canEdit: true })
    expect(d.totals).toMatchObject({ todos: 6, done: 1, overdue: 1, dueThisWeek: 1, undated: 3 })
    expect(d.totals.completion).toBeCloseTo(1 / 6, 5)
    expect(d.totals.completionLink?.sheetId).toBe(l.univerSheetId)
    expect(d.totals.completionLink?.range).toMatch(/^E2:E\d+$/)

    expect(d.sheets).toHaveLength(1)
    expect(d.sheets[0]).toMatchObject({ sheetId: l.univerSheetId, kind: 'tasks', todos: 6, done: 1, overdue: 1, open: 4 })

    expect(d.overdue.map((t) => t.title)).toEqual(['مهمة متأخرة'])
    expect(d.overdue[0]).toMatchObject({ status: 'overdue', dueOn: '2026-11-01', assignees: ['سارة'], level: 0, link: { sheetId: l.univerSheetId, range: 'A2' } })
    expect(d.dueThisWeek.map((t) => t.title)).toEqual(['مهمة هذا الأسبوع'])
    expect(d.totals.overdueLink).toEqual({ sheetId: l.univerSheetId, range: 'D2' })

    const sara = d.assignees.find((a) => a.name === 'سارة')
    // Her to-dos (overdue, this week) and her subtask; the automatic parent is not counted again.
    expect(sara).toMatchObject({ kind: 'bc_person', overdue: 1, open: 2, done: 0 })
    expect(sara?.link?.range).toMatch(/^B2:B9$/)
    expect(d.assignees.find((a) => a.name === 'خالد المجهول')).toMatchObject({ kind: 'unmatched', open: 1, key: 'name:خالد المجهول' })

    // Weeks 2026-11-01 … 2026-12-20, contiguous (empty weeks included).
    expect(d.timeline[0]).toMatchObject({ weekStart: '2026-11-01', overdue: 1, done: 1 })
    expect(d.timeline.at(-1)?.weekStart).toBe('2026-12-20')
    expect(d.timeline).toHaveLength(8)
    expect(d.timeline[1]).toMatchObject({ weekStart: '2026-11-08', open: 1 })
    expect(d.timeline[2]).toMatchObject({ weekStart: '2026-11-15', done: 0, open: 0, overdue: 0, link: null })

    expect(d.subtasks).toMatchObject({ total: 2, done: 1 })
    expect(d.subtasks.parents).toEqual([expect.objectContaining({ title: 'الأم', done: 1, total: 2, link: { sheetId: l.univerSheetId, range: 'A7' } })])

    expect(d.activity.length).toBeGreaterThan(0)
    const created = d.activity.find((a) => a.action === 'create_todo')
    expect(created).toMatchObject({ direction: 'out', status: 'ok', actorName: l.owner.name })
    expect(created?.taskTitle).not.toBeNull()
    expect(created?.link?.sheetId).toBe(l.univerSheetId)
    // The row naming someone nobody matches is held back (§9.5): the workbook shows it.
    expect(d.sync).toMatchObject({ state: 'error', counts: { pending: 0, error: 1, conflict: 0 } })
    expect(d.widgets).toEqual([])
  })

  it('counts an external contact by name', async () => {
    const h = harness()
    registerDashboardRoutes(h.app, { now: NOW })
    const contact = `ext-${crypto.randomUUID()}`
    const owner = await seedMember('editor')
    await env.DB.prepare(`INSERT INTO external_contacts (id, name, organization, created_by, created_at) VALUES (?1, 'وكالة النشر', NULL, ?2, ?3)`).bind(contact, owner.id, new Date().toISOString()).run()
    const l = await setupLinked(h, { rows: [{ title: 'تصميم', assignees: 'أحمد المالك، وكالة النشر', due: '2026-11-02' }] })
    const d = await json<DashboardResponse>(await call(h.app, 'GET', `/api/workbooks/${l.wbId}/dashboard`, { user: l.owner, env: h.env }))
    expect(d.assignees.find((a) => a.kind === 'external')).toMatchObject({ key: `ext:${contact}`, name: 'وكالة النشر', overdue: 1 })
    expect(d.assignees.find((a) => a.name === 'أحمد المالك')).toMatchObject({ kind: 'bc_person', overdue: 1 })
  })
})

// ---------------------------------------------------------------------------
// A plain (non-task) sheet with formulas
// ---------------------------------------------------------------------------

type Cells = Record<number, Record<number, Record<string, unknown>>>

async function plainWorkbook(a: ReturnType<typeof app>, owner: { id: string }, cells: Cells): Promise<{ id: string; sheetId: string }> {
  const id = await createWorkbook(a, owner, 'ميزانية الحملة')
  const wb = await json<{ snapshot: { sheets: Record<string, { cellData: Cells }> }; version: number; sheets: Array<{ univerSheetId: string }> }>(
    await call(a, 'GET', `/api/workbooks/${id}`, { user: owner }),
  )
  const sheetId = wb.sheets[0]!.univerSheetId
  wb.snapshot.sheets[sheetId]!.cellData = cells
  const saved = await call(a, 'PUT', `/api/workbooks/${id}/snapshot`, { user: owner, body: { baseVersion: wb.version, snapshot: wb.snapshot } })
  expect(saved.status).toBe(200)
  return { id, sheetId }
}

const BUDGET: Cells = {
  0: { 0: { v: 'القسم' }, 1: { v: 'المبلغ' } },
  1: { 0: { v: 'التسويق' }, 1: { v: 100, t: 2 } },
  2: { 0: { v: 'التسويق' }, 1: { v: '1,250' } },
  3: { 0: { v: 'المالية' }, 1: { f: '=B2*2', v: 200, t: 2 } },
  4: { 0: { v: 'المالية' }, 1: { f: '=B9*2' } },
  5: { 1: { v: 'غير رقمي' } },
}

const config = (over: Partial<DashboardWidgetConfig> & Pick<DashboardWidgetConfig, 'sheetId'>): DashboardWidgetConfig => ({
  title: 'المبالغ حسب القسم',
  source: { kind: 'column', column: 'B' },
  aggregation: 'sum',
  groupBy: 'A',
  display: 'bar',
  ...over,
})

describe('custom widgets on a plain sheet', () => {
  it('aggregate a column with group-by; formulas count with their computed value; text and uncomputed cells are reported', async () => {
    const a = app()
    const owner = await seedMember('editor')
    const { id, sheetId } = await plainWorkbook(a, owner, BUDGET)
    const preview = async (c: DashboardWidgetConfig) => json<WidgetResult & { ok: true }>(await call(a, 'POST', `/api/workbooks/${id}/dashboard/preview`, { user: owner, body: c }))

    const sum = await preview(config({ sheetId }))
    expect(sum).toMatchObject({ ok: true, value: 1550, cells: 4, skipped: 1, uncomputed: 1, otherGroups: 0, link: { sheetId, range: 'B2:B6' } })
    expect(sum.groups).toEqual([
      { label: 'التسويق', value: 1350, cells: 2, link: { sheetId, range: 'B2:B3' } },
      { label: 'المالية', value: 200, cells: 1, link: { sheetId, range: 'B4' } },
      { label: '', value: null, cells: 1, link: { sheetId, range: 'B6' } },
    ])
    expect(await preview(config({ sheetId, aggregation: 'count', groupBy: null, display: 'kpi' }))).toMatchObject({ value: 4, skipped: 0, groups: null })
    expect((await preview(config({ sheetId, aggregation: 'average', groupBy: null, display: 'kpi' }))).value).toBeCloseTo(1550 / 3, 5)
    expect((await preview(config({ sheetId, aggregation: 'min', groupBy: null, display: 'kpi' }))).value).toBe(100)
    expect((await preview(config({ sheetId, aggregation: 'max', groupBy: null, display: 'table' }))).value).toBe(1250)
    expect(await preview(config({ sheetId, source: { kind: 'range', range: 'b2:b3' }, groupBy: null, display: 'kpi' }))).toMatchObject({ value: 1350, link: { sheetId, range: 'B2:B3' } })
    // Count per group (text counted).
    const count = await preview(config({ sheetId, aggregation: 'count', display: 'pie' }))
    expect(count.groups?.map((g) => [g.label, g.value])).toEqual([
      ['التسويق', 2],
      ['المالية', 1],
      ['', 1],
    ])

    const tooLarge = await json<WidgetResult & { ok: false }>(await call(a, 'POST', `/api/workbooks/${id}/dashboard/preview`, { user: owner, body: config({ sheetId, source: { kind: 'range', range: 'A1:Z100000' }, groupBy: null, display: 'kpi' }) }))
    expect(tooLarge.ok).toBe(false)
    expect(isArabic(tooLarge.message)).toBe(true)
    const missing = await json<WidgetResult & { ok: false }>(await call(a, 'POST', `/api/workbooks/${id}/dashboard/preview`, { user: owner, body: config({ sheetId: 'no-such-sheet' }) }))
    expect(missing.ok).toBe(false)
    expect(isArabic(missing.message)).toBe(true)

    // The plain sheet is listed, with no task figures.
    const d = await json<DashboardResponse>(await call(a, 'GET', `/api/workbooks/${id}/dashboard`, { user: owner }))
    expect(d.sheets).toEqual([expect.objectContaining({ sheetId, kind: 'plain', todos: 0, completion: null })])
    expect(d.totals).toMatchObject({ todos: 0, completion: null, overdue: 0 })
    expect(d.sync.state).toBe('unlinked')
  })

  it('add, edit, reorder and remove (with confirmation, never deleted); invalid configurations are refused in Arabic', async () => {
    const a = app()
    const owner = await seedMember('editor')
    const { id, sheetId } = await plainWorkbook(a, owner, BUDGET)
    const base = `/api/workbooks/${id}/dashboard/widgets`

    for (const bad of [
      config({ sheetId, title: '  ' }),
      config({ sheetId, display: 'bar', groupBy: null }),
      config({ sheetId, source: { kind: 'column', column: '1' } }),
      config({ sheetId, source: { kind: 'range', range: 'B2:' } }),
      { ...config({ sheetId }), aggregation: 'median' },
      { ...config({ sheetId }), display: 'radar' },
      config({ sheetId, groupBy: 'A1' }),
    ]) {
      const res = await call(a, 'POST', base, { user: owner, body: bad })
      expect(res.status, JSON.stringify(bad)).toBe(400)
      const body = await json(res)
      expect(body.error).toBe('invalid_widget')
      expect(isArabic(body.message)).toBe(true)
    }

    const first = await call(a, 'POST', base, { user: owner, body: config({ sheetId }) })
    expect(first.status).toBe(201)
    const w1 = await json<WidgetResponse>(first)
    expect(w1.widget).toMatchObject({ position: 0, title: 'المبالغ حسب القسم', groupBy: 'A', source: { kind: 'column', column: 'B' } })
    expect(w1.result).toMatchObject({ ok: true, value: 1550, widgetId: w1.widget.id })
    const w2 = await json<WidgetResponse>(await call(a, 'POST', base, { user: owner, body: config({ sheetId, title: 'عدد البنود', aggregation: 'count', groupBy: null, display: 'kpi', source: { kind: 'column', column: 'b' } }) }))
    expect(w2.widget).toMatchObject({ position: 1, source: { column: 'B' } })

    let d = await json<DashboardResponse>(await call(a, 'GET', `/api/workbooks/${id}/dashboard`, { user: owner }))
    expect(d.widgets.map((w) => w.title)).toEqual(['المبالغ حسب القسم', 'عدد البنود'])
    expect(d.results.map((r) => r.ok && r.value)).toEqual([1550, 4])

    const edited = await call(a, 'PUT', `${base}/${w1.widget.id}`, { user: owner, body: config({ sheetId, title: 'أعلى مبلغ', aggregation: 'max', display: 'donut' }) })
    expect(edited.status).toBe(200)
    expect((await json<WidgetResponse>(edited)).widget).toMatchObject({ id: w1.widget.id, title: 'أعلى مبلغ', display: 'donut', position: 0 })
    expect((await call(a, 'PUT', `${base}/missing`, { user: owner, body: config({ sheetId }) })).status).toBe(404)

    // Reorder: every live id once.
    expect((await call(a, 'PUT', `${base}/order`, { user: owner, body: { ids: [w2.widget.id] } })).status).toBe(409)
    expect((await call(a, 'PUT', `${base}/order`, { user: owner, body: { ids: [w2.widget.id, w2.widget.id] } })).status).toBe(409)
    const order = await json<WidgetListResponse>(await call(a, 'PUT', `${base}/order`, { user: owner, body: { ids: [w2.widget.id, w1.widget.id] } }))
    expect(order.widgets.map((w) => [w.id, w.position])).toEqual([
      [w2.widget.id, 0],
      [w1.widget.id, 1],
    ])

    // Remove: confirmation required; the row stays with removed_at.
    const unconfirmed = await call(a, 'POST', `${base}/${w2.widget.id}/remove`, { user: owner, body: {} })
    expect(unconfirmed.status).toBe(400)
    expect((await json(unconfirmed)).error).toBe('widget_not_confirmed')
    const removed = await json<WidgetListResponse>(await call(a, 'POST', `${base}/${w2.widget.id}/remove`, { user: owner, body: { confirmed: true } }))
    expect(removed.widgets.map((w) => [w.id, w.position])).toEqual([[w1.widget.id, 0]])
    const row = await env.DB.prepare(`SELECT removed_at, removed_by FROM dashboard_widgets WHERE id = ?1`).bind(w2.widget.id).first<{ removed_at: string | null; removed_by: string }>()
    expect(row?.removed_at).not.toBeNull()
    expect(row?.removed_by).toBe(owner.id)
    expect((await call(a, 'POST', `${base}/${w2.widget.id}/remove`, { user: owner, body: { confirmed: true } })).status).toBe(404)
    const audit = await env.DB.prepare(`SELECT action FROM audit_log WHERE workbook_id = ?1 AND action LIKE 'dashboard.%' ORDER BY id`).bind(id).all<{ action: string }>()
    expect(audit.results.map((r) => r.action)).toEqual(['dashboard.widget.create', 'dashboard.widget.create', 'dashboard.widget.update', 'dashboard.widget.reorder', 'dashboard.widget.remove'])

    d = await json<DashboardResponse>(await call(a, 'GET', `/api/workbooks/${id}/dashboard`, { user: owner }))
    expect(d.widgets.map((w) => w.title)).toEqual(['أعلى مبلغ'])
  })
})

describe('permissions', () => {
  it('reading follows opening the workbook; a viewer reads and is refused (403) on every write', async () => {
    const a = app()
    const owner = await seedMember('editor')
    const viewer = await seedMember('editor')
    const editor = await seedMember('editor')
    const platformViewer = await seedMember('viewer')
    const outsider = await seedMember('editor')
    const admin = await seedMember('admin')
    const { id, sheetId } = await plainWorkbook(a, owner, BUDGET)
    await addMember(id, viewer.id, 'viewer', owner.id)
    await addMember(id, editor.id, 'editor', owner.id)
    await addMember(id, platformViewer.id, 'editor', owner.id)
    const base = `/api/workbooks/${id}/dashboard`
    const w = await json<WidgetResponse>(await call(a, 'POST', `${base}/widgets`, { user: owner, body: config({ sheetId }) }))

    expect((await call(a, 'GET', base, { user: outsider })).status).toBe(404)
    expect((await call(a, 'POST', `${base}/preview`, { user: outsider, body: config({ sheetId }) })).status).toBe(404)
    expect((await call(a, 'GET', base)).status).toBe(401)

    for (const reader of [viewer, platformViewer]) {
      const res = await call(a, 'GET', base, { user: reader })
      expect(res.status).toBe(200)
      expect((await json<DashboardResponse>(res)).canEdit).toBe(false)
      const writes = [
        call(a, 'POST', `${base}/widgets`, { user: reader, body: config({ sheetId }) }),
        call(a, 'PUT', `${base}/widgets/${w.widget.id}`, { user: reader, body: config({ sheetId }) }),
        call(a, 'PUT', `${base}/widgets/order`, { user: reader, body: { ids: [w.widget.id] } }),
        call(a, 'POST', `${base}/widgets/${w.widget.id}/remove`, { user: reader, body: { confirmed: true } }),
      ]
      for (const res of await Promise.all(writes)) {
        expect(res.status).toBe(403)
        const body = await json(res)
        expect(body.error).toBe('forbidden')
        expect(isArabic(body.message)).toBe(true)
      }
    }
    for (const writer of [editor, admin]) {
      const res = await call(a, 'GET', base, { user: writer })
      expect((await json<DashboardResponse>(res)).canEdit).toBe(true)
      expect((await call(a, 'PUT', `${base}/widgets/${w.widget.id}`, { user: writer, body: config({ sheetId, title: 'من المحرّر' }) })).status).toBe(200)
    }
    // Still there, unchanged by the refused writes.
    const d = await json<DashboardResponse>(await call(a, 'GET', base, { user: owner }))
    expect(d.widgets).toHaveLength(1)
  })
})

describe('appearance («المظهر»)', () => {
  it('everyone reads the palette; only an admin changes it; values are hex only; low contrast warns; {} restores the defaults', async () => {
    const a = app()
    const admin = await seedMember('admin')
    const editor = await seedMember('editor')
    const read = async (user: { id: string }) => json<AppearanceResponse>(await call(a, 'GET', '/api/appearance', { user }))
    await call(a, 'PUT', '/api/admin/appearance', { user: admin, body: { palette: {} } })
    expect(await read(editor)).toMatchObject({ palette: {}, warnings: [] })
    expect((await call(a, 'GET', '/api/appearance')).status).toBe(401)

    const refused = await call(a, 'PUT', '/api/admin/appearance', { user: editor, body: { palette: { accent: '#336699' } } })
    expect(refused.status).toBe(403)
    expect(isArabic((await json(refused)).message)).toBe(true)

    for (const palette of [{ accent: 'red' }, { accent: '#369' }, { accent: '#33669' }, { accent: 'rgb(1,2,3)' }, { accent: '#3366991' }, { background: '#ffffff' }, { accent: 12 }, 'x', null]) {
      const res = await call(a, 'PUT', '/api/admin/appearance', { user: admin, body: { palette } })
      expect(res.status, JSON.stringify(palette)).toBe(400)
      const body = await json(res)
      expect(body.error).toBe('invalid_palette')
      expect(isArabic(body.message)).toBe(true)
    }
    expect(await read(editor)).toMatchObject({ palette: {} })

    const saved = await json<AppearanceResponse>(await call(a, 'PUT', '/api/admin/appearance', { user: admin, body: { palette: { accent: '#2F6F73', surface: '#FFFFFF', text: '#999999', series1: '#f4f4f4' } } }))
    expect(saved.palette).toEqual({ accent: '#2f6f73', surface: '#ffffff', text: '#999999', series1: '#f4f4f4' })
    expect(saved.warnings.map((w) => `${w.foreground}/${w.background}`).sort()).toEqual(['series1/surface', 'text/surface'])
    expect(saved.updatedAt).not.toBeNull()
    expect((await read(editor)).palette).toEqual(saved.palette)
    const audit = await env.DB.prepare(`SELECT actor_id FROM audit_log WHERE action = 'settings.appearance' ORDER BY id DESC LIMIT 1`).first<{ actor_id: string }>()
    expect(audit?.actor_id).toBe(admin.id)

    const reset = await json<AppearanceResponse>(await call(a, 'PUT', '/api/admin/appearance', { user: admin, body: { palette: {} } }))
    expect(reset).toMatchObject({ palette: {}, warnings: [] })
    expect((await read(editor)).palette).toEqual({})
  })
})
