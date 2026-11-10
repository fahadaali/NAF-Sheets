import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { WorkbookMembersResponse } from '@naf-sheets/shared'
import { addMember, call, createWorkbook, isArabic, json, seedMember, testApp } from './helpers'

const app = testApp()

interface AuditRow {
  actor_id: string
  action: string
  entity_type: string
  entity_id: string
  workbook_id: string
  details_json: string
}

async function membershipAudit(workbookId: string): Promise<AuditRow[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM audit_log WHERE workbook_id = ?1 AND action = 'workbook.members.replace' ORDER BY id`)
    .bind(workbookId)
    .all<AuditRow>()
  return results
}

async function expectApiError(res: Response, status: number, error: string) {
  expect(res.status).toBe(status)
  const body = await json(res)
  expect(body).toMatchObject({ ok: false, error })
  expect(isArabic(body.message)).toBe(true)
}

describe('GET/PUT /api/workbooks/:id/members', () => {
  it('lets the owner read and replace the list; every change is audited', async () => {
    const owner = await seedMember('editor')
    const ali = await seedMember('editor')
    const sara = await seedMember('viewer')
    const id = await createWorkbook(app, owner)

    const empty = await call(app, 'GET', `/api/workbooks/${id}/members`, { user: owner })
    expect(empty.status).toBe(200)
    expect(await empty.json()).toEqual({ ownerId: owner.id, members: [] })

    const put = await call(app, 'PUT', `/api/workbooks/${id}/members`, {
      user: owner,
      body: { members: [{ userId: ali.id, role: 'editor' }, { userId: sara.id, role: 'viewer' }] },
    })
    expect(put.status).toBe(200)
    const listed = await json<WorkbookMembersResponse>(put)
    expect(listed.ownerId).toBe(owner.id)
    expect(listed.members).toHaveLength(2)
    expect(listed.members).toEqual(
      expect.arrayContaining([
        { userId: ali.id, name: ali.name, email: ali.email, role: 'editor' },
        { userId: sara.id, name: sara.name, email: sara.email, role: 'viewer' },
      ]),
    )

    let audit = await membershipAudit(id)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actor_id: owner.id, entity_type: 'workbook', entity_id: id })
    const first = JSON.parse(audit[0]!.details_json) as { added: unknown[]; changed: unknown[]; removed: unknown[] }
    expect(first.added).toEqual(expect.arrayContaining([{ userId: ali.id, role: 'editor' }, { userId: sara.id, role: 'viewer' }]))
    expect(first.changed).toEqual([])
    expect(first.removed).toEqual([])

    // Change Ali's role, remove Sara.
    const replace = await call(app, 'PUT', `/api/workbooks/${id}/members`, { user: owner, body: { members: [{ userId: ali.id, role: 'viewer' }] } })
    expect(replace.status).toBe(200)
    expect((await json<WorkbookMembersResponse>(replace)).members).toEqual([{ userId: ali.id, name: ali.name, email: ali.email, role: 'viewer' }])

    audit = await membershipAudit(id)
    expect(audit).toHaveLength(2)
    expect(JSON.parse(audit[1]!.details_json)).toEqual({
      added: [],
      changed: [{ userId: ali.id, from: 'editor', to: 'viewer' }],
      removed: [{ userId: sara.id, role: 'viewer' }],
    })

    // The same list again changes nothing and logs nothing.
    expect((await call(app, 'PUT', `/api/workbooks/${id}/members`, { user: owner, body: { members: [{ userId: ali.id, role: 'viewer' }] } })).status).toBe(200)
    expect(await membershipAudit(id)).toHaveLength(2)

    const { results } = await env.DB.prepare('SELECT user_id, role FROM workbook_members WHERE workbook_id = ?1').bind(id).all()
    expect(results).toEqual([{ user_id: ali.id, role: 'viewer' }])
  })

  it('grants what the list says: a new editor can save, a new viewer cannot', async () => {
    const owner = await seedMember('editor')
    const editor = await seedMember('editor')
    const reader = await seedMember('editor')
    const id = await createWorkbook(app, owner)
    await call(app, 'PUT', `/api/workbooks/${id}/members`, {
      user: owner,
      body: { members: [{ userId: editor.id, role: 'editor' }, { userId: reader.id, role: 'viewer' }] },
    })
    const save = (user: { id: string }) => call(app, 'PUT', `/api/workbooks/${id}/snapshot`, { user, body: { baseVersion: 1, snapshot: { by: user.id } } })
    expect((await save(reader)).status).toBe(403)
    expect((await save(editor)).status).toBe(200)
  })

  it('lets an admin manage any workbook', async () => {
    const owner = await seedMember('editor')
    const admin = await seedMember('admin')
    const someone = await seedMember('editor')
    const id = await createWorkbook(app, owner)
    expect((await call(app, 'GET', `/api/workbooks/${id}/members`, { user: admin })).status).toBe(200)
    const res = await call(app, 'PUT', `/api/workbooks/${id}/members`, { user: admin, body: { members: [{ userId: someone.id, role: 'editor' }] } })
    expect(res.status).toBe(200)
    expect((await membershipAudit(id))[0]?.actor_id).toBe(admin.id)
  })

  it('refuses members who are not the owner (403), and hides the workbook from outsiders (404)', async () => {
    const owner = await seedMember('editor')
    const editor = await seedMember('editor')
    const outsider = await seedMember('editor')
    const id = await createWorkbook(app, owner)
    await addMember(id, editor.id, 'editor', owner.id)
    const body = { members: [{ userId: outsider.id, role: 'editor' }] }

    await expectApiError(await call(app, 'GET', `/api/workbooks/${id}/members`, { user: editor }), 403, 'forbidden')
    await expectApiError(await call(app, 'PUT', `/api/workbooks/${id}/members`, { user: editor, body }), 403, 'forbidden')
    await expectApiError(await call(app, 'GET', `/api/workbooks/${id}/members`, { user: outsider }), 404, 'not_found')
    await expectApiError(await call(app, 'PUT', `/api/workbooks/${id}/members`, { user: outsider, body }), 404, 'not_found')
    expect(await membershipAudit(id)).toHaveLength(0)
  })

  it('keeps an owner demoted to platform viewer read-only here too', async () => {
    const owner = await seedMember('editor')
    const other = await seedMember('editor')
    const id = await createWorkbook(app, owner)
    await env.DB.prepare(`UPDATE members SET role = 'viewer' WHERE user_id = ?1`).bind(owner.id).run()
    await expectApiError(
      await call(app, 'PUT', `/api/workbooks/${id}/members`, { user: owner, body: { members: [{ userId: other.id, role: 'viewer' }] } }),
      403,
      'forbidden',
    )
  })

  it('validates the list and writes nothing when it is invalid', async () => {
    const owner = await seedMember('editor')
    const ali = await seedMember('editor')
    const id = await createWorkbook(app, owner)
    const put = (body: unknown) => call(app, 'PUT', `/api/workbooks/${id}/members`, { user: owner, body })

    await expectApiError(await put({}), 400, 'invalid_members')
    await expectApiError(await put({ members: [{ userId: ali.id, role: 'admin' }] }), 400, 'invalid_members')
    await expectApiError(await put({ members: [{ userId: '', role: 'viewer' }] }), 400, 'invalid_members')
    await expectApiError(
      await put({
        members: [
          { userId: ali.id, role: 'viewer' },
          { userId: ali.id, role: 'editor' },
        ],
      }),
      400,
      'invalid_members',
    )
    await expectApiError(await put({ members: [{ userId: owner.id, role: 'editor' }] }), 400, 'owner_in_members')
    await expectApiError(await put({ members: [{ userId: 'sub-never-signed-in', role: 'viewer' }] }), 400, 'unknown_user')

    const { results } = await env.DB.prepare('SELECT * FROM workbook_members WHERE workbook_id = ?1').bind(id).all()
    expect(results).toEqual([])
    expect(await membershipAudit(id)).toHaveLength(0)
  })
})
