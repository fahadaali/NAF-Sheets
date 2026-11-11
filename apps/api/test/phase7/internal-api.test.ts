// The internal API (spec §13): /api/v1/* behind service tokens, never a
// naf-id session; tokens issued and revoked by platform admins only.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { ApiTokenListResponse, CreateApiTokenResponse, V1StatsResponse, V1TasksResponse, V1WorkbooksResponse } from '@naf-sheets/shared'
import { DASHBOARD_SHEET_ID } from '@naf-sheets/shared'
import { dayOf, statusOf } from '../../src/phase7'
import { readSnapshot } from '../../src/snapshot'
import { call, isArabic, json, seedMember, testApp } from '../helpers'
import { harness, setupLinked } from '../sync/harness'

const app = testApp()

async function issueToken(admin: { id: string }, name = 'لوحة ناف'): Promise<CreateApiTokenResponse> {
  const res = await call(app, 'POST', '/api/admin/api-tokens', { user: admin, body: { name } })
  expect(res.status).toBe(201)
  return json<CreateApiTokenResponse>(res)
}

function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` }
}

describe('service tokens', () => {
  it('only an admin issues, lists and revokes them; the secret is shown once and only its hash is stored', async () => {
    const admin = await seedMember('admin')
    const editor = await seedMember('editor')
    expect((await call(app, 'POST', '/api/admin/api-tokens', { user: editor, body: { name: 'x' } })).status).toBe(403)
    expect((await call(app, 'GET', '/api/admin/api-tokens', { user: editor })).status).toBe(403)
    const bad = await call(app, 'POST', '/api/admin/api-tokens', { user: admin, body: { name: '  ' } })
    expect(bad.status).toBe(400)
    expect(isArabic((await json(bad)).message)).toBe(true)

    const issued = await issueToken(admin)
    expect(issued.secret).toMatch(/^nafs_[A-Za-z0-9_-]{43}$/)
    expect(issued.token.prefix).toBe(issued.secret.slice(0, 10))
    const stored = await env.DB.prepare('SELECT * FROM api_tokens WHERE id = ?1').bind(issued.token.id).first<Record<string, unknown>>()
    expect(JSON.stringify(stored)).not.toContain(issued.secret)
    expect(String(stored?.token_hash)).toMatch(/^[0-9a-f]{64}$/)
    const audit = await env.DB.prepare(`SELECT details_json FROM audit_log WHERE entity_id = ?1`).bind(issued.token.id).all<{ details_json: string }>()
    expect(JSON.stringify(audit.results)).not.toContain(issued.secret)

    const list = await json<ApiTokenListResponse>(await call(app, 'GET', '/api/admin/api-tokens', { user: admin }))
    expect(JSON.stringify(list)).not.toContain(issued.secret)
    expect(list.tokens.find((t) => t.id === issued.token.id)).toMatchObject({ name: 'لوحة ناف', revokedAt: null })

    expect((await call(app, 'GET', '/api/v1/workbooks', { headers: bearer(issued.secret) })).status).toBe(200)
    const revoked = await call(app, 'POST', `/api/admin/api-tokens/${issued.token.id}/revoke`, { user: admin })
    expect((await json<{ revokedAt: string | null }>(revoked)).revokedAt).not.toBeNull()
    expect((await call(app, 'GET', '/api/v1/workbooks', { headers: bearer(issued.secret) })).status).toBe(401)
    // Never deleted.
    expect(await env.DB.prepare('SELECT id FROM api_tokens WHERE id = ?1').bind(issued.token.id).first()).not.toBeNull()
    expect((await call(app, 'POST', `/api/admin/api-tokens/missing/revoke`, { user: admin })).status).toBe(404)
  })
})

describe('/api/v1', () => {
  it('refuses a request without a live token (Arabic, WWW-Authenticate), and a naf-id session is not enough', async () => {
    const admin = await seedMember('admin')
    for (const headers of [{}, bearer('nafs_wrong'), bearer('not-a-token'), { authorization: 'Basic abc' }]) {
      const res = await call(app, 'GET', '/api/v1/workbooks', { headers })
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toBe('Bearer')
      const body = await json<{ error: string; message: string }>(res)
      expect(body.error).toBe('unauthorized')
      expect(isArabic(body.message)).toBe(true)
    }
    // A signed-in admin without a token is refused too.
    expect((await call(app, 'GET', '/api/v1/stats', { user: admin })).status).toBe(401)
    const { secret } = await issueToken(admin)
    const unknown = await call(app, 'GET', '/api/v1/nothing', { headers: bearer(secret) })
    expect(unknown.status).toBe(404)
    expect(unknown.headers.get('cache-control')).toBe('no-store')
  })

  it('lists workbooks, filters tasks by status, assignee and due date, and counts them in stats', async () => {
    const h = harness()
    const l = await setupLinked(h, {
      people: ['سارة'],
      rows: [
        { title: 'مهمة متأخرة', assignees: 'سارة', due: '2020-01-05' },
        { title: 'مهمة منجزة', assignees: 'سارة', due: '2020-01-05', done: true },
        { title: 'مهمة قادمة', due: '2099-01-05' },
        { title: 'بلا تاريخ' },
      ],
      service: true,
    })
    const sara = l.people['سارة']!
    const { secret } = await issueToken(l.admin!)
    const v1 = (path: string) => call(h.app, 'GET', path, { env: h.env, headers: bearer(secret) })

    const workbooks = await json<V1WorkbooksResponse>(await v1('/api/v1/workbooks'))
    const mine = workbooks.workbooks.find((w) => w.id === l.wbId)
    expect(mine).toMatchObject({ bcProjectId: l.project.id, sheetCount: 1, syncState: 'synced' })
    expect(mine).not.toHaveProperty('access')

    const all = await json<V1TasksResponse>(await v1(`/api/v1/workbooks/${l.wbId}/tasks`))
    expect(all.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // The workbook carries the dashboard tab «اللوحة» (first); it holds no task and is no sheet here.
    const stored = (await readSnapshot(h.env, l.wbId, (await h.env.DB.prepare('SELECT current_snapshot_version AS v FROM workbooks WHERE id = ?1').bind(l.wbId).first<{ v: number }>())!.v)) as { sheetOrder: string[] }
    expect(stored.sheetOrder[0]).toBe(DASHBOARD_SHEET_ID)
    expect(all.tasks).toHaveLength(4)
    expect(all.tasks.every((t) => t.sheetTitle === 'ورقة 1')).toBe(true)
    const byTitle = new Map(all.tasks.map((t) => [t.title, t]))
    expect(byTitle.get('مهمة متأخرة')).toMatchObject({ status: 'overdue', completed: false, dueOn: '2020-01-05', level: 0, syncState: 'synced', sheetTitle: 'ورقة 1' })
    expect(byTitle.get('مهمة متأخرة')?.assignees).toEqual([{ kind: 'bc_person', id: String(sara.id), name: 'سارة' }])
    expect(byTitle.get('مهمة متأخرة')?.bcId).toEqual(expect.any(Number))
    expect(byTitle.get('مهمة منجزة')?.status).toBe('done')
    expect(byTitle.get('مهمة قادمة')?.status).toBe('open')
    expect(byTitle.get('بلا تاريخ')?.status).toBe('open')

    const titles = async (query: string) => (await json<V1TasksResponse>(await v1(`/api/v1/workbooks/${l.wbId}/tasks?${query}`))).tasks.map((t) => t.title).sort()
    expect(await titles('status=overdue')).toEqual(['مهمة متأخرة'])
    expect(await titles('status=done')).toEqual(['مهمة منجزة'])
    expect(await titles(`assignee=${sara.id}`)).toEqual(['مهمة متأخرة', 'مهمة منجزة'].sort())
    expect(await titles('due_before=2050-01-01')).toEqual(['مهمة متأخرة', 'مهمة منجزة'].sort())
    expect(await titles(`status=open&due_before=2100-01-01`)).toEqual(['مهمة قادمة'])

    for (const bad of ['status=late', 'due_before=2026-13-01', 'due_before=tomorrow']) {
      const res = await v1(`/api/v1/workbooks/${l.wbId}/tasks?${bad}`)
      expect(res.status, bad).toBe(400)
      expect(isArabic((await json(res)).message)).toBe(true)
    }
    expect((await v1('/api/v1/workbooks/missing/tasks')).status).toBe(404)

    const stats = await json<V1StatsResponse>(await v1('/api/v1/stats'))
    expect(stats.workbooks).toBeGreaterThanOrEqual(1)
    expect(stats.totals.tasks).toBeGreaterThanOrEqual(4)
    expect(stats.totals.tasks).toBe(stats.totals.done + stats.totals.open + stats.totals.overdue)
    const saraStats = stats.byAssignee.find((a) => a.kind === 'bc_person' && a.id === String(sara.id))
    expect(saraStats).toMatchObject({ name: 'سارة', tasks: 2, done: 1, overdue: 1, open: 0 })
  })
})

describe('helpers', () => {
  it('judges overdue strictly before today, and today in Riyadh time', () => {
    expect(statusOf({ completed: false, dueOn: '2026-11-09' }, '2026-11-10')).toBe('overdue')
    expect(statusOf({ completed: false, dueOn: '2026-11-10' }, '2026-11-10')).toBe('open')
    expect(statusOf({ completed: true, dueOn: '2020-01-01' }, '2026-11-10')).toBe('done')
    expect(statusOf({ completed: false, dueOn: null }, '2026-11-10')).toBe('open')
    // 22:30 UTC is already the next day in Riyadh (UTC+3).
    expect(dayOf(new Date('2026-11-10T22:30:00Z'))).toBe('2026-11-11')
    expect(dayOf(new Date('2026-11-10T20:30:00Z'))).toBe('2026-11-10')
  })
})
