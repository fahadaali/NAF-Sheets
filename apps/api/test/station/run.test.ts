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
    await w.run()
    expect(w.subtasks().map((s) => s.title)).toContain('اعتماد قائمة ديسمبر')
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

  it('marks a row whose to-do was deleted in Basecamp, without deleting the row', async () => {
    const w = await world(SOCIAL)
    await w.run()
    const todo = w.todos().find((t) => t.content === 'المناسبات')!
    w.fake.todos.delete(todo.id)
    await w.run()
    expect(w.sheet.tab(TAB).rows.some((r) => r[COL.main] === 'المناسبات')).toBe(true)
    expect([...w.sheet.notes.values()].some((n) => n.startsWith('محذوفة في Basecamp'))).toBe(true)
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

  it('stops the link with an Arabic reason when the file is not shared', async () => {
    const w = await world(SOCIAL)
    w.sheet.shared = false
    const report = await w.run()
    expect(report.status).toBe('stopped')
    expect(report.alerts[0]).toMatchObject({ kind: 'link_stopped' })
    expect((report.alerts[0] as { reason: string }).reason).toContain('naf-sync@naf-sheets-station.iam.gserviceaccount.com')
    expect(writesTo(w.fake)).toBe(0)
  })
})
