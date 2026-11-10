// The link wizard's two calls (spec §7.3): preview computes only; commit
// links the workbook and starts the sync («بدء المزامنة»).
//
// Only the owner or a platform admin may link, and only a workbook that is
// not linked yet. Every Basecamp call uses the caller's own token (§3).
// Nothing in Basecamp is ever deleted by linking. A commit interrupted after
// it created something in Basecamp leaves the workbook `linking` with what it
// created, and the next commit resumes instead of creating it again.

import { ForbiddenError, NotFoundError, findTodosetId } from '@naf-sheets/basecamp'
import type { BasecampClient, RawTodolist } from '@naf-sheets/basecamp'
import type { LinkPlan, LinkPreviewResponse, LinkWorkbookResponse, RemoteTodo, SheetPlan } from '@naf-sheets/shared'
import { ensureSystemColumns } from '@naf-sheets/sheet-model'
import type { WorkbookSnapshot } from '@naf-sheets/sheet-model'
import type { Caller } from '../../access'
import { auditStatement } from '../../audit'
import { LinkFailure, withUserToken } from '../../basecamp-link'
import { projectError } from '../../basecamp-link/people'
import type { Env } from '../../env'
import { readSnapshot } from '../../snapshot'
import { readClient, syncContext } from '../deps'
import type { SyncDeps } from '../deps'
import { enqueueTasks } from '../detect'
import { loadDirectory } from '../directory'
import { SyncFailure } from '../errors'
import { localFingerprint } from '../fingerprint'
import { ensureProjectWebhook } from '../inbound/webhooks'
import type { WebhookStatus } from '../inbound/webhooks'
import { LINK_WARNINGS } from '../messages'
import { loadWorkbookState, mappingStatements, readSheet } from '../state'
import { assigneeStatements, getWorkbookSync, runBatches, sheetsOf } from '../store'
import type { SheetRow, WorkbookSyncRow } from '../store'
import { updateLatestSnapshot } from '../workbook-writer'
import { analyzeSheet, matchByTitle, parseLinkPlan, unmatchedAssignees } from './plan'
import type { SheetAnalysis } from './plan'

export { parseLinkPlan }

interface Prepared {
  wb: WorkbookSyncRow
  sheets: SheetRow[]
  plan: LinkPlan
  snapshot: WorkbookSnapshot
  analyses: SheetAnalysis[]
}

async function prepare(env: Env, workbookId: string, body: unknown): Promise<Prepared> {
  const wb = await getWorkbookSync(env.DB, workbookId)
  if (!wb) throw new SyncFailure('not_linked')
  if (wb.link_state === 'linked') throw new SyncFailure('already_linked')
  const sheets = await sheetsOf(env.DB, workbookId)
  const plan = parseLinkPlan(body, sheets)
  const snapshot = (await readSnapshot(env, workbookId, wb.current_snapshot_version)) as WorkbookSnapshot | null
  if (!snapshot || typeof snapshot.sheets !== 'object' || snapshot.sheets === null) throw new SyncFailure('snapshot_unavailable')
  const byId = new Map(sheets.map((s) => [s.id, s]))
  const analyses = plan.sheets.filter((p) => p.mode !== 'local').map((p) => analyzeSheet(snapshot, byId.get(p.sheetId) as SheetRow, p))
  return { wb, sheets, plan, snapshot, analyses }
}

async function listTodos(client: BasecampClient, token: string, listId: number): Promise<RemoteTodo[]> {
  try {
    return [...(await client.todos.list(token, listId).all()), ...(await client.todos.list(token, listId, { completed: true }).all())]
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) throw new SyncFailure('todolist_not_found')
    throw error
  }
}

/** POST /api/workbooks/:id/link/preview — reads Basecamp with the caller's token, writes nothing. */
export async function previewLink(env: Env, deps: SyncDeps, caller: Caller, workbookId: string, body: unknown): Promise<LinkPreviewResponse> {
  const { plan, analyses } = await prepare(env, workbookId, body)
  const needsBasecamp = plan.project.mode === 'existing'
  const reads = new Map<string, RemoteTodo[]>()
  let people: Array<{ id: number; name: string }> = []
  if (needsBasecamp) {
    const ctx = syncContext(env, deps)
    const client = readClient(ctx)
    const projectId = (plan.project as { projectId: number }).projectId
    await withUserToken(ctx, caller.id, async (token) => {
      try {
        people = (await client.people.listProject(token, projectId).all()).map((p) => ({ id: p.id, name: typeof p.name === 'string' ? p.name : '' }))
      } catch (error) {
        throw projectError(error)
      }
      for (const a of analyses) {
        if (a.plan.mode === 'existing' && a.plan.existingTasks === 'match_by_title' && a.plan.todolistId !== undefined) {
          reads.set(a.sheet.id, await listTodos(client, token, a.plan.todolistId))
        }
      }
    })
  } else {
    // A project to create has no members yet: the account's people are the candidates.
    people = (await loadDirectory(env.DB, null)).assignee.people.map((p) => ({ id: p.id, name: p.name }))
  }
  const directory = await loadDirectory(env.DB, null)
  return {
    sheets: analyses.map((a) => {
      const todos = reads.get(a.sheet.id)
      const matched = todos ? matchByTitle(a, todos) : { matches: [], warnings: [] }
      const warnings = [...a.warnings, ...matched.warnings]
      if (todos && todos.length > matched.matches.length) warnings.push(LINK_WARNINGS.existingTodosKept(todos.length - matched.matches.length))
      const todosCount = a.rows.filter((r) => r.level === 0).length
      return {
        sheetId: a.sheet.id,
        todosToCreate: todosCount - matched.matches.length,
        subtasksToCreate: a.rows.length - todosCount,
        proposedMatches: matched.matches.map((m) => ({ rowNumber: m.row + 1, title: m.title, todoId: m.todoId, todoTitle: m.todoTitle })),
        unmatchedAssignees: unmatchedAssignees(a.assigneeTexts, a.plan, people, directory.assignee.externals),
        warnings,
      }
    }),
  }
}

/** POST /api/workbooks/:id/link — commits the plan. */
export async function commitLink(env: Env, deps: SyncDeps, caller: Caller, workbookId: string, body: unknown): Promise<LinkWorkbookResponse> {
  const prepared = await prepare(env, workbookId, body)
  const { wb, plan, analyses } = prepared
  const db = env.DB
  const at = new Date(deps.now()).toISOString()

  if (plan.project.mode === 'none') {
    // «بدون ربط الآن»: every sheet stays local.
    return { bcProjectId: null, sheets: plan.sheets.map((s) => ({ sheetId: s.sheetId, bcTodolistId: null, queuedTasks: 0 })) }
  }

  const ctx = syncContext(env, deps)
  const client = readClient(ctx)
  const lists = new Map<string, number>()
  const listTodosBySheet = new Map<string, RemoteTodo[]>()
  let projectId = 0
  await withUserToken(ctx, caller.id, async (token) => {
    projectId = await resolveProject(env, client, token, caller, wb, plan, at)
    let todosetId: number | null = null
    const todoset = async (): Promise<number> => {
      if (todosetId !== null) return todosetId
      try {
        todosetId = findTodosetId(await client.projects.get(token, projectId))
      } catch (error) {
        throw projectError(error)
      }
      if (todosetId === null) throw new LinkFailure('todoset_disabled')
      return todosetId
    }
    for (const a of analyses) {
      if (a.plan.mode === 'existing') {
        const listId = a.plan.todolistId as number
        const taken = await db
          .prepare(`SELECT id FROM sheets WHERE bc_todolist_id = ?1 AND id <> ?2`)
          .bind(listId, a.sheet.id)
          .first<{ id: string }>()
        if (taken) throw new SyncFailure('todolist_taken')
        let list: RawTodolist
        try {
          list = await client.todolists.get(token, listId)
        } catch (error) {
          if (error instanceof NotFoundError || error instanceof ForbiddenError) throw new SyncFailure('todolist_not_found')
          throw error
        }
        if (list.bucket?.id !== projectId || list.status !== 'active') throw new SyncFailure('todolist_not_found')
        lists.set(a.sheet.id, listId)
        if (a.plan.existingTasks === 'match_by_title') listTodosBySheet.set(a.sheet.id, await listTodos(client, token, listId))
      } else if (a.sheet.bc_todolist_id !== null) {
        // Created by an interrupted commit: reused, never created twice.
        lists.set(a.sheet.id, a.sheet.bc_todolist_id)
      } else {
        const list = await client.todolists.create(token, await todoset(), { name: a.sheet.title })
        await db.batch([
          db.prepare(`UPDATE sheets SET sync_mode = 'synced', bc_todolist_id = ?2 WHERE id = ?1`).bind(a.sheet.id, list.id),
          auditStatement(
            db,
            { actorId: caller.id, action: 'workbook.link.list_created', entityType: 'sheet', entityId: a.sheet.id, workbookId: wb.id, details: { bcTodolistId: list.id, bcProjectId: projectId } },
            at,
          ),
        ])
        lists.set(a.sheet.id, list.id)
      }
    }
  })

  // --- System columns in the snapshot (sheet-model `ensureSystemColumns`, through updateLatestSnapshot).
  const written = await updateLatestSnapshot<Map<string, Array<{ row: number; uid: string }>> | string>(env, wb.id, caller.id, (latest) => {
    const workbook = structuredClone(latest) as WorkbookSnapshot
    const assigned = new Map<string, Array<{ row: number; uid: string }>>()
    for (const a of analyses) {
      const sheet = workbook.sheets[a.sheet.univer_sheet_id]
      if (!sheet) return { snapshot: null, result: `الورقة «${a.sheet.title}» غير موجودة في محتوى الملف` }
      const ensured = ensureSystemColumns(sheet, a.plan, () => crypto.randomUUID(), a.levels ? { levels: a.levels } : {})
      if (!ensured.ok) return { snapshot: null, result: ensured.error.message }
      workbook.sheets[a.sheet.univer_sheet_id] = ensured.value.sheet as WorkbookSnapshot['sheets'][string]
      assigned.set(a.sheet.id, ensured.value.assigned)
    }
    return { snapshot: workbook, result: assigned }
  })
  if (written.status === 'contended') throw new SyncFailure('link_contended')
  if (written.status === 'not_found') throw new SyncFailure('snapshot_unavailable')
  if (typeof written.result === 'string') throw new SyncFailure('invalid_plan', written.result)

  // --- Sheets and column mappings.
  const setup: D1PreparedStatement[] = []
  for (const a of analyses) {
    setup.push(
      ...mappingStatements(db, a.sheet.id, a.plan),
      db
        .prepare(`UPDATE sheets SET sync_mode = 'synced', bc_todolist_id = ?2, header_row = ?3, assignee_matches_json = ?4 WHERE id = ?1`)
        .bind(a.sheet.id, lists.get(a.sheet.id) as number, a.plan.headerRow, JSON.stringify(a.plan.assigneeMatches ?? {})),
    )
  }
  await runBatches(db, setup)

  // --- Task rows, read back through sheet-model as every later step will read them.
  const fresh = (await getWorkbookSync(db, wb.id)) as WorkbookSyncRow
  const state = await loadWorkbookState(env, fresh)
  if (!state) throw new SyncFailure('snapshot_unavailable')
  const statements: D1PreparedStatement[] = []
  const queue: Array<{ uid: string; actor: string }> = []
  const response: LinkWorkbookResponse = { bcProjectId: projectId, sheets: [] }
  for (const sheetPlan of plan.sheets) {
    const a = analyses.find((x) => x.sheet.id === sheetPlan.sheetId)
    if (!a) {
      response.sheets.push({ sheetId: sheetPlan.sheetId, bcTodolistId: null, queuedTasks: 0 })
      continue
    }
    const sheet = state.sheetsById.get(a.sheet.id) as SheetRow
    const read = readSheet(state, sheet)
    if (!read.ok) throw new SyncFailure('invalid_plan', read.error.message)
    // Title matches: row number → the to-do it is linked to (no to-do is created for it).
    const matchedByRow = new Map<number, number>()
    const todos = listTodosBySheet.get(a.sheet.id)
    if (todos) for (const m of matchByTitle(a, todos).matches) matchedByRow.set(m.row, m.todoId)
    const uidRow = rowsByUid(state.snapshot, sheet, a.plan)
    const matched = new Map<string, number>()
    for (const [uid, row] of uidRow) {
      const todoId = matchedByRow.get(row)
      if (todoId !== undefined) matched.set(uid, todoId)
    }
    const issues = new Map(read.value.issues.filter((i) => i.uid !== undefined).map((i) => [i.uid as string, i]))
    let queued = 0
    for (const task of read.value.tasks) {
      const todoId = matched.get(task.uid) ?? null
      const issue = issues.get(task.uid)
      statements.push(
        db
          .prepare(
            `INSERT INTO tasks (task_uid, sheet_id, parent_uid, level, bc_recording_id, bc_type, assign_mode, completed, local_hash,
                                last_local_change_at, sync_state, last_error, last_error_code, pending_actor_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
             ON CONFLICT (task_uid) DO NOTHING`,
          )
          .bind(
            task.uid,
            sheet.id,
            task.level === 1 ? task.parentUid : null,
            task.level,
            todoId,
            todoId === null ? null : 'todo',
            task.assignMode,
            task.completed ? 1 : 0,
            localFingerprint(task),
            // OPEN: a row matched by title takes Basecamp's values where they differ,
            // each difference logged as a restorable conflict (S3).
            todoId === null ? at : null,
            issue ? 'error' : 'pending',
            issue ? issue.message : null,
            issue ? `sheet:${issue.code}` : null,
            caller.id,
            at,
          ),
        ...assigneeStatements(db, task.uid, task.assignees, at),
      )
      if (issue) continue
      queued += 1
      const parentMatched = task.parentUid !== null && matched.has(task.parentUid)
      if (task.level === 0 || parentMatched) queue.push({ uid: task.uid, actor: caller.id })
    }
    response.sheets.push({ sheetId: a.sheet.id, bcTodolistId: lists.get(a.sheet.id) ?? null, queuedTasks: queued })
  }
  statements.push(
    db.prepare(`UPDATE workbooks SET link_state = 'linked', bc_project_id = ?2 WHERE id = ?1`).bind(wb.id, projectId),
    auditStatement(
      db,
      {
        actorId: caller.id,
        action: 'workbook.link',
        entityType: 'workbook',
        entityId: wb.id,
        workbookId: wb.id,
        details: {
          bcProjectId: projectId,
          project: plan.project.mode,
          sheets: plan.sheets.map((s) => ({ sheetId: s.sheetId, mode: s.mode, bcTodolistId: lists.get(s.sheetId) ?? null, existingTasks: s.existingTasks })),
        },
      },
      at,
    ),
  )
  await runBatches(db, statements)

  const webhook: WebhookStatus = await ensureProjectWebhook(env, { workbookId: wb.id, bcProjectId: projectId }, deps, ctx)
  if (webhook.status !== 'active') console.warn(`sync: workbook ${wb.id} linked without a webhook (${webhook.reason}); reconciliation covers it`)
  await enqueueTasks(env, wb.id, queue, deps.now)
  return response
}

/**
 * The project: an existing one (checked with the caller's token), a new one, or the one an interrupted commit created.
 * OPEN: `link_state = 'linking'` — a workbook half-linked reads as linked elsewhere (S4).
 */
async function resolveProject(
  env: Env,
  client: BasecampClient,
  token: string,
  caller: Caller,
  wb: WorkbookSyncRow,
  plan: LinkPlan,
  at: string,
): Promise<number> {
  const db = env.DB
  if (wb.link_state === 'linking' && wb.bc_project_id !== null) {
    if (plan.project.mode === 'existing' && plan.project.projectId !== wb.bc_project_id) {
      throw new SyncFailure('invalid_plan', 'بدأ ربط هذا الملف بمشروع آخر في Basecamp ولم يكتمل، فلم يُنفَّذ شيء. اختر المشروع نفسه لإكمال الربط.')
    }
    return wb.bc_project_id
  }
  let projectId: number
  let created = false
  if (plan.project.mode === 'existing') {
    projectId = plan.project.projectId
    const taken = await db.prepare(`SELECT id FROM workbooks WHERE bc_project_id = ?1 AND id <> ?2 AND archived_at IS NULL`).bind(projectId, wb.id).first()
    if (taken) throw new SyncFailure('project_taken')
    try {
      await client.projects.get(token, projectId)
    } catch (error) {
      throw projectError(error)
    }
  } else {
    const project = await client.projects.create(token, { name: (plan.project as { name: string }).name })
    projectId = project.id
    created = true
  }
  const result = await db.batch([
    db
      .prepare(`UPDATE workbooks SET bc_project_id = ?2, link_state = 'linking' WHERE id = ?1 AND (link_state IS NULL OR link_state = 'linking')`)
      .bind(wb.id, projectId),
    auditStatement(
      db,
      { actorId: caller.id, action: 'workbook.link.project', entityType: 'workbook', entityId: wb.id, workbookId: wb.id, details: { bcProjectId: projectId, created } },
      at,
    ),
  ])
  if (result[0]?.meta.changes !== 1) throw new SyncFailure('already_linked')
  return projectId
}

/** uid → 0-based row of each task row of a sheet, from the system columns just written. */
function rowsByUid(snapshot: WorkbookSnapshot, sheet: SheetRow, plan: SheetPlan): Map<string, number> {
  const out = new Map<string, number>()
  const ws = snapshot.sheets[sheet.univer_sheet_id]
  if (!ws) return out
  const headerIndex = plan.headerRow - 1
  const header = (ws.cellData?.[headerIndex] ?? {}) as Record<string, { v?: unknown } | undefined>
  let uidColumn: number | null = null
  for (const [c, cell] of Object.entries(header)) if (cell?.v === '__uid') uidColumn = Number(c)
  if (uidColumn === null) return out
  for (const [r, line] of Object.entries(ws.cellData ?? {})) {
    const row = Number(r)
    if (row <= headerIndex) continue
    const value = (line as Record<number, { v?: unknown } | undefined>)[uidColumn]?.v
    if (typeof value === 'string' && value !== '') out.set(value, row)
  }
  return out
}
