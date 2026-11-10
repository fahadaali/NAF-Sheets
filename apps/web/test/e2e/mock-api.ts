// An in-memory stand-in for the API contract (packages/shared/src/api.ts),
// installed on a page through route interception. Each test builds its own.

import type { Page, Route, WebSocketRoute } from 'playwright'
import { DEFAULT_COLUMNS } from '@naf-sheets/shared'
import type {
  ApiError,
  ApiErrorCode,
  AssigneeOptionsResponse,
  ConflictRecord,
  CreateExternalContactRequest,
  ExternalContact,
  GrantProjectPersonRequest,
  BasecampLinkResponse,
  BasecampProjectsResponse,
  BasecampTodolistsResponse,
  BcPerson,
  GoogleLinkResponse,
  ImportGsheetsRequest,
  ImportReportResponse,
  LinkPlan,
  LinkPreviewResponse,
  LinkWorkbookResponse,
  MeResponse,
  PeopleMatchesResponse,
  PutPeopleMatchRequest,
  SaveSnapshotRequest,
  SheetMeta,
  WorkbookResponse,
  WorkbookSummary,
  WorkbookSyncResponse,
} from '@naf-sheets/shared'

export interface Recorded {
  method: string
  path: string
  body: unknown
}

/** `body: undefined` answers with no body (e.g. 204). */
type Reply = { status: number; body: unknown }
type Override = (req: Recorded) => Reply | undefined

const now = '2026-11-10T09:30:00Z'

export function summary(over: Partial<WorkbookSummary> & Pick<WorkbookSummary, 'id' | 'title'>): WorkbookSummary {
  return { bcProjectId: null, sheetCount: 1, completion: null, syncState: 'unlinked', updatedAt: now, access: 'owner', ...over }
}

export function sheetMeta(univerSheetId: string, title = 'المهام'): SheetMeta {
  return { id: `meta-${univerSheetId}`, univerSheetId, title, position: 0, syncMode: 'local', bcTodolistId: null, headerRow: 1 }
}

/** A stored Univer snapshot with the default columns and two task rows. */
export function taskSnapshot(unitId: string, sheetId: string, title: string): Record<string, unknown> {
  const header = Object.fromEntries(DEFAULT_COLUMNS.map((v, c) => [c, { v }]))
  return {
    id: unitId,
    name: title,
    appVersion: '1.4.0',
    styles: {},
    sheetOrder: [sheetId],
    sheets: {
      [sheetId]: {
        id: sheetId,
        name: 'المهام',
        rightToLeft: 1,
        defaultStyle: { ff: 'Thmanyah Sans' },
        cellData: {
          0: header,
          1: { 0: { v: 'إعداد خطة الاتصال للربع الأول' }, 1: { v: 'فهد' }, 3: { v: '2026-11-20' } },
          2: { 0: { v: 'نشر المقال على LinkedIn' }, 1: { v: 'سارة' } },
        },
      },
    },
  }
}

export class MockApi {
  readonly requests: Recorded[] = []
  readonly workbooks = new Map<string, WorkbookResponse>()
  me: MeResponse = { user: { id: 'u-1', name: 'فهد العتيبي', email: 'fahad@example.com', role: 'editor' } }
  /** Return a reply to replace the default behaviour for a request. */
  override: Override | null = null
  private created = 0

  // --- Wave 2 (packages/shared/src/api-integrations.ts) ---------------------
  /** Linked by default, so screens that do not test the link see no banner. */
  basecampLink: BasecampLinkResponse = { state: 'active', bcPersonId: 900, bcAccountId: 5_000_001, name: 'Fahad Alotaibi' }
  googleLink: GoogleLinkResponse = { state: 'active', email: 'fahad@example.com' }
  projects: BasecampProjectsResponse['projects'] = []
  todolists: Record<number, BasecampTodolistsResponse['todolists']> = {}
  people: Record<number, BcPerson[]> = {}
  peopleMatches: PeopleMatchesResponse = { matches: [], people: [] }
  importReports = new Map<string, ImportReportResponse>()
  /** POST /api/import/gsheets: what to create; returns the response. */
  onImport: ((req: ImportGsheetsRequest) => { workbookId: string; reportId: string }) | null = null
  /** POST …/link/preview */
  preview: (plan: LinkPlan) => LinkPreviewResponse = (plan) => ({
    sheets: plan.sheets.map((s) => ({ sheetId: s.sheetId, todosToCreate: 0, subtasksToCreate: 0, proposedMatches: [], unmatchedAssignees: [], warnings: [] })),
  })
  /** POST …/link */
  link: (plan: LinkPlan) => LinkWorkbookResponse = (plan) => ({
    bcProjectId: plan.project.mode === 'existing' ? plan.project.projectId : plan.project.mode === 'create' ? 777 : null,
    sheets: plan.sheets.map((s) => ({ sheetId: s.sheetId, bcTodolistId: s.mode === 'local' ? null : (s.todolistId ?? 888), queuedTasks: 0 })),
  })

  // --- Wave 3 (packages/shared/src/api-sync.ts) -----------------------------
  /** GET …/sync per workbook; unlinked when absent. */
  sync: Record<string, WorkbookSyncResponse> = {}
  /** GET …/conflicts per workbook (unresolved). */
  conflicts: Record<string, ConflictRecord[]> = {}
  /** GET …/assignee-options per workbook. */
  assigneeOptions: Record<string, AssigneeOptionsResponse> = {}
  /** POST …/project-people: what to answer (default: the person joins the project). */
  grant: ((workbookId: string, req: GrantProjectPersonRequest) => Reply) | null = null
  /** POST …/sync-now: lists queued. */
  syncNowQueued = 2
  private externalCount = 0

  bodies(method: string, path: string): unknown[] {
    return this.requests.filter((r) => r.method === method && r.path === path).map((r) => r.body)
  }

  add(workbook: WorkbookSummary, snapshot: unknown, version: number, sheets: SheetMeta[] = [sheetMeta('sheet-1')]): void {
    this.workbooks.set(workbook.id, {
      workbook: { ...workbook, ownerId: this.me.user.id, source: 'blank', createdAt: now },
      sheets,
      snapshot,
      version,
    })
  }

  puts(id?: string): Array<SaveSnapshotRequest> {
    return this.requests
      .filter((r) => r.method === 'PUT' && r.path.endsWith('/snapshot') && (!id || r.path === `/api/workbooks/${encodeURIComponent(id)}/snapshot`))
      .map((r) => r.body as SaveSnapshotRequest)
  }

  count(method: string, path: string): number {
    return this.requests.filter((r) => r.method === method && r.path === path).length
  }

  /**
   * The workbook room (GET /api/workbooks/:id/room, a WebSocket). Default: no
   * room — the socket closes at once, as when the room cannot be reached, and
   * the editor falls back to saving with PUT …/snapshot. A collaboration test
   * sets its own handler.
   */
  room: ((ws: WebSocketRoute) => void) | null = null

  async install(page: Page): Promise<void> {
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      (route) => this.handle(route),
    )
    await page.routeWebSocket(/\/api\/workbooks\/[^/]+\/room$/, (ws) => {
      if (this.room) this.room(ws)
      else void ws.close({ code: 1011, reason: 'no room in the mock API' })
    })
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request()
    const url = new URL(request.url())
    let body: unknown = null
    try {
      body = request.postDataJSON()
    } catch {
      body = request.postData()
    }
    const recorded: Recorded = { method: request.method(), path: url.pathname + url.search, body }
    this.requests.push(recorded)
    const reply = this.override?.(recorded) ?? this.reply(recorded.method, url, body)
    if (reply.body === undefined) await route.fulfill({ status: reply.status, body: '' })
    else await route.fulfill({ status: reply.status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(reply.body) })
  }

  /** The endpoints of packages/shared/src/api-integrations.ts; undefined when the path is not one of them. */
  private wave2(method: string, path: string, body: unknown): Reply | undefined {
    if (path === '/api/basecamp/link' && method === 'GET') return { status: 200, body: this.basecampLink }
    if (path === '/api/basecamp/link/revoke' && method === 'POST') {
      this.basecampLink = { ...this.basecampLink, state: 'revoked' }
      return { status: 200, body: { state: 'revoked' } }
    }
    if (path === '/api/basecamp/projects' && method === 'GET') return { status: 200, body: { projects: this.projects } }
    const project = /^\/api\/basecamp\/projects\/(\d+)\/(todolists|people)$/.exec(path)
    if (project && method === 'GET') {
      const id = Number(project[1])
      if (project[2] === 'todolists') return { status: 200, body: { todolists: this.todolists[id] ?? [] } }
      return { status: 200, body: { people: this.people[id] ?? [], refreshedAt: now } }
    }
    if (path === '/api/admin/people-matches' && method === 'GET') {
      if (this.me.user.role !== 'admin') return error(403, 'forbidden', 'هذه الشاشة لمسؤولي المنصة.')
      return { status: 200, body: this.peopleMatches }
    }
    const match = /^\/api\/admin\/people-matches\/([^/]+)$/.exec(path)
    if (match?.[1] && method === 'PUT') {
      if (this.me.user.role !== 'admin') return error(403, 'forbidden', 'هذه الشاشة لمسؤولي المنصة.')
      const userId = decodeURIComponent(match[1])
      const req = body as PutPeopleMatchRequest
      this.peopleMatches = {
        ...this.peopleMatches,
        matches: this.peopleMatches.matches.map((m) => (m.userId === userId ? { ...m, bcPersonId: req.bcPersonId, source: req.bcPersonId === null ? null : 'manual' } : m)),
      }
      return { status: 204, body: undefined }
    }
    if (path === '/api/google/link' && method === 'GET') return { status: 200, body: this.googleLink }
    if (path === '/api/import/gsheets' && method === 'POST') {
      if (!this.onImport) return error(400, 'unsupported_source', 'تعذّر الاستيراد.')
      return { status: 201, body: this.onImport(body as ImportGsheetsRequest) }
    }
    const workbook = /^\/api\/workbooks\/([^/]+)\/(import-report|link\/preview|link)$/.exec(path)
    if (workbook?.[1]) {
      const id = decodeURIComponent(workbook[1])
      const stored = this.workbooks.get(id)
      if (!stored) return error(404, 'not_found', 'الملف غير موجود. عُد إلى قائمة الملفات واختر ملفاً آخر.')
      if (workbook[2] === 'import-report' && method === 'GET') {
        const report = this.importReports.get(id)
        return report ? { status: 200, body: report } : error(404, 'not_found', 'لا تقرير استيراد لهذا الملف.')
      }
      if (workbook[2] === 'link/preview' && method === 'POST') return { status: 200, body: this.preview(body as LinkPlan) }
      if (workbook[2] === 'link' && method === 'POST') {
        const result = this.link(body as LinkPlan)
        stored.workbook = { ...stored.workbook, bcProjectId: result.bcProjectId, syncState: 'pending' }
        return { status: 200, body: result }
      }
    }
    return undefined
  }

  /** The endpoints of packages/shared/src/api-sync.ts; undefined when the path is not one of them. */
  private wave3(method: string, path: string, body: unknown): Reply | undefined {
    if (path === '/api/external-contacts' && method === 'POST') {
      if (this.me.user.role === 'viewer') return error(403, 'forbidden', 'ليست لديك صلاحية إضافة جهات خارجية.')
      const req = body as CreateExternalContactRequest
      if (typeof req?.name !== 'string' || req.name.trim() === '') return error(400, 'invalid_request', 'اسم الجهة الخارجية فارغ. اكتبه ثم أعد المحاولة.')
      const contact: ExternalContact = { id: `ext-new-${++this.externalCount}`, name: req.name.trim(), organization: req.organization ?? null, email: req.email ?? null, phone: req.phone ?? null }
      for (const options of Object.values(this.assigneeOptions)) options.externals = [...options.externals, contact]
      return { status: 201, body: contact }
    }
    const m = /^\/api\/workbooks\/([^/]+)\/(sync|sync-now|conflicts|assignee-options|project-people|conflicts\/([^/]+)\/(restore|dismiss))$/.exec(path)
    if (!m?.[1]) return undefined
    const id = decodeURIComponent(m[1])
    const stored = this.workbooks.get(id)
    if (!stored) return error(404, 'not_found', 'الملف غير موجود. عُد إلى قائمة الملفات واختر ملفاً آخر.')
    const reader = stored.workbook.access === 'viewer'
    const what = m[2]
    if (what === 'sync' && method === 'GET') {
      return { status: 200, body: this.sync[id] ?? { state: 'unlinked', lastSuccessAt: null, counts: { pending: 0, error: 0, conflict: 0 }, notice: null, tasks: [] } }
    }
    if (what === 'sync-now' && method === 'POST') {
      if (reader) return error(403, 'forbidden', 'ليست لديك صلاحية طلب المزامنة.')
      return { status: 202, body: { queued: this.syncNowQueued } }
    }
    if (what === 'conflicts' && method === 'GET') return { status: 200, body: { conflicts: this.conflicts[id] ?? [] } }
    if (m[3] && method === 'POST') {
      if (reader) return error(403, 'forbidden', 'ليست لديك صلاحية حل التعارضات.')
      const list = this.conflicts[id] ?? []
      if (!list.some((c) => c.id === m[3])) return error(404, 'not_found', 'التعارض غير موجود؛ ربما حُلّ من قبل. حدّث الصفحة.')
      this.conflicts[id] = list.filter((c) => c.id !== m[3])
      return m[4] === 'restore' ? { status: 202, body: { restored: true } } : { status: 204, body: undefined }
    }
    if (what === 'assignee-options' && method === 'GET') {
      return { status: 200, body: this.assigneeOptions[id] ?? { projectPeople: [], accountPeople: [], externals: [], refreshedAt: null } }
    }
    if (what === 'project-people' && method === 'POST') {
      if (reader) return error(403, 'forbidden', 'ليست لديك صلاحية تعديل الملف.')
      const req = body as GrantProjectPersonRequest
      if (this.grant) return this.grant(id, req)
      const options = this.assigneeOptions[id]
      const person = options?.accountPeople.find((p) => p.id === req.bcPersonId)
      if (!options || !person) return error(404, 'not_found', 'الشخص غير موجود في حساب Basecamp.')
      options.accountPeople = options.accountPeople.filter((p) => p.id !== person.id)
      options.projectPeople = [...options.projectPeople, person]
      return { status: 200, body: options }
    }
    return undefined
  }

  private reply(method: string, url: URL, body: unknown): Reply {
    const path = url.pathname
    if (method === 'GET' && path === '/api/me') return { status: 200, body: this.me }
    const wave2 = this.wave2(method, path, body)
    if (wave2) return wave2
    const wave3 = this.wave3(method, path, body)
    if (wave3) return wave3

    if (path === '/api/workbooks') {
      if (method === 'GET') {
        const q = (url.searchParams.get('q') ?? '').trim()
        const workbooks = [...this.workbooks.values()].map((w) => summaryOf(w)).filter((w) => !q || w.title.includes(q))
        return { status: 200, body: { workbooks } }
      }
      if (method === 'POST') {
        const req = body as { title?: unknown; source?: unknown }
        if (typeof req?.title !== 'string') return error(400, 'invalid_title', 'طلب غير صالح.')
        if (req.source !== 'blank') return error(400, 'unsupported_source', 'طلب غير صالح.')
        const id = `wb-new-${++this.created}`
        // A new workbook: no snapshot yet, one sheet (see OPEN_QUESTIONS.md).
        this.add(summary({ id, title: req.title }), null, 1)
        return { status: 201, body: { id } }
      }
    }

    const match = /^\/api\/workbooks\/([^/]+)(\/snapshot)?$/.exec(path)
    if (match?.[1]) {
      const id = decodeURIComponent(match[1])
      const stored = this.workbooks.get(id)
      if (!stored) return error(404, 'not_found', 'الملف غير موجود. عُد إلى قائمة الملفات واختر ملفاً آخر.')
      if (!match[2] && method === 'GET') return { status: 200, body: stored }
      if (match[2] && method === 'PUT') {
        const req = body as SaveSnapshotRequest
        if (req.baseVersion !== stored.version) {
          return error(409, 'version_conflict', 'حُفظت نسخة أحدث من هذا الملف قبل تعديلك. أعد تحميل الملف ثم أعد إدخال تعديلك.')
        }
        stored.version += 1
        stored.snapshot = req.snapshot
        return { status: 200, body: { version: stored.version } }
      }
    }
    return error(404, 'not_found', 'المسار غير موجود.')
  }
}

function summaryOf(w: WorkbookResponse): WorkbookSummary {
  const { id, title, bcProjectId, sheetCount, completion, syncState, updatedAt, access } = w.workbook
  return { id, title, bcProjectId, sheetCount, completion, syncState, updatedAt, access }
}

export function error(status: number, code: ApiErrorCode, message: string): Reply {
  const body: ApiError = { ok: false, error: code, message }
  return { status, body }
}
