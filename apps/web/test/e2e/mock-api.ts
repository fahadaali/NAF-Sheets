// An in-memory stand-in for the API contract (packages/shared/src/api.ts),
// installed on a page through route interception. Each test builds its own.

import type { Page, Route } from 'playwright'
import { DEFAULT_COLUMNS } from '@naf-sheets/shared'
import type {
  ApiError,
  ApiErrorCode,
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

  async install(page: Page): Promise<void> {
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      (route) => this.handle(route),
    )
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

  private reply(method: string, url: URL, body: unknown): Reply {
    const path = url.pathname
    if (method === 'GET' && path === '/api/me') return { status: 200, body: this.me }
    const wave2 = this.wave2(method, path, body)
    if (wave2) return wave2

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
