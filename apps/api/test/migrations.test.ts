import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { seedMember } from './helpers'

const db = () => env.DB
const now = () => new Date().toISOString()

async function rejects(sql: string, ...params: unknown[]): Promise<string> {
  try {
    await db().prepare(sql).bind(...params).run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error(`expected the statement to fail: ${sql}`)
}

async function insertWorkbook(ownerId: string): Promise<string> {
  const id = crypto.randomUUID()
  await db()
    .prepare(
      `INSERT INTO workbooks (id, title, owner_id, source, current_snapshot_version, created_at, updated_at)
       VALUES (?1, 'ملف', ?2, 'blank', 1, ?3, ?3)`,
    )
    .bind(id, ownerId, now())
    .run()
  return id
}

async function insertSheet(workbookId: string, syncMode: 'local' | 'synced' = 'synced'): Promise<string> {
  const id = crypto.randomUUID()
  await db()
    .prepare(
      `INSERT INTO sheets (id, workbook_id, univer_sheet_id, title, position, sync_mode, created_at)
       VALUES (?1, ?2, ?3, 'ورقة 1', 1, ?4, ?5)`,
    )
    .bind(id, workbookId, crypto.randomUUID(), syncMode, now())
    .run()
  return id
}

describe('migrations', () => {
  it('create every table of spec §6.2 (users → members) plus audit_log', async () => {
    const { results } = await db().prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all<{ name: string }>()
    const tables = new Set(results.map((r) => r.name))
    for (const table of [
      'members',
      'workbooks',
      'workbook_members',
      'sheets',
      'column_mappings',
      'tasks',
      'bc_people_cache',
      'bc_account_people_cache',
      'external_contacts',
      'task_assignees',
      'email_notifications',
      'access_requests',
      'attachments',
      'sync_log',
      'import_reports',
      'integrations',
      'user_basecamp_links',
      'bc_webhooks',
      'audit_log',
    ]) {
      expect(tables, table).toContain(table)
    }
    expect(tables).not.toContain('users')
  })

  it('give a new member the viewer role and reject unknown roles', async () => {
    await db().prepare(`INSERT INTO members (user_id, created_at) VALUES ('sub-default-role', 1)`).run()
    const row = await db().prepare(`SELECT role, is_active FROM members WHERE user_id = 'sub-default-role'`).first<{ role: string; is_active: number }>()
    expect(row).toEqual({ role: 'viewer', is_active: 1 })
    expect(await rejects(`INSERT INTO members (user_id, role, created_at) VALUES ('sub-bad-role', 'owner', 1)`)).toMatch(/CHECK/)
  })

  it('enforce CHECK constraints on enumerated columns', async () => {
    const owner = await seedMember('editor')
    expect(
      await rejects(
        `INSERT INTO workbooks (id, title, owner_id, source, current_snapshot_version, created_at, updated_at) VALUES ('w-x', 't', ?1, 'xlsx', 1, 'x', 'x')`,
        owner.id,
      ),
    ).toMatch(/CHECK/)
    expect(
      await rejects(
        `INSERT INTO workbooks (id, title, owner_id, source, current_snapshot_version, created_at, updated_at) VALUES ('w-y', '   ', ?1, 'blank', 1, 'x', 'x')`,
        owner.id,
      ),
    ).toMatch(/CHECK/)

    const workbookId = await insertWorkbook(owner.id)
    expect(
      await rejects(`INSERT INTO workbook_members (workbook_id, user_id, role, added_by, added_at) VALUES (?1, ?2, 'admin', ?2, 'x')`, workbookId, owner.id),
    ).toMatch(/CHECK/)

    // A local sheet is never linked to a Basecamp list.
    expect(
      await rejects(
        `INSERT INTO sheets (id, workbook_id, univer_sheet_id, title, position, sync_mode, bc_todolist_id, created_at) VALUES ('s-x', ?1, 'u', 't', 1, 'local', 42, 'x')`,
        workbookId,
      ),
    ).toMatch(/CHECK/)

    const sheetId = await insertSheet(workbookId)
    expect(await rejects(`INSERT INTO tasks (task_uid, sheet_id, level, created_at) VALUES ('t-l2', ?1, 2, 'x')`, sheetId)).toMatch(/CHECK/)
    // A subtask needs a parent; a to-do has none.
    expect(await rejects(`INSERT INTO tasks (task_uid, sheet_id, level, created_at) VALUES ('t-orphan', ?1, 1, 'x')`, sheetId)).toMatch(/CHECK/)
    expect(await rejects(`INSERT INTO tasks (task_uid, sheet_id, level, sync_state, created_at) VALUES ('t-state', ?1, 0, 'lost', 'x')`, sheetId)).toMatch(/CHECK/)
    // A to-do row cannot be a Basecamp subtask.
    expect(
      await rejects(`INSERT INTO tasks (task_uid, sheet_id, level, bc_recording_id, bc_type, created_at) VALUES ('t-type', ?1, 0, 7, 'subtask', 'x')`, sheetId),
    ).toMatch(/CHECK/)
    expect(await rejects(`INSERT INTO column_mappings (sheet_id, column_key, field) VALUES (?1, 'A', 'priority')`, sheetId)).toMatch(/CHECK/)
    expect(await rejects(`INSERT INTO sync_log (workbook_id, direction, action, actor, status, at) VALUES (?1, 'both', 'x', 'x', 'x', 'x')`, workbookId)).toMatch(
      /CHECK/,
    )
  })

  it('enforce foreign keys to members', async () => {
    expect(
      await rejects(
        `INSERT INTO workbooks (id, title, owner_id, source, current_snapshot_version, created_at, updated_at) VALUES ('w-fk', 't', 'sub-nobody', 'blank', 1, 'x', 'x')`,
      ),
    ).toMatch(/FOREIGN KEY/)
  })

  it('keep a task to one row per Basecamp recording and one assignee entry despite NULL ids', async () => {
    const owner = await seedMember('editor')
    const sheetId = await insertSheet(await insertWorkbook(owner.id))
    const recording = Math.floor(Math.random() * 1e12)
    await db()
      .prepare(`INSERT INTO tasks (task_uid, sheet_id, level, bc_recording_id, bc_type, created_at) VALUES (?1, ?2, 0, ?3, 'todo', 'x')`)
      .bind(crypto.randomUUID(), sheetId, recording)
      .run()
    expect(
      await rejects(`INSERT INTO tasks (task_uid, sheet_id, level, bc_recording_id, bc_type, created_at) VALUES (?1, ?2, 0, ?3, 'todo', 'x')`, crypto.randomUUID(), sheetId, recording),
    ).toMatch(/UNIQUE/)

    const taskUid = crypto.randomUUID()
    await db().prepare(`INSERT INTO tasks (task_uid, sheet_id, level, created_at) VALUES (?1, ?2, 0, 'x')`).bind(taskUid, sheetId).run()
    await db().prepare(`INSERT INTO task_assignees (task_uid, kind, bc_person_id) VALUES (?1, 'bc_person', 5)`).bind(taskUid).run()
    expect(await rejects(`INSERT INTO task_assignees (task_uid, kind, bc_person_id) VALUES (?1, 'bc_person', 5)`, taskUid)).toMatch(/UNIQUE/)
    // An external assignee needs an external contact, not a Basecamp id.
    expect(await rejects(`INSERT INTO task_assignees (task_uid, kind, bc_person_id) VALUES (?1, 'external', 9)`, taskUid)).toMatch(/CHECK/)
  })

  it('make audit_log append-only', async () => {
    await db()
      .prepare(`INSERT INTO audit_log (at, actor_id, action, entity_type, entity_id, details_json) VALUES (?1, NULL, 'test.append', 'test', 'e1', '{}')`)
      .bind(now())
      .run()
    expect(await rejects(`UPDATE audit_log SET action = 'test.changed' WHERE action = 'test.append'`)).toMatch(/append-only/)
    expect(await rejects(`DELETE FROM audit_log WHERE action = 'test.append'`)).toMatch(/append-only/)
    expect(await rejects(`INSERT INTO audit_log (at, action, entity_type, entity_id, details_json) VALUES ('x', 'a', 'b', 'c', 'not json')`)).toMatch(/CHECK/)
  })
})
