// One sync run of one link, both ways (docs/station-plan.md §4).
//
// Called on a Drive notification, a Basecamp webhook, the minute check and
// «مزامنة الآن». Every run does the whole link: read the linked tabs and their
// row identities, read the Basecamp lists (to-dos, and the subtasks of to-dos
// that changed), diff each task with @naf-sheets/sync-engine, write Basecamp
// (the sync account's token, decision 7), then write the sheet once.
//
// Rules this file applies on top of the engine:
// - The sheet owns assignment (decision 2-أ): a people change made in Basecamp
//   is answered by re-sending the sheet's people, with an alert.
// - Deletion is automatic (decision 9-ب), except when a tab reads empty while
//   it had tasks: that is treated as a read problem, nothing is deleted.
// - A subtask's snapshot is stored before its permanent deletion.
// - Records created in Basecamp get new rows in the sheet; the sheet's order
//   is the reference for positions.

import { NotFoundError } from '@naf-sheets/basecamp'
import type { BasecampClient } from '@naf-sheets/basecamp'
import type { InboundAction, LocalTask, OutboundAction, RemoteSubtask, RemoteTask, RemoteTodo, SyncedBase } from '@naf-sheets/shared'
import { baseAfterSubtaskWrite, baseAfterTodoWrite, baseFromRemote, baseWith, diffTask, planDeletion } from '@naf-sheets/sync-engine'
import type { RemoteState } from '@naf-sheets/sync-engine'
import {
  STATUS,
  deletedTasks,
  findColumns,
  inboundEdits,
  isoToSerial,
  readRoles,
  readTab,
  splitNames,
  type CellEdit,
  type CellValue,
  type RowIdentity,
  type StationAlert,
  type TabColumns,
} from '@naf-sheets/station-sheet'
import { GoogleError, googleErrorMessage, type GoogleClient } from './google'
import { baseOf, getLink, getNames, getTabs, getTasks, logStatement, recordAlerts, saveTaskStatement, type TaskRow } from './store'

export type SheetPort = Pick<GoogleClient, 'serviceAccountEmail' | 'spreadsheet' | 'tabValues' | 'rowIdentities' | 'write' | 'insertRows' | 'setNotes' | 'modifiedTime'>

export interface RunDeps {
  db: D1Database
  google: SheetPort
  basecamp: BasecampClient
  /** The sync account's Basecamp token (decision 7). */
  token: string
  now: () => number
  newUid?: () => string
  /** Keeps the link's lease while the run works (src/station/runner.ts); called often, renews at most once a minute. */
  keepLease?: () => Promise<void>
}

export interface RunReport {
  status: 'ok' | 'stopped' | 'skipped'
  toBasecamp: number
  toSheet: number
  deleted: number
  alerts: StationAlert[]
}

const DELETED_NOTE = 'محذوفة في Basecamp. احذف الصف إن لم تعد تحتاجه، أو استرجع المهمة من سلة Basecamp.'

export async function syncLink(linkId: string, deps: RunDeps): Promise<RunReport> {
  const { db, google, basecamp, token } = deps
  const at = (): string => new Date(deps.now()).toISOString()
  const newUid = deps.newUid ?? (() => crypto.randomUUID())
  const report: RunReport = { status: 'ok', toBasecamp: 0, toSheet: 0, deleted: 0, alerts: [] }
  const found0 = await getLink(db, linkId)
  if (!found0 || found0.state !== 'active') return { ...report, status: 'skipped' }
  const link = found0
  const skippedTabs = new Set<string>()
  const alert = (a: StationAlert): void => {
    if (a.kind === 'tab_stopped') skippedTabs.add(a.tab)
    // One name is one problem whatever tabs it appears in: merge its rows.
    if (a.kind === 'name_unmapped') {
      const same = report.alerts.find((x): x is typeof a => x.kind === 'name_unmapped' && x.name === a.name)
      if (same) {
        if (!same.tab.split('، ').includes(a.tab)) same.tab = `${same.tab}، ${a.tab}`
        same.rows += a.rows
        return
      }
    }
    report.alerts.push(a)
  }
  const base = { linkId: link.id, linkTitle: link.title }

  // --- Read the sheet ----------------------------------------------------------
  let modified: string | null = null
  let mappedNames = new Set<string>()
  let values: Map<string, unknown[][]>
  let identities: Awaited<ReturnType<SheetPort['rowIdentities']>>
  let tabs = await getTabs(db, link.id)
  try {
    modified = await google.modifiedTime(link.spreadsheet_id)
    const meta = await google.spreadsheet(link.spreadsheet_id)
    // A renamed tab keeps its id; follow the new title.
    const titleById = new Map(meta.tabs.map((t) => [t.sheetId, t.title]))
    for (const tab of tabs) {
      const now = titleById.get(tab.google_sheet_id)
      if (now !== undefined && now !== tab.title) {
        await db.prepare(`UPDATE station_tabs SET title = ?3 WHERE link_id = ?1 AND google_sheet_id = ?2`).bind(link.id, tab.google_sheet_id, now).run()
        tab.title = now
      }
    }
    const missing = tabs.filter((t) => !titleById.has(t.google_sheet_id))
    for (const t of missing) alert({ kind: 'tab_stopped', ...base, tab: t.title, reason: 'حُذف هذا التبويب من الملف. أعده، أو أزله من الربط في المنصة.' })
    tabs = tabs.filter((t) => titleById.has(t.google_sheet_id))
    const titles = [...tabs.map((t) => t.title), ...(titleById.size > 0 && [...titleById.values()].includes(link.roles_tab) ? [link.roles_tab] : [])]
    values = await google.tabValues(link.spreadsheet_id, titles)
    if (!values.has(link.roles_tab)) {
      alert({ kind: 'link_stopped', ...base, reason: `لا يوجد في الملف تبويب «${link.roles_tab}» الذي تُقرأ منه الأسماء، فتتوقف كل الصفوف التي فيها «القسم». أعد التبويب أو غيّر اسمه في إعدادات الربط.` })
    }
    identities = await google.rowIdentities(link.spreadsheet_id)
  } catch (error) {
    if (!(error instanceof GoogleError)) throw error
    alert({ kind: 'link_stopped', ...base, reason: googleErrorMessage(error.code, google.serviceAccountEmail) })
    await finish('stopped', googleErrorMessage(error.code, google.serviceAccountEmail))
    return { ...report, status: 'stopped' }
  }

  // --- Names ------------------------------------------------------------------
  const { roles } = readRoles((values.get(link.roles_tab) ?? []) as CellValue[][])
  const people = await getNames(db)
  mappedNames = new Set(people.keys())
  const projectPeople = await basecamp.people.listProject(token, link.bc_project_id).all()
  // Notifications reach everyone (owner, 2026-11-15): every member of the
  // project (clients excepted) hears of every completion.
  const notifyIds = projectPeople
    .filter((p) => p.client !== true && (p.personable_type === undefined || p.personable_type === 'User'))
    .map((p) => p.id)
    .sort((x, y) => x - y)
  const notifyKey = notifyIds.join(',')
  const projectIds = new Set(projectPeople.map((p) => p.id))
  const personName = new Map(projectPeople.map((p) => [p.id, p.name]))
  // A name written exactly as a Basecamp person's name is mapped by itself (§6.1).
  const autoNames: D1PreparedStatement[] = []
  for (const name of new Set([...roles.values()].flatMap(splitNames))) {
    if (people.has(name)) continue
    const same = projectPeople.filter((p) => p.name.trim() === name)
    if (same.length === 1) {
      people.set(name, same[0]!.id)
      autoNames.push(
        db.prepare(`INSERT INTO station_names (name, bc_person_id, source, updated_at) VALUES (?1, ?2, 'auto', ?3) ON CONFLICT (name) DO NOTHING`).bind(name, same[0]!.id, at()),
      )
    }
  }
  if (autoNames.length > 0) await db.batch(autoNames)
  mappedNames = new Set(people.keys())
  const allTasks: LocalTask[] = []

  // --- Each tab -----------------------------------------------------------------
  const known = new Map((await getTasks(db, link.id)).map((t) => [t.uid, t]))
  const cellWrites: { tabTitle: string; row: number; column: number; value: string | number | null }[] = []
  const inserts: Parameters<SheetPort['insertRows']>[1] = []
  const notes: Parameters<SheetPort['setNotes']>[1] = []
  const afterSheetWrite: D1PreparedStatement[] = []

  for (const tab of tabs) {
    await deps.keepLease?.()
    const tabValues = (values.get(tab.title) ?? []) as CellValue[][]
    const found = findColumns(tabValues[0] ?? [])
    if (!found.ok) {
      alert({ kind: 'tab_stopped', ...base, tab: tab.title, reason: found.message })
      continue
    }
    const columns = found.columns
    if (tab.bc_todolist_id === null) {
      const list = await basecamp.todolists.create(token, link.bc_todoset_id, { name: tab.title })
      tab.bc_todolist_id = list.id
      await db.prepare(`UPDATE station_tabs SET bc_todolist_id = ?3 WHERE link_id = ?1 AND google_sheet_id = ?2`).bind(link.id, tab.google_sheet_id, list.id).run()
    }
    const listId = tab.bc_todolist_id

    const rowIds = new Map<number, RowIdentity>()
    for (const id of identities) {
      if (id.sheetId !== tab.google_sheet_id) continue
      const k = known.get(id.uid)
      const b = baseOf(k)
      rowIds.set(id.row, {
        uid: id.uid,
        bcId: k?.bc_id ?? null,
        ...(k ? { level: k.level } : {}),
        ...(b ? { carry: { notesHtml: notesOf(b), startsOn: b.startsOn } } : {}),
        ...(k?.deleted_remotely === 1 ? { deletedRemotely: true } : {}),
      })
    }
    const read = readTab({
      values: tabValues,
      columns,
      roles,
      people,
      identities: rowIds,
      newUid,
      sheetId: String(tab.google_sheet_id),
      changedAt: modified,
    })
    allTasks.push(...read.tasks)
    // Grouped per tab: one alert per kind of problem, with its rows.
    const reverted: number[] = []
    const noRole: string[] = []
    const rowOf = (uid: string): number => (read.rows.find((r) => r.uid === uid)?.row ?? -1) + 1
    // New rows get their identity in the sheet before anything is created in
    // Basecamp: a run that fails half-way must find the same uid next time,
    // whose Basecamp id `execute` saved at once, or the row would be created twice.
    if (read.newIdentities.length > 0) {
      const identities = read.newIdentities.map((n) => ({ sheetId: tab.google_sheet_id, row: n.row, uid: n.uid }))
      if (!(await writeOrStop(() => google.write(link.spreadsheet_id, { identities })))) return { ...report, status: 'stopped' }
    }
    for (const f of read.fixes) cellWrites.push({ tabTitle: tab.title, ...f })
    heldAlerts(read.issues, tab.title)

    const knownHere = [...known.values()].filter((t) => t.google_sheet_id === tab.google_sheet_id)
    if (read.rows.length === 0 && knownHere.length > 0) {
      alert({ kind: 'tab_stopped', ...base, tab: tab.title, reason: 'قُرئ التبويب فارغاً وكانت فيه مهام، فلم يُحذف شيء من Basecamp. إن كان الحذف مقصوداً فاحذف الصفوف على دفعات.' })
      continue
    }

    // Remote: the list's to-dos, pending and completed; subtasks of to-dos that changed.
    const remoteTodos = [...(await basecamp.todos.list(token, listId).all()), ...(await basecamp.todos.list(token, listId, { completed: true }).all())]
    const todoById = new Map(remoteTodos.map((t) => [t.id, t]))
    const subtasksByTodo = new Map<number, RemoteSubtask[]>()
    const localByUid = new Map(read.tasks.map((t) => [t.uid, t]))
    for (const todo of remoteTodos) {
      const row = [...known.values()].find((k) => k.bc_id === todo.id)
      const b = baseOf(row)
      const localSubs = read.tasks.filter((t) => t.parentUid === row?.uid)
      const changed =
        !row ||
        b === null ||
        b.remoteUpdatedAt !== todo.updatedAt ||
        row.subtasks_count !== todo.subtasksCount ||
        row.subtasks_done !== todo.subtasksCompletedCount ||
        localSubs.some((s) => s.bcId === null || isDirty(s, baseOf(known.get(s.uid))))
      if (changed && (todo.subtasksCount > 0 || localSubs.length > 0)) subtasksByTodo.set(todo.id, await basecamp.subtasks.list(token, todo.id).all())
    }
    const subtaskById = new Map([...subtasksByTodo.values()].flat().map((s) => [s.id, s]))

    // Diff and write Basecamp, to-dos before their subtasks (sheet order).
    // Every row, held ones included: a held to-do already in Basecamp is still its subtasks' parent.
    const bcIdOf = new Map<string, number | null>(read.rows.map((r) => [r.uid, r.bcId]))
    // A held subtask already in Basecamp keeps its people on its to-do while it waits
    // (a held row never takes anyone off): it counts with its last synced values.
    const heldSubtasks: LocalTask[] = read.rows.flatMap((r) => {
      const b = r.level === 1 && r.parentUid !== null && !localByUid.has(r.uid) ? baseOf(known.get(r.uid)) : null
      if (!b) return []
      const assignees = b.bcAssigneeIds.map((id) => ({ kind: 'bc_person' as const, bcPersonId: id, source: 'manual' as const }))
      const standIn: LocalTask = {
        uid: r.uid,
        sheetId: String(tab.google_sheet_id),
        parentUid: r.parentUid,
        level: 1,
        position: b.position,
        title: b.title,
        assignees,
        dueOn: b.dueOn,
        startsOn: null,
        completed: b.completed,
        notesHtml: null,
        freeColumnsForDescription: {},
        attachments: [],
        assignMode: 'manual',
        localChangedAt: null,
        bcId: r.bcId,
        deletedRemotely: false,
      }
      return [standIn]
    })
    const inbound: InboundAction[] = []
    for (const local of read.tasks) {
      const row = known.get(local.uid)
      const assignFromSheet = row?.assign_from_sheet !== 0 || local.assignees.length > 0
      let b = baseOf(row)
      if (local.level === 1 && !assignFromSheet && b) local.assignees = b.bcAssigneeIds.map((id) => ({ kind: 'bc_person', bcPersonId: id, source: 'manual' }))
      let remote: RemoteState = null
      if (local.bcId !== null) {
        remote = (local.level === 0 ? todoById.get(local.bcId) : subtaskById.get(local.bcId)) ?? null
        if (remote === null && (local.level === 0 || subtasksByTodo.has(parentTodoId(local) ?? -1) || isDirty(local, b))) remote = await fetchOne(local)
        if (remote === null) {
          // Unchanged subtask of an unchanged to-do: nothing to compare, nothing changed locally.
          continue
        }
      }
      // Everyone on the to-do's «When done, notify» list and among its subscribers,
      // once (and again when the project's members change).
      if (local.level === 0 && remote && remote.type === 'todo' && remote.status === 'active' && notifyIds.length > 0 && row?.notify_key !== notifyKey) {
        remote = await ensureNotified(remote)
        afterSheetWrite.push(db.prepare(`UPDATE station_tasks SET notify_key = ?2 WHERE uid = ?1`).bind(local.uid, notifyKey))
      }
      // Decision 2-أ: people changed in Basecamp only → send the sheet's people back.
      // (A to-do in automatic mode takes its subtasks' people; the engine handles it.)
      const sheetOwnsPeople = local.level === 1 ? assignFromSheet : local.assignMode === 'manual'
      if (sheetOwnsPeople && b && remote && remote.type !== 'deleted' && !sameIds(remote.assigneeIds, b.bcAssigneeIds) && sameIds(idsOf(local), b.bcAssigneeIds)) {
        reverted.push(rowOf(local.uid))
        b = { ...b, bcAssigneeIds: [...remote.assigneeIds] }
      }
      // Option أ: a to-do's automatic date (latest of its subtasks) is the sheet's too:
      // changed in Basecamp only → sent back, never written into the to-do's empty cell.
      const autoDue = local.level === 0 && read.autoDue.has(local.uid)
      if (autoDue && b && remote && remote.type === 'todo' && remote.dueOn !== b.dueOn && local.dueOn === b.dueOn) {
        b = { ...b, dueOn: remote.dueOn }
      }
      const parentId = local.level === 1 ? (bcIdOf.get(local.parentUid!) ?? null) : null
      if (local.level === 1 && parentId === null) continue // its to-do is not in Basecamp yet (held)
      const subtasks = local.level === 0 ? [...read.tasks, ...heldSubtasks].filter((t) => t.parentUid === local.uid) : []
      const result = diffTask(local, b, remote, {
        directory: { externalContacts: new Map(), personNames: personName },
        listId,
        parentTodoId: parentId,
        ...(local.level === 0 ? { autoAssign: { subtasks, settings: { enabled: true, excludeCompletedSubtasks: false } } } : {}),
      })
      // Engine contract item 2: the fetched record becomes the base, then outbound writes move it on.
      let next: SyncedBase | null = remote && remote.type !== 'deleted' ? baseFromRemote(local.uid, remote as RemoteTask, b?.position ?? local.position) : b
      for (const action of result.outbound) {
        next = await execute(action, next, local, assignFromSheet)
        report.toBasecamp += 1
        if (action.type === 'create_todo' || action.type === 'create_subtask') bcIdOf.set(local.uid, next!.bcId)
      }
      for (const a of result.inbound) {
        if (autoDue && a.type === 'update_row' && a.fields.dueOn !== undefined) {
          const { dueOn: _auto, ...fields } = a.fields
          if (Object.keys(fields).length > 0) inbound.push({ ...a, fields })
          continue
        }
        inbound.push(a)
      }
      const counts = remote && remote.type === 'todo' ? { c: remote.subtasksCount, d: remote.subtasksCompletedCount } : null
      afterSheetWrite.push(
        saveTaskStatement(db, { uid: local.uid, linkId: link.id, googleSheetId: tab.google_sheet_id, level: local.level, parentUid: local.parentUid, bcId: next?.bcId ?? local.bcId, base: next, assignFromSheet }, at()),
      )
      if (counts) afterSheetWrite.push(db.prepare(`UPDATE station_tasks SET subtasks_count = ?2, subtasks_done = ?3 WHERE uid = ?1`).bind(local.uid, counts.c, counts.d))
    }

    // Basecamp → sheet cells.
    const edits = inboundEdits(read.rows, columns, inbound)
    for (const e of edits.edits) cellWrites.push({ tabTitle: tab.title, ...e })
    for (const s of edits.structural) {
      const r = read.rows.find((x) => 'uid' in s && x.uid === s.uid)
      if (!r) continue
      if (s.type === 'mark_deleted_remotely') {
        notes.push({ sheetId: tab.google_sheet_id, row: r.row, column: r.level === 0 ? columns.main : columns.sub, note: DELETED_NOTE })
        afterSheetWrite.push(db.prepare(`UPDATE station_tasks SET deleted_remotely = 1 WHERE uid = ?1`).bind(s.uid))
      } else if (s.type === 'restore_row') {
        notes.push({ sheetId: tab.google_sheet_id, row: r.row, column: r.level === 0 ? columns.main : columns.sub, note: null })
        afterSheetWrite.push(db.prepare(`UPDATE station_tasks SET deleted_remotely = 0 WHERE uid = ?1`).bind(s.uid))
      }
    }
    report.toSheet += edits.edits.length

    // Records created in Basecamp → new rows.
    const knownBc = new Set([...known.values()].map((k) => k.bc_id).concat(read.tasks.map((t) => t.bcId)).filter((x): x is number => x !== null))
    const lastRow = Math.max(tabValues.length, 1)
    for (const todo of remoteTodos) {
      if (knownBc.has(todo.id) || todo.status !== 'active') continue
      const uid = newUid()
      inserts.push({ sheetId: tab.google_sheet_id, before: lastRow, values: rowValues(columns, { main: todo.content, due: todo.dueOn, completed: todo.completed }), uid })
      afterSheetWrite.push(saveTaskStatement(db, { uid, linkId: link.id, googleSheetId: tab.google_sheet_id, level: 0, parentUid: null, bcId: todo.id, base: baseFromRemote(uid, todo) }, at()))
      const subs = todo.subtasksCount > 0 ? (subtasksByTodo.get(todo.id) ?? (await basecamp.subtasks.list(token, todo.id).all())) : []
      for (const sub of subs) insertSubtask(sub, todo.content, lastRow, uid)
      report.toSheet += 1 + subs.length
    }
    for (const [todoId, subs] of subtasksByTodo) {
      const parent = read.rows.find((r) => r.level === 0 && r.bcId === todoId)
      if (!parent) continue
      const parentTitle = read.tasks.find((t) => t.uid === parent.uid)?.title ?? parent.mainCell
      const lastOfBlock = Math.max(parent.row, ...read.rows.filter((r) => r.parentUid === parent.uid).map((r) => r.row))
      for (const sub of subs) {
        if (knownBc.has(sub.id)) continue
        insertSubtask(sub, parentTitle, lastOfBlock + 1, parent.uid)
        report.toSheet += 1
      }
    }

    function insertSubtask(sub: RemoteSubtask, parentTitle: string, before: number, parentUid: string): void {
      const uid = newUid()
      const role = roleFor(sub.assigneeIds)
      inserts.push({ sheetId: tab.google_sheet_id, before, values: rowValues(columns, { main: parentTitle, sub: sub.title, role, due: sub.dueOn, completed: sub.completed }), uid })
      afterSheetWrite.push(
        saveTaskStatement(db, { uid, linkId: link.id, googleSheetId: tab.google_sheet_id, level: 1, parentUid, bcId: sub.id, base: baseFromRemote(uid, sub), assignFromSheet: role !== '' || sub.assigneeIds.length === 0 }, at()),
      )
      if (role === '' && sub.assigneeIds.length > 0) noRole.push(sub.title)
    }

    if (reverted.length > 0) {
      alert({
        kind: 'rows_held',
        ...base,
        tab: tab.title,
        code: 'people_reverted',
        reason: 'غُيّر المسؤول في Basecamp، والملف هو المرجع للإسناد فأُعيد كما في الملف. لتغيير المسؤول غيّر «القسم» في الملف أو الاسم في «المسميات».',
        rows: reverted.length,
        rowNumbers: reverted.filter((n) => n > 0).sort((a, b) => a - b),
      })
    }
    if (noRole.length > 0) {
      alert({
        kind: 'rows_held',
        ...base,
        tab: tab.title,
        code: 'role_missing',
        reason: `أُضيفت من Basecamp مهام لا يطابق مسؤولوها مسمى في «${link.roles_tab}»، فبقي «القسم» فارغاً: ${noRole.map((t) => `«${t}»`).join('، ')}. اختر لها مسمى في الملف.`,
        rows: noRole.length,
      })
    }

    // Rows gone from the sheet → Basecamp (decision 9-ب).
    const gone = deletedTasks(
      knownHere.map((k) => ({ uid: k.uid, level: k.level, parentUid: k.parent_uid, bcId: k.bc_id })),
      read.rows,
    )
    if (gone.length > 0) {
      const requests = []
      for (const g of gone) {
        let remoteSubtask: RemoteSubtask | null = null
        if (g.task.level === 1 && g.bcId !== null) {
          try {
            remoteSubtask = await basecamp.subtasks.get(token, g.bcId)
          } catch (error) {
            if (!(error instanceof NotFoundError)) throw error
          }
        }
        requests.push({ task: g.task, bcId: remoteSubtask || g.task.level === 0 ? g.bcId : null, remoteSubtask })
      }
      const plan = planDeletion(requests)
      if (!plan.ok) throw new Error(`station: deletion plan refused: ${plan.error.message}`)
      for (const action of plan.value) {
        if (action.type === 'trash_todo') {
          // Already gone from Basecamp (deleted there, or purged from its trash): nothing left to trash.
          await basecamp.todos.trash(token, action.todoId).catch((error: unknown) => {
            if (!(error instanceof NotFoundError)) throw error
          })
        }
        if (action.type === 'delete_subtask') {
          await db
            .prepare(`INSERT INTO station_deleted (uid, link_id, bc_type, bc_id, snapshot_json, deleted_at) VALUES (?1, ?2, 'subtask', ?3, ?4, ?5)`)
            .bind(action.uid, link.id, action.subtaskId, JSON.stringify(action.snapshot), at())
            .run()
          await basecamp.subtasks.deletePermanently(token, action.subtaskId, action.snapshot)
        }
        report.deleted += 1
        await logStatement(db, { linkId: link.id, direction: 'to_basecamp', action: action.type, taskUid: action.uid }, at()).run()
      }
      const removed = gone.map((g) => g.task.uid)
      const children = knownHere.filter((k) => k.parent_uid !== null && removed.includes(k.parent_uid)).map((k) => k.uid)
      for (const uid of [...removed, ...children]) afterSheetWrite.push(db.prepare(`DELETE FROM station_tasks WHERE uid = ?1`).bind(uid))
    }
  }

  // People assigned in the sheet who are not members of the project (§6.2).
  const outside = new Map<number, number>()
  for (const t of allTasks) for (const id of idsOf(t)) if (!projectIds.has(id)) outside.set(id, (outside.get(id) ?? 0) + 1)
  for (const [id, rows] of outside) {
    const name = [...people].find(([, v]) => v === id)?.[0] ?? String(id)
    alert({ kind: 'not_project_member', ...base, personName: name, bcPersonId: id, projectName: link.title, rows })
  }

  // --- Write the sheet once, then the bases ----------------------------------------
  // Cells and notes use the row numbers as read, so both go before the inserts move rows.
  const written = await writeOrStop(async () => {
    await google.write(link.spreadsheet_id, { cells: cellWrites })
    await google.setNotes(link.spreadsheet_id, notes)
    await google.insertRows(link.spreadsheet_id, inserts)
  })
  if (!written) return { ...report, status: 'stopped' }
  if (cellWrites.length + inserts.length > 0) {
    afterSheetWrite.push(logStatement(db, { linkId: link.id, direction: 'to_sheet', action: 'write', detail: { cells: cellWrites.length, rows: inserts.length } }, at()))
  }
  for (let i = 0; i < afterSheetWrite.length; i += 50) await db.batch(afterSheetWrite.slice(i, i + 50))
  await finish('ok', null)
  return report

  // --- helpers ------------------------------------------------------------------------

  /** Runs a sheet write; a Google failure stops the link with its reason (false). */
  async function writeOrStop(fn: () => Promise<void>): Promise<boolean> {
    try {
      await fn()
      return true
    } catch (error) {
      if (!(error instanceof GoogleError)) throw error
      alert({ kind: 'link_stopped', ...base, reason: googleErrorMessage(error.code, google.serviceAccountEmail) })
      await finish('stopped', googleErrorMessage(error.code, google.serviceAccountEmail))
      return false
    }
  }

  function heldAlerts(issues: ReturnType<typeof readTab>['issues'], tab: string): void {
    const groups = new Map<string, { code: string; subject: string; message: string; rows: number[] }>()
    for (const i of issues) {
      if (!i.blocking) continue
      const key = `${i.code}:${i.subject ?? ''}`
      const g = groups.get(key)
      if (g) g.rows.push(i.row + 1)
      else groups.set(key, { code: i.code, subject: i.subject ?? '', message: i.message.replace(/^الصف \d+: /, ''), rows: [i.row + 1] })
    }
    for (const g of groups.values()) {
      if (g.code === 'name_unmapped') {
        const role = [...roles].find(([, names]) => splitNames(names).includes(g.subject))?.[0] ?? ''
        alert({ kind: 'name_unmapped', ...base, tab, role, name: g.subject, rows: g.rows.length, rowNumbers: g.rows })
      } else {
        alert({ kind: 'rows_held', ...base, tab, code: g.code, subject: g.subject, reason: g.message, rows: g.rows.length, rowNumbers: g.rows })
      }
    }
  }

  function roleFor(ids: readonly number[]): string {
    if (ids.length === 0) return ''
    const want = [...ids].sort((a, b) => a - b).join(',')
    const matches = [...roles].filter(([, names]) => {
      const got = splitNames(names).map((n) => people.get(n))
      return !got.includes(undefined) && [...new Set(got as number[])].sort((a, b) => a - b).join(',') === want
    })
    const distinctNames = new Set(matches.map(([, n]) => n))
    return matches.length > 0 && distinctNames.size === 1 ? matches[0]![0] : ''
  }

  function parentTodoId(local: LocalTask): number | null {
    const parent = local.parentUid ? known.get(local.parentUid) : undefined
    return parent?.bc_id ?? null
  }

  async function fetchOne(local: LocalTask): Promise<RemoteState> {
    try {
      return local.level === 0 ? await basecamp.todos.get(token, local.bcId!) : await basecamp.subtasks.get(token, local.bcId!)
    } catch (error) {
      if (error instanceof NotFoundError) return { type: 'deleted' }
      throw error
    }
  }

  async function execute(action: OutboundAction, current: SyncedBase | null, local: LocalTask, assignFromSheet: boolean): Promise<SyncedBase> {
    await deps.keepLease?.()
    const need = (): SyncedBase => {
      if (current === null) throw new Error(`station: ${action.type} without a base`)
      return current
    }
    let next: SyncedBase
    switch (action.type) {
      case 'create_todo': {
        const r: RemoteTodo = await basecamp.todos.create(token, action.listId, action.write)
        next = baseAfterTodoWrite(local.uid, r, action.write, action.position)
        break
      }
      case 'create_subtask': {
        const r: RemoteSubtask = await basecamp.subtasks.create(token, action.parentTodoId, action.create)
        next = baseAfterSubtaskWrite(local.uid, r, action.create, action.position)
        break
      }
      case 'update_todo':
        next = baseAfterTodoWrite(local.uid, await basecamp.todos.update(token, action.todoId, action.write), action.write, need().position)
        break
      case 'update_subtask':
        next = baseAfterSubtaskWrite(local.uid, await basecamp.subtasks.update(token, action.subtaskId, action.patch), action.patch, need().position)
        break
      case 'set_completion':
        if (action.bcType === 'todo') await (action.completed ? basecamp.todos.complete(token, action.bcId) : basecamp.todos.uncomplete(token, action.bcId))
        else await (action.completed ? basecamp.subtasks.complete(token, action.bcId) : basecamp.subtasks.uncomplete(token, action.bcId))
        next = baseWith(need(), { completed: action.completed })
        // Basecamp sends no notification for a subtask's completion: a comment on
        // its to-do reaches the to-do's subscribers (everyone, see ensureNotified).
        if (action.bcType === 'subtask' && action.completed) {
          const todoId = local.parentUid ? (known.get(local.parentUid)?.bc_id ?? null) : null
          if (todoId !== null) {
            await basecamp.comments.create(token, todoId, `<div>أُنجزت المهمة الفرعية «${escapeHtml(local.title)}» (من ملف Google Sheets).</div>`).catch((error: unknown) => {
              console.warn(`station: completion comment failed (${error instanceof Error ? error.name : 'unknown'})`)
            })
          }
        }
        break
      case 'reposition':
        if (action.bcType === 'todo') await basecamp.todos.reposition(token, action.bcId, action.position, action.listId)
        else await basecamp.subtasks.reposition(token, action.bcId, action.position)
        next = baseWith(need(), action.listId !== undefined ? { position: action.position, listId: action.listId } : { position: action.position })
        break
      case 'untrash_todo':
        await basecamp.todos.untrash(token, action.todoId)
        next = need()
        break
      case 'trash_todo':
      case 'delete_subtask':
        throw new Error(`station: ${action.type} outside the deletion path`)
    }
    // Saved at once: a create must never be repeated (engine contract, §9.1).
    await db.batch([
      saveTaskStatement(db, { uid: local.uid, linkId: link!.id, googleSheetId: Number(local.sheetId), level: local.level, parentUid: local.parentUid, bcId: next.bcId, base: next, assignFromSheet }, at()),
      logStatement(db, { linkId: link!.id, direction: 'to_basecamp', action: action.type, taskUid: local.uid }, at()),
    ])
    return next
  }

  /** Adds the project's members to the to-do's completion list and subscribers. Returns the to-do as it is now. */
  async function ensureNotified(todo: RemoteTodo): Promise<RemoteTodo> {
    let current = todo
    const missing = notifyIds.filter((id) => !todo.completionSubscriberIds.includes(id))
    if (missing.length > 0) {
      // A full PUT (it clears what it omits), with the record's own values and no new notification.
      const updated = await basecamp.todos.update(token, todo.id, {
        content: todo.content,
        descriptionHtml: todo.descriptionHtml,
        assigneeIds: [...todo.assigneeIds],
        completionSubscriberIds: [...new Set([...todo.completionSubscriberIds, ...notifyIds])],
        dueOn: todo.dueOn,
        startsOn: todo.startsOn,
        notify: false,
      })
      current = { ...updated, position: todo.position }
    }
    await basecamp.recordings.subscribe(token, todo.id, notifyIds)
    return current
  }

  async function finish(status: 'ok' | 'stopped', error: string | null): Promise<void> {
    await db
      .prepare(`UPDATE station_links SET last_sync_at = ?2, last_error = ?3, last_modified = COALESCE(?4, last_modified), updated_at = ?2 WHERE id = ?1`)
      .bind(link!.id, at(), error, status === 'ok' ? modified : null)
      .run()
    await recordAlerts(db, link!.id, report.alerts, mappedNames, at(), { complete: status === 'ok', skippedTabs })
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function notesOf(b: SyncedBase): string | null {
  return b.notesHtml
}

function idsOf(t: LocalTask): number[] {
  return t.assignees.flatMap((a) => (a.kind === 'external' ? [] : [a.bcPersonId]))
}

function sameIds(a: readonly number[], b: readonly number[]): boolean {
  const x = [...new Set(a)].sort((p, q) => p - q)
  const y = [...new Set(b)].sort((p, q) => p - q)
  return x.length === y.length && x.every((v, i) => v === y[i])
}

/** A synced field of the row differs from the last synced base (or there is none). */
function isDirty(t: LocalTask, b: SyncedBase | null): boolean {
  if (b === null) return true
  return t.title.trim() !== b.title.trim() || t.dueOn !== b.dueOn || t.completed !== b.completed || !sameIds(idsOf(t), b.bcAssigneeIds)
}

function rowValues(
  columns: TabColumns,
  v: { main: string; sub?: string; role?: string; due: string | null; completed: boolean },
): (string | number | null)[] {
  const width = Math.max(columns.main, columns.sub, columns.role, columns.status, columns.due) + 1
  const out: (string | number | null)[] = Array.from({ length: width }, () => null)
  out[columns.main] = v.main
  if (v.sub !== undefined) {
    out[columns.sub] = v.sub
    out[columns.status] = v.completed ? STATUS.done : STATUS.notStarted
    if (v.role) out[columns.role] = v.role
  } else if (v.completed) {
    out[columns.status] = STATUS.done
  }
  out[columns.due] = v.due ? isoToSerial(v.due) : null
  return out
}

export type { CellEdit, TaskRow }
