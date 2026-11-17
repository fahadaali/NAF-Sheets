// The station's sync run, end to end: a fake Google sheet shaped like
// «الاتصال المؤسسي والتسويق» and the fake Basecamp. Nothing remote is called.

import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { createBasecampClient } from '@naf-sheets/basecamp'
import { syncLink } from '../../src/station/run'
import { seedMember } from '../helpers'
import { FakeBasecamp, uniqueId, type FakePerson, type FakeSubtask, type FakeTodo } from '../support/fake-basecamp'
import { FakeSheet } from './fake-sheet'

const ROLES = [
  ['المسمى', 'الاسم (اكتبه هنا)', 'ما يتولاه'],
  ['الاعتمادات', 'فهد العتيبي - عمر العمار', ''],
  ['مسؤول السوشل ميديا', 'عمر العمار', ''],
  ['المحامي الرئيسي', 'عبدالرحمن العاطفي', ''],
  ['مسؤول منصة اعتماد', 'مسند المحمدي', ''],
]
const HEADER = ['المهمة الرئيسية', 'المهمة', 'القسم', 'الحالة', 'الموعد', 'الاسم']
const TAB = 'السوشل ميديا'
const COL = { main: 0, sub: 1, role: 2, status: 3, due: 4 }

interface World {
  fake: FakeBasecamp
  sheet: FakeSheet
  linkId: string
  people: Record<'fahad' | 'omar' | 'atifi' | 'musnad', FakePerson>
  run: () => ReturnType<typeof syncLink>
  todos: () => FakeTodo[]
  subtasks: () => FakeSubtask[]
}

async function world(rows: (string | number | null)[][]): Promise<World> {
  const fake = new FakeBasecamp(uniqueId())
  const people = {
    fahad: fake.person('Fahad Alotaibi', { admin: true }),
    omar: fake.person('عمر أبو عمار'),
    atifi: fake.person('عبدالرحمن العاطفي'),
    musnad: fake.person('مسند السبيعي'),
  }
  const project = fake.project('الاتصال المؤسسي', Object.values(people).map((p) => p.id))
  const token = fake.token(people.fahad.id)
  const basecamp = createBasecampClient({ accountId: fake.accountId, fetch: fake.fetch, limiter: { acquire: async () => {} }, sleep: async () => {} })
  const admin = await seedMember('admin')
  const linkId = crypto.randomUUID()
  const at = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO station_links (id, spreadsheet_id, title, bc_project_id, bc_todoset_id, notify_secret, created_by, created_at, updated_at)
       VALUES (?1, 'SID', 'الاتصال المؤسسي والتسويق', ?2, ?3, ?4, ?5, ?6, ?6)`,
    ).bind(linkId, project.id, project.todosetId, crypto.randomUUID(), admin.id, at),
    env.DB.prepare(`INSERT INTO station_tabs (link_id, google_sheet_id, title) VALUES (?1, 2, ?2)`).bind(linkId, TAB),
    env.DB.prepare(`DELETE FROM station_names`),
    env.DB.prepare(`DELETE FROM station_alerts`),
    env.DB.prepare(`INSERT INTO station_names (name, bc_person_id, source, updated_at) VALUES ('فهد العتيبي', ?1, 'manual', ?3), ('عمر العمار', ?2, 'manual', ?3)`).bind(
      people.fahad.id,
      people.omar.id,
      at,
    ),
  ])
  const sheet = new FakeSheet()
  sheet.addTab(1, 'المسميات', ROLES)
  sheet.addTab(2, TAB, [HEADER, ...rows])
  let n = 0
  return {
    fake,
    sheet,
    linkId,
    people,
    run: () => syncLink(linkId, { db: env.DB, google: sheet, basecamp, token, now: () => Date.now(), newUid: () => `${linkId}-u${++n}` }),
    todos: () => [...fake.todos.values()].filter((t) => t.status === 'active'),
    subtasks: () => [...fake.subtasks.values()],
  }
}

const SOCIAL: (string | number | null)[][] = [
  ['فيديو الموشن'],
  ['فيديو الموشن', 'بناء بنك أفكار للموشن', 'مسؤول السوشل ميديا', 'لم تبدأ', 46338],
  ['فيديو الموشن', 'اعتماد بنك الأفكار', 'الاعتمادات', 'لم تبدأ', null],
  ['المناسبات'],
  ['المناسبات', 'اعتماد قائمة نوفمبر', 'المحامي الرئيسي', 'جارية', 46338],
]

const writesTo = (fake: FakeBasecamp): number => fake.calls.filter((c) => c.method !== 'GET').length

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM station_alerts`).run()
})

describe('first sync', () => {
  it('creates the list, to-dos and subtasks with people from «المسميات», and maps exact names by itself', async () => {
    const w = await world(SOCIAL)
    const report = await w.run()
    expect(report.status).toBe('ok')
    const lists = [...w.fake.lists.values()]
    expect(lists.map((l) => l.name)).toEqual([TAB])
    expect(w.todos().map((t) => t.content)).toEqual(['فيديو الموشن', 'المناسبات'])
    const subs = w.subtasks()
    expect(subs.map((s) => s.title)).toEqual(['بناء بنك أفكار للموشن', 'اعتماد بنك الأفكار', 'اعتماد قائمة نوفمبر'])
    expect(subs[0]!.assigneeIds).toEqual([w.people.omar.id])
    expect([...subs[1]!.assigneeIds].sort()).toEqual([w.people.fahad.id, w.people.omar.id].sort())
    expect(subs[0]!.dueOn).toBe('2026-11-12')
    // «عبدالرحمن العاطفي» is written exactly as in Basecamp: mapped automatically.
    expect(subs[2]!.assigneeIds).toEqual([w.people.atifi.id])
    const auto = await env.DB.prepare(`SELECT source FROM station_names WHERE name = 'عبدالرحمن العاطفي'`).first<{ source: string }>()
    expect(auto?.source).toBe('auto')
    // A to-do with no title takes its subtasks' people (spec §8.1).
    expect([...w.todos()[0]!.assigneeIds].sort()).toEqual([w.people.fahad.id, w.people.omar.id].sort())
    // Every row now has its identity.
    expect(w.sheet.tab(TAB).ids.slice(1).every((id) => id !== null)).toBe(true)
  })

  it('never creates a row twice when a run fails half-way', async () => {
    const w = await world(SOCIAL)
    // The third create fails for good (a 400 is not retried): the first two are in Basecamp.
    let creates = 0
    w.fake.fail((c) => c.method === 'POST' && /\/(todos|subtasks)\.json$/.test(c.path) && ++creates === 3, 400, { times: 1 })
    await expect(w.run()).rejects.toThrow()
    const before = w.todos().length + w.subtasks().length
    expect(before).toBeGreaterThan(0)
    await w.run()
    // Every row exactly once, nothing trashed.
    expect(w.todos().map((t) => t.content).sort()).toEqual(['المناسبات', 'فيديو الموشن'])
    expect(w.subtasks().map((t) => t.title).sort()).toEqual(['اعتماد بنك الأفكار', 'اعتماد قائمة نوفمبر', 'بناء بنك أفكار للموشن'])
    expect([...w.fake.todos.values()].filter((t) => t.status !== 'active')).toEqual([])
  })

  it('does nothing on a second run with nothing changed', async () => {
    const w = await world(SOCIAL)
    await w.run()
    await w.run() // puts everyone on the to-dos' notifications (once)
    const before = writesTo(w.fake)
    const writes = w.sheet.writes
    const report = await w.run()
    expect(report.toBasecamp).toBe(0)
    // To-dos take their subtasks' people automatically: no false «people changed» alert.
    expect(report.alerts).toEqual([])
    expect(writesTo(w.fake)).toBe(before)
    expect(w.sheet.writes).toBe(writes)
  })
})

describe('sheet → Basecamp', () => {
  it('sends a done status, a new date and a renamed subtask', async () => {
    const w = await world(SOCIAL)
    await w.run()
    w.sheet.set(TAB, 2, COL.status, 'منجزة')
    w.sheet.set(TAB, 2, COL.due, '2026/12/01')
    w.sheet.set(TAB, 2, COL.sub, 'بناء بنك أفكار الموشن')
    await w.run()
    const sub = w.subtasks().find((s) => s.title === 'بناء بنك أفكار الموشن')!
    expect(sub.completed).toBe(true)
    expect(sub.dueOn).toBe('2026-12-01')
  })

  it('reassigns when «القسم» changes', async () => {
    const w = await world(SOCIAL)
    await w.run()
    w.sheet.set(TAB, 2, COL.role, 'المحامي الرئيسي')
    await w.run()
    expect(w.subtasks()[0]!.assigneeIds).toEqual([w.people.atifi.id])
  })

  it('creates a row added in the sheet', async () => {
    const w = await world(SOCIAL)
    await w.run()
    w.sheet.set(TAB, 6, COL.main, 'المناسبات')
    w.sheet.set(TAB, 6, COL.sub, 'اعتماد قائمة ديسمبر')
    w.sheet.set(TAB, 6, COL.status, 'لم تبدأ')
    // No «القسم» yet: held, with an alert, never sent with nobody on it.
    const held = await w.run()
    expect(w.subtasks().map((s) => s.title)).not.toContain('اعتماد قائمة ديسمبر')
    expect(held.alerts).toContainEqual(expect.objectContaining({ kind: 'rows_held', code: 'role_empty', rowNumbers: [7] }))
    w.sheet.set(TAB, 6, COL.role, 'المحامي الرئيسي')
    await w.run()
    expect(w.subtasks().find((s) => s.title === 'اعتماد قائمة ديسمبر')?.assigneeIds).toEqual([w.people.atifi.id])
  })

  it('deletes automatically: a subtask for good (snapshot kept), a to-do to the trash with its subtasks', async () => {
    const w = await world(SOCIAL)
    await w.run()
    const [first] = w.subtasks()
    w.sheet.deleteRows(TAB, 2) // «بناء بنك أفكار للموشن»
    await w.run()
    expect(w.fake.subtasks.has(first!.id)).toBe(false)
    const kept = await env.DB.prepare(`SELECT snapshot_json FROM station_deleted WHERE bc_id = ?1`).bind(first!.id).first<{ snapshot_json: string }>()
    expect(JSON.parse(kept!.snapshot_json).title).toBe('بناء بنك أفكار للموشن')

    const events = [...w.fake.todos.values()].find((t) => t.content === 'المناسبات')!
    const tab = w.sheet.tab(TAB)
    const at = tab.rows.findIndex((r) => r[0] === 'المناسبات')
    w.sheet.deleteRows(TAB, at, 2)
    await w.run()
    expect(w.fake.todos.get(events.id)!.status).toBe('trashed')
  })

  it('lets go of a row deleted from the sheet whose to-do is already gone from Basecamp', async () => {
    const w = await world(SOCIAL)
    await w.run()
    const events = w.todos().find((t) => t.content === 'المناسبات')!
    w.fake.todos.delete(events.id)
    await w.run()
    // The row (and its subtask row) is then deleted from the sheet: no error, nothing left to do.
    w.sheet.deleteRows(TAB, 4, 2)
    const report = await w.run()
    expect(report.status).toBe('ok')
    const again = await w.run()
    expect(again.status).toBe('ok')
    expect(again.deleted).toBe(0)
  })

  it('never deletes when a tab reads empty', async () => {
    const w = await world(SOCIAL)
    await w.run()
    w.sheet.deleteRows(TAB, 1, 5)
    const report = await w.run()
    expect(w.todos()).toHaveLength(2)
    expect(report.alerts.map((a) => a.kind)).toContain('tab_stopped')
  })
})

describe('Basecamp → sheet', () => {
  it('writes completion («جارية» when undone) and a renamed to-do into every row of its block', async () => {
    const w = await world(SOCIAL)
    await w.run()
    const sub = w.subtasks().find((s) => s.title === 'اعتماد قائمة نوفمبر')!
    sub.completed = true
    sub.updatedAt = w.fake.tick()
    const todo = w.todos().find((t) => t.content === 'المناسبات')!
    todo.updatedAt = w.fake.tick()
    await w.run()
    const tab = w.sheet.tab(TAB)
    expect(tab.rows[5]![COL.status]).toBe('منجزة')

    sub.completed = false
    sub.updatedAt = w.fake.tick()
    todo.updatedAt = w.fake.tick()
    await w.run()
    expect(tab.rows[5]![COL.status]).toBe('جارية')

    const motion = w.todos().find((t) => t.content === 'فيديو الموشن')!
    motion.content = 'فيديو الموشن القصير'
    motion.updatedAt = w.fake.tick()
    await w.run()
    expect(tab.rows.slice(1, 4).map((r) => r[COL.main])).toEqual(['فيديو الموشن القصير', 'فيديو الموشن القصير', 'فيديو الموشن القصير'])
  })

  it('writes a title from Basecamp as text, never as a number, a date or a formula', async () => {
    const w = await world(SOCIAL)
    await w.run()
    const tab = w.sheet.tab(TAB)
    const sub = w.subtasks().find((s) => s.title === 'اعتماد قائمة نوفمبر')!
    const todo = w.todos().find((t) => t.content === 'المناسبات')!
    for (const title of ['15%', '2026-11-17', '=SUM(1,2)', '- مراجعة']) {
      sub.title = title
      sub.updatedAt = w.fake.tick()
      todo.updatedAt = w.fake.tick()
      await w.run()
      expect(tab.rows[5]![COL.sub]).toBe(title)
      // Read back unchanged: nothing goes back to Basecamp.
      await w.run()
      expect(w.subtasks().find((s) => s.id === sub.id)!.title).toBe(title)
    }
  })

  it('brings a subtask edited in Basecamp to the sheet on the full pass, even when its to-do did not change', async () => {
    const w = await world(SOCIAL)
    await w.run()
    await w.run()
    const sub = w.subtasks().find((x) => x.title === 'اعتماد قائمة نوفمبر')!
    sub.title = 'اعتماد قائمة ديسمبر'
    sub.dueOn = '2026-12-20'
    sub.updatedAt = w.fake.tick()
    await w.run()
    const tab = w.sheet.tab(TAB)
    expect(tab.rows[5]![COL.sub]).toBe('اعتماد قائمة نوفمبر') // its to-do looks unchanged: not read yet
    await env.DB.prepare(`UPDATE station_links SET last_full_at = ?2 WHERE id = ?1`).bind(w.linkId, new Date(Date.now() - 16 * 60_000).toISOString()).run()
    await w.run()
    expect(tab.rows[5]![COL.sub]).toBe('اعتماد قائمة ديسمبر')
    expect(tab.rows[5]![COL.due]).toBe(46376)
  })

  it('puts back the sheet’s people when they are changed in Basecamp, and tells the admin', async () => {
    const w = await world(SOCIAL)
    await w.run()
    const sub = w.subtasks()[0]!
    sub.assigneeIds = [w.people.musnad.id]
    sub.updatedAt = w.fake.tick()
    w.todos()[0]!.updatedAt = w.fake.tick()
    const report = await w.run()
    expect(w.subtasks()[0]!.assigneeIds).toEqual([w.people.omar.id])
    expect(report.alerts.some((a) => a.kind === 'rows_held' && a.code === 'people_reverted')).toBe(true)
    // Raised once, by that run: it stays open until it is emailed, then the next run closes it.
    await w.run()
    expect(await openAlerts(w.linkId)).toEqual([{ key: expect.stringContaining(':people_reverted:'), emailed: false }])
    await env.DB.prepare(`UPDATE station_alerts SET emailed_at = ?1 WHERE link_id = ?2`).bind(new Date().toISOString(), w.linkId).run()
    await w.run()
    expect(await openAlerts(w.linkId)).toEqual([])
  })

  it('adds rows for a to-do created in Basecamp, its subtasks under it, with «القسم» from the people', async () => {
    const w = await world(SOCIAL)
    await w.run()
    const listId = [...w.fake.lists.values()][0]!.id
    const todo = w.fake.addTodo(listId, { content: 'النشرات الطارئة' })
    w.fake.addSubtask(todo.id, { title: 'كتابة آلية النشرات', assigneeIds: [w.people.omar.id], dueOn: '2026-11-20' })
    todo.updatedAt = w.fake.tick()
    await w.run()
    const rows = w.sheet.tab(TAB).rows
    expect(rows.slice(-2).map((r) => [r[COL.main], r[COL.sub] ?? null, r[COL.role] ?? null])).toEqual([
      ['النشرات الطارئة', null, null],
      ['النشرات الطارئة', 'كتابة آلية النشرات', 'مسؤول السوشل ميديا'],
    ])
    // The next run gives the new to-do its subtasks' people (§8.1, automatic mode)…
    const before = w.fake.calls.length
    await w.run()
    const writes = w.fake.calls.slice(before).filter((c) => c.method !== 'GET')
    // …and puts the project's members on its notifications.
    expect(new Set(writes.map((c) => `${c.method} ${c.path}`))).toEqual(new Set([`PUT /todos/${todo.id}.json`, `PUT /recordings/${todo.id}/subscription.json`]))
    expect(w.fake.todos.get(todo.id)!.assigneeIds).toEqual([w.people.omar.id])
    // …and after that nothing changes: the new rows are known.
    const settled = writesTo(w.fake)
    await w.run()
    expect(writesTo(w.fake)).toBe(settled)
  })

  it('keeps the people of a to-do created in Basecamp: «القسم» from them, or Basecamp’s people while none matches', async () => {
    const w = await world(SOCIAL)
    await w.run()
    const listId = [...w.fake.lists.values()][0]!.id
    const known = w.fake.addTodo(listId, { content: 'متابعة الإعلانات', assigneeIds: [w.people.omar.id] })
    const unknown = w.fake.addTodo(listId, { content: 'مراجعة العقود', assigneeIds: [w.people.musnad.id] })
    const report = await w.run()
    const rows = w.sheet.tab(TAB).rows
    expect(rows.find((r) => r[COL.main] === 'متابعة الإعلانات')![COL.role]).toBe('مسؤول السوشل ميديا')
    expect(rows.find((r) => r[COL.main] === 'مراجعة العقود')![COL.role] ?? '').toBe('')
    expect(report.alerts).toContainEqual(expect.objectContaining({ kind: 'rows_held', code: 'role_missing' }))
    await w.run()
    await w.run()
    expect(w.fake.todos.get(known.id)!.assigneeIds).toEqual([w.people.omar.id])
    expect(w.fake.todos.get(unknown.id)!.assigneeIds).toEqual([w.people.musnad.id])
  })

  it('marks a row whose to-do was deleted in Basecamp, without deleting the row', async () => {
    const w = await world(SOCIAL)
    await w.run()
    const todo = w.todos().find((t) => t.content === 'المناسبات')!
    w.fake.todos.delete(todo.id)
    await w.run()
    const tab = w.sheet.tab(TAB)
    // §4.2 (owner, 2026-11-17): «الحالة» says so and the row's text is struck through.
    expect(tab.rows[4]![COL.main]).toBe('المناسبات')
    expect(tab.rows[4]![COL.status]).toBe('محذوفة في Basecamp')
    expect([COL.main, COL.sub, COL.role, COL.status, COL.due].every((c) => w.sheet.struck.has(`2:4:${c}`))).toBe(true)
    // Marked once: later runs leave the file alone (each edit would start another run).
    const version = w.sheet.version
    await w.run()
    await w.run()
    expect(w.sheet.version).toBe(version)
  })

  it('writes the previous status back and unstrikes the row when the record comes back from the trash', async () => {
    const w = await world(SOCIAL)
    await w.run()
    const tab = w.sheet.tab(TAB)
    const todo = w.todos().find((t) => t.content === 'المناسبات')!
    todo.status = 'trashed'
    todo.updatedAt = w.fake.tick()
    await w.run()
    expect(tab.rows[4]![COL.status]).toBe('محذوفة في Basecamp')
    todo.status = 'active'
    todo.updatedAt = w.fake.tick()
    await w.run()
    expect(tab.rows[4]![COL.status] ?? null).toBe(null) // a to-do row had no status
    expect([...w.sheet.struck].filter((k) => k.startsWith('2:4:'))).toEqual([])
  })

  it('puts the mark on the right row when rows are inserted above it in the same run', async () => {
    const w = await world(SOCIAL)
    await w.run()
    const motion = w.todos().find((t) => t.content === 'فيديو الموشن')!
    w.fake.addSubtask(motion.id, { title: 'مهمة من Basecamp' })
    motion.updatedAt = w.fake.tick()
    w.fake.todos.delete(w.todos().find((t) => t.content === 'المناسبات')!.id)
    await w.run()
    const tab = w.sheet.tab(TAB)
    const marked = [...new Set([...w.sheet.struck].map((k) => Number(k.split(':')[1])))]
    expect(marked.map((row) => tab.rows[row]![COL.main])).toEqual(['المناسبات'])
    expect(marked.map((row) => tab.rows[row]![COL.sub] ?? null)).toEqual([null])
  })
})

describe('held rows', () => {
  it('keeps syncing the subtasks of a to-do that is held but already in Basecamp', async () => {
    const w = await world(SOCIAL)
    await w.run()
    w.sheet.set(TAB, 1, COL.role, 'مسمى غير موجود') // the to-do is held from now on
    w.sheet.set(TAB, 2, COL.sub, 'بنك أفكار الموشن')
    await w.run()
    expect(w.subtasks().map((x) => x.title)).toContain('بنك أفكار الموشن')
  })

  it('never takes a held subtask’s people off its to-do', async () => {
    const w = await world(SOCIAL)
    await w.run()
    const motion = w.todos().find((t) => t.content === 'فيديو الموشن')!
    const people = [...motion.assigneeIds].sort()
    expect(people).toEqual([w.people.fahad.id, w.people.omar.id].sort())
    w.sheet.set(TAB, 3, COL.due, 'غداً') // «اعتماد بنك الأفكار» (فهد، عمر) is held
    w.sheet.set(TAB, 2, COL.status, 'جارية')
    await w.run()
    expect([...w.fake.todos.get(motion.id)!.assigneeIds].sort()).toEqual(people)
  })
})

describe('copies and cleared titles (owner, 2026-11-17)', () => {
  it('never creates a pasted copy of a task twice; it waits with an alert', async () => {
    const w = await world(SOCIAL)
    await w.run()
    const before = w.subtasks().length
    w.sheet.set(TAB, 6, COL.main, 'المناسبات')
    w.sheet.set(TAB, 6, COL.sub, 'اعتماد قائمة نوفمبر')
    w.sheet.set(TAB, 6, COL.role, 'المحامي الرئيسي')
    const report = await w.run()
    await w.run()
    expect(w.subtasks()).toHaveLength(before)
    expect(report.alerts).toContainEqual(expect.objectContaining({ kind: 'rows_held', code: 'copy_of_existing', rowNumbers: [7] }))
  })

  it('does not delete a subtask whose title cells were emptied; it comes back when the title does', async () => {
    const w = await world(SOCIAL)
    await w.run()
    const sub = w.subtasks().find((x) => x.title === 'اعتماد قائمة نوفمبر')!
    w.sheet.set(TAB, 5, COL.main, '')
    w.sheet.set(TAB, 5, COL.sub, '')
    const report = await w.run()
    expect(w.fake.subtasks.has(sub.id)).toBe(true)
    expect(report.deleted).toBe(0)
    expect(report.alerts).toContainEqual(expect.objectContaining({ kind: 'rows_held', code: 'titles_cleared', rowNumbers: [6] }))
    w.sheet.set(TAB, 5, COL.main, 'المناسبات')
    w.sheet.set(TAB, 5, COL.sub, 'اعتماد قائمة نوفمبر المعدّلة')
    await w.run()
    expect(w.fake.subtasks.get(sub.id)!.title).toBe('اعتماد قائمة نوفمبر المعدّلة')
  })
})

describe('a subtask row moved under another to-do', () => {
  it('stops that row with an alert, and leaves Basecamp as it was', async () => {
    const w = await world(SOCIAL)
    await w.run()
    const sub = w.subtasks().find((x) => x.title === 'بناء بنك أفكار للموشن')!
    const parent = sub.todoId
    w.sheet.moveRow(TAB, 2, 5) // from «فيديو الموشن» to the end of «المناسبات»
    const report = await w.run()
    expect(report.alerts).toContainEqual(expect.objectContaining({ kind: 'rows_held', code: 'subtask_moved', rows: 1, rowNumbers: [6] }))
    expect(w.fake.subtasks.get(sub.id)!.todoId).toBe(parent)
  })
})

describe('notifications reach everyone', () => {
  it('puts every project member on each to-do’s completion list and subscribers, once', async () => {
    const w = await world(SOCIAL)
    await w.run()
    await w.run()
    const everyone = Object.values(w.people).map((p) => p.id).sort((x, y) => x - y)
    for (const todo of w.todos()) {
      expect([...todo.completionSubscriberIds].sort((x, y) => x - y)).toEqual(everyone)
      expect([...(w.fake.subscribers.get(todo.id) ?? [])].sort((x, y) => x - y)).toEqual(everyone)
    }
    // Done once: the next run writes nothing.
    const before = writesTo(w.fake)
    await w.run()
    expect(writesTo(w.fake)).toBe(before)
  })

  it('comments on the to-do when a subtask is completed from the sheet, not when completed in Basecamp', async () => {
    const w = await world(SOCIAL)
    await w.run()
    await w.run()
    const motion = w.todos().find((t) => t.content === 'فيديو الموشن')!
    w.sheet.set(TAB, 2, COL.status, 'منجزة')
    await w.run()
    expect(w.subtasks().find((x) => x.title === 'بناء بنك أفكار للموشن')!.completed).toBe(true)
    expect(w.fake.commentsOf(motion.id).map((c) => c.content)).toEqual(['<div>أُنجزت المهمة الفرعية «بناء بنك أفكار للموشن» (من ملف Google Sheets).</div>'])

    // Completed in Basecamp: Basecamp notifies by itself; no comment from the station.
    const other = w.subtasks().find((x) => x.title === 'اعتماد بنك الأفكار')!
    other.completed = true
    other.updatedAt = w.fake.tick()
    motion.updatedAt = w.fake.tick()
    await w.run()
    expect(w.fake.commentsOf(motion.id)).toHaveLength(1)
  })
})

describe('to-do due date (option أ)', () => {
  it('is the latest subtask date, follows changes, and is put back when changed in Basecamp only', async () => {
    const w = await world(SOCIAL)
    await w.run()
    const events = () => w.todos().find((t) => t.content === 'المناسبات')!
    const motion = () => w.todos().find((t) => t.content === 'فيديو الموشن')!
    expect(motion().dueOn).toBe('2026-11-12') // one dated subtask, one undated
    expect(events().dueOn).toBe('2026-11-12')

    // A later subtask date in the sheet moves the to-do.
    w.sheet.set(TAB, 5, COL.due, '2026/12/20')
    await w.run()
    expect(events().dueOn).toBe('2026-12-20')

    // Changed on the to-do in Basecamp: put back, and the to-do's row stays empty.
    events().dueOn = '2027-01-01'
    events().updatedAt = w.fake.tick()
    await w.run()
    expect(events().dueOn).toBe('2026-12-20')
    expect(w.sheet.tab(TAB).rows[4]![COL.due] ?? null).toBeNull()

    // A date written in the to-do's own row wins.
    w.sheet.set(TAB, 4, COL.due, '2026/11/30')
    await w.run()
    expect(events().dueOn).toBe('2026-11-30')
  })
})

describe('problems', () => {
  it('holds a row whose name is not mapped and opens one alert for it', async () => {
    const w = await world([...SOCIAL, ['المناسبات', 'متابعة منصة اعتماد', 'مسؤول منصة اعتماد', 'لم تبدأ', null]])
    const report = await w.run()
    expect(w.subtasks().map((s) => s.title)).not.toContain('متابعة منصة اعتماد')
    const name = report.alerts.find((a) => a.kind === 'name_unmapped')
    expect(name).toMatchObject({ name: 'مسند المحمدي', role: 'مسؤول منصة اعتماد', rows: 1 })
    const open = await env.DB.prepare(`SELECT key FROM station_alerts WHERE resolved_at IS NULL`).all<{ key: string }>()
    expect(open.results.map((r) => r.key)).toContain('name_unmapped:مسند المحمدي')

    // Mapped in the platform → the row goes, and the alert is resolved.
    await env.DB.prepare(`INSERT INTO station_names (name, bc_person_id, source, updated_at) VALUES ('مسند المحمدي', ?1, 'manual', ?2)`).bind(w.people.musnad.id, new Date().toISOString()).run()
    await w.run()
    expect(w.subtasks().find((s) => s.title === 'متابعة منصة اعتماد')!.assigneeIds).toEqual([w.people.musnad.id])
    const resolved = await env.DB.prepare(`SELECT resolved_at FROM station_alerts WHERE key = 'name_unmapped:مسند المحمدي'`).first<{ resolved_at: string | null }>()
    expect(resolved?.resolved_at).not.toBeNull()
  })

  it('reports a title written twice in «المسميات» with different names, and keeps the first', async () => {
    const w = await world(SOCIAL)
    w.sheet.tab('المسميات').rows.push(['مسؤول السوشل ميديا', 'فهد العتيبي', ''])
    const report = await w.run()
    expect(report.alerts).toContainEqual(expect.objectContaining({ kind: 'roles_conflict', role: 'مسؤول السوشل ميديا', names: ['عمر العمار', 'فهد العتيبي'] }))
    expect(w.subtasks().find((x) => x.title === 'بناء بنك أفكار للموشن')!.assigneeIds).toEqual([w.people.omar.id])
  })

  it('stops the link with an Arabic reason when the file is not shared', async () => {
    const w = await world(SOCIAL)
    w.sheet.shared = false
    const report = await w.run()
    expect(report.status).toBe('stopped')
    expect(report.alerts[0]).toMatchObject({ kind: 'link_stopped' })
    expect((report.alerts[0] as { reason: string }).reason).toContain('naf-sync@naf-sheets-station.iam.gserviceaccount.com')
    expect(writesTo(w.fake)).toBe(0)
  })

  it('keeps the other problems while a run is stopped, so they are not emailed twice', async () => {
    const w = await world([...SOCIAL, ['جديدة', 'بلا اسم', 'مسمى غير موجود', '', null]])
    await w.run()
    const held = await openAlerts(w.linkId)
    expect(held.length).toBe(1)
    await env.DB.prepare(`UPDATE station_alerts SET emailed_at = ?1 WHERE link_id = ?2`).bind(new Date().toISOString(), w.linkId).run()
    w.sheet.shared = false
    await w.run()
    w.sheet.shared = true
    await w.run()
    // The held rows' problem never closed, so it is still the emailed one; the stop closed with the good run.
    expect(await openAlerts(w.linkId)).toEqual([{ key: held[0]!.key, emailed: true }])
  })

  it('emails a stop again when it comes back after a good run', async () => {
    const w = await world(SOCIAL)
    w.sheet.shared = false
    await w.run()
    await env.DB.prepare(`UPDATE station_alerts SET emailed_at = ?1 WHERE link_id = ?2`).bind(new Date().toISOString(), w.linkId).run()
    w.sheet.shared = true
    await w.run()
    expect(await openAlerts(w.linkId)).toEqual([])
    w.sheet.shared = false
    await w.run()
    expect(await openAlerts(w.linkId)).toEqual([{ key: `link_stopped:${w.linkId}`, emailed: false }])
  })
})

async function openAlerts(linkId: string): Promise<{ key: string; emailed: boolean }[]> {
  const { results } = await env.DB.prepare(`SELECT key, emailed_at FROM station_alerts WHERE link_id = ?1 AND resolved_at IS NULL ORDER BY key`)
    .bind(linkId)
    .all<{ key: string; emailed_at: string | null }>()
  return results.map((r) => ({ key: r.key, emailed: r.emailed_at !== null }))
}
