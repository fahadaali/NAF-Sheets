// An in-memory stand-in for the API contract (packages/shared/src/api.ts),
// installed on a page through route interception. Each test builds its own.

import type { Page, Route, WebSocketRoute } from 'playwright'
import { DEFAULT_COLUMNS } from '@naf-sheets/shared'
import { contrastWarnings, normalizePalette } from '@naf-sheets/shared'
import type {
  AppearancePalette,
  DashboardResponse,
  DashboardWidget,
  DashboardWidgetConfig,
  WidgetResult,
  ApiTokenSummary,
  BackupRunsResponse,
  SyncHealthResponse,
  TemplateSummary,
  ApiError,
  ApiErrorCode,
  AssigneeOptionsResponse,
  AttachmentInfo,
  AttachmentSettingsResponse,
  CommentInfo,
  TaskAttachmentsResponse,
  TaskCommentsResponse,
  ConflictRecord,
  CreateExternalContactRequest,
  ExternalContact,
  GrantProjectPersonRequest,
  BasecampLinkResponse,
  BasecampProjectsResponse,
  BasecampTodolistsResponse,
  BcPerson,
  GoogleLinkResponse,
  ImportGsheetsLinkRequest,
  ImportGsheetsRequest,
  ImportReportResponse,
  LinkPlan,
  LinkPreviewResponse,
  LinkWorkbookResponse,
  MeResponse,
  NafIdReport,
  PlatformMember,
  UpdatePlatformMemberRequest,
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

/** `body: undefined` answers with no body (e.g. 204); `raw` answers bytes (downloads). */
type Reply = { status: number; body: unknown; raw?: { contentType: string; data: Buffer; headers?: Record<string, string> } }
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
  /** POST /api/import/xlsx (raw file body; `name`/`title` in the query): a response, or an error reply. */
  onXlsxImport: ((req: { size: number; name: string | null; title: string | null }) => { workbookId: string; reportId: string } | Reply) | null = null
  /** POST /api/import/gsheets-link: a response, or an error reply. */
  onLinkImport: ((req: ImportGsheetsLinkRequest) => { workbookId: string; reportId: string } | Reply) | null = null
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

  // --- Phase 5 (packages/shared/src/api-phase5.ts) ---------------------------
  attachmentSettings: AttachmentSettingsResponse = { maxBytes: 100 * 1024 * 1024, subtaskMode: 'local' }
  /** Files per task uid (any workbook). */
  attachments: Record<string, AttachmentInfo[]> = {}
  /** Task levels for the attachments list (default 0). */
  levels: Record<string, 0 | 1> = {}
  /** `TaskAttachmentsResponse.notice` per task uid. */
  attachmentNotices: Record<string, string> = {}
  /** Bytes of each file, for downloads. */
  readonly files = new Map<string, Buffer>()
  /** The next upload answers this instead of storing the file. */
  failNextUpload: Reply | null = null
  /** Uploads are answered this much later (to see their progress). */
  uploadDelayMs = 0
  /** Comments per task uid (a subtask's entry is its parent's, with `onParent`). */
  comments: Record<string, { comments: CommentInfo[]; onParent?: boolean; targetUid?: string }> = {}
  private fileCount = 0
  private commentCount = 0

  // --- Phase 7 (packages/shared/src/api-phase7.ts) ---------------------------
  templates: TemplateSummary[] = []
  /** The snapshot a workbook made from each template starts with. */
  templateSnapshots: Record<string, unknown> = {}
  syncHealth: SyncHealthResponse = { workbooks: [], deadLetters: 0 }
  backups: BackupRunsResponse = { configured: true, runs: [], retention: { keepDaily: 30, keepMonthly: 12 }, lastPrune: null }
  apiTokens: ApiTokenSummary[] = []
  private tokenCount = 0
  private templateCount = 0

  // --- Dashboard and appearance (packages/shared/src/api-dashboard.ts) -------
  /** GET …/dashboard per workbook: the automatic figures; widgets and results come from below. */
  dashboards: Record<string, DashboardResponse> = {}
  /** Live widgets per workbook. */
  widgets: Record<string, DashboardWidget[]> = {}
  /** What a configuration computes to (preview, and every widget's result). */
  widgetResult: (config: DashboardWidgetConfig) => WidgetResult = () => ({ widgetId: null, ok: true, value: 0, cells: 0, skipped: 0, uncomputed: 0, groups: null, otherGroups: 0, groupLimit: 50, link: null })
  palette: AppearancePalette = {}
  private widgetCount = 0

  // --- Platform members «أعضاء المنصة» (packages/shared/src/api-members.ts) ---
  platformMembers: PlatformMember[] = []
  /** What PUT /api/admin/members/:userId says about the naf-id report. */
  memberReport: NafIdReport = 'sent'

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
    if (request.method() === 'POST' && (/\/tasks\/[^/]+\/attachments$/.test(url.pathname) || url.pathname === '/api/import/xlsx')) {
      // A raw file body (not JSON): its size and type are what the mock keeps.
      const data = request.postDataBuffer() ?? Buffer.alloc(0)
      body = { size: data.length, contentType: request.headers()['content-type'] ?? null, data }
    } else {
      try {
        body = request.postDataJSON()
      } catch {
        body = request.postData()
      }
    }
    const recorded: Recorded = { method: request.method(), path: url.pathname + url.search, body }
    this.requests.push(recorded)
    const reply = this.override?.(recorded) ?? this.reply(recorded.method, url, body)
    if (this.uploadDelayMs > 0 && recorded.method === 'POST' && /\/tasks\/[^/]+\/attachments$/.test(url.pathname)) {
      await new Promise((resolve) => setTimeout(resolve, this.uploadDelayMs))
    }
    if (reply.raw) await route.fulfill({ status: reply.status, contentType: reply.raw.contentType, body: reply.raw.data, headers: reply.raw.headers })
    else if (reply.body === undefined) await route.fulfill({ status: reply.status, body: '' })
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
    if (path === '/api/import/xlsx' && method === 'POST') {
      if (!this.onXlsxImport) return error(415, 'xlsx_not_xlsx', 'الملف ليس ملف Excel بصيغة ‎.xlsx.')
      const raw = body as { size: number }
      const query = new URLSearchParams(this.requests[this.requests.length - 1]?.path.split('?')[1] ?? '')
      const out = this.onXlsxImport({ size: raw.size, name: query.get('name'), title: query.get('title') })
      return 'status' in out ? out : { status: 201, body: out }
    }
    if (path === '/api/import/gsheets-link' && method === 'POST') {
      if (!this.onLinkImport) return error(403, 'gsheets_link_private', 'الملف غير مشارك بالرابط.')
      const out = this.onLinkImport(body as ImportGsheetsLinkRequest)
      return 'status' in out ? out : { status: 201, body: out }
    }
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

  /** The endpoints of packages/shared/src/api-phase5.ts; undefined when the path is not one of them. */
  private phase5(method: string, url: URL, body: unknown): Reply | undefined {
    const path = url.pathname
    if (path === '/api/attachment-settings' && method === 'GET') return { status: 200, body: this.attachmentSettings }
    const m = /^\/api\/workbooks\/([^/]+)\/(?:tasks\/([^/]+)\/(attachments|comments)|attachments\/([^/]+)\/(remove|retry|download))$/.exec(path)
    if (!m?.[1]) return undefined
    const id = decodeURIComponent(m[1])
    const stored = this.workbooks.get(id)
    if (!stored) return error(404, 'not_found', 'الملف غير موجود. عُد إلى قائمة الملفات واختر ملفاً آخر.')
    const reader = stored.workbook.access === 'viewer' || this.me.user.role === 'viewer'
    const forbidden = () => error(403, 'forbidden', 'لا تملك صلاحية التعديل على هذا الملف؛ يمكنك الاطلاع على المرفقات والتعليقات فقط.')
    const listOf = (uid: string): TaskAttachmentsResponse => ({
      taskUid: uid,
      level: this.levels[uid] ?? 0,
      attachments: this.attachments[uid] ?? [],
      settings: this.attachmentSettings,
      notice: this.attachmentNotices[uid] ?? null,
      canEdit: !reader,
    })
    if (m[2]) {
      const uid = decodeURIComponent(m[2])
      if (m[3] === 'attachments' && method === 'GET') return { status: 200, body: listOf(uid) }
      if (m[3] === 'attachments' && method === 'POST') {
        if (reader) return forbidden()
        if (this.failNextUpload) {
          const reply = this.failNextUpload
          this.failNextUpload = null
          return reply
        }
        const upload = body as { size: number; contentType: string | null; data: Buffer }
        if (upload.size > this.attachmentSettings.maxBytes) return error(413, 'attachment_too_large', 'حجم الملف أكبر من الحد المسموح، فلم يُرفع شيء.')
        const name = url.searchParams.get('name') ?? ''
        const fileId = `att-${++this.fileCount}`
        const level = this.levels[uid] ?? 0
        const info: AttachmentInfo = {
          id: fileId,
          taskUid: uid,
          filename: name,
          size: upload.size,
          mime: upload.contentType,
          origin: 'local',
          state: level === 1 ? 'local_only' : 'attached',
          message: null,
          downloadPath: `/api/workbooks/${encodeURIComponent(id)}/attachments/${fileId}/download`,
          createdAt: now,
        }
        this.files.set(fileId, upload.data)
        this.attachments[uid] = [...(this.attachments[uid] ?? []), info]
        return { status: 201, body: { attachment: info, attachments: this.attachments[uid] } }
      }
      if (m[3] === 'comments') {
        const entry = this.comments[uid] ?? { comments: [] }
        const thread = (): TaskCommentsResponse => ({
          taskUid: uid,
          targetUid: entry.targetUid ?? uid,
          onParent: entry.onParent ?? false,
          comments: entry.comments,
          commentsCount: entry.comments.length,
          bcUrl: `https://3.basecamp.com/5000001/buckets/4021/todos/${entry.targetUid ?? uid}`,
          canComment: !reader,
        })
        if (method === 'GET') return { status: 200, body: thread() }
        if (method === 'POST') {
          if (reader) return forbidden()
          const content = typeof (body as { content?: unknown })?.content === 'string' ? (body as { content: string }).content.trim() : ''
          if (content === '') return error(400, 'comment_invalid', 'نص التعليق فارغ، فلم يُرسل شيء. اكتب تعليقاً ثم أعد الإرسال.')
          const comment: CommentInfo = { id: 9000 + ++this.commentCount, text: content, creatorName: 'فهد العتيبي', creatorAvatarUrl: null, createdAt: now, appUrl: null, attachments: [] }
          entry.comments = [...entry.comments, comment]
          this.comments[uid] = entry
          return { status: 201, body: { comment, commentsCount: entry.comments.length } }
        }
      }
      return undefined
    }
    const fileId = decodeURIComponent(m[4] ?? '')
    const owner = Object.keys(this.attachments).find((uid) => (this.attachments[uid] ?? []).some((a) => a.id === fileId))
    const file = owner ? (this.attachments[owner] ?? []).find((a) => a.id === fileId) : undefined
    if (!owner || !file) return error(404, 'attachment_not_found', 'لم يُعثر على هذا المرفق، فربما أُزيل من قبل.')
    if (m[5] === 'download' && method === 'GET') {
      return { status: 200, body: undefined, raw: { contentType: file.mime ?? 'application/octet-stream', data: this.files.get(fileId) ?? Buffer.from('file'), headers: { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}` } } }
    }
    if (method !== 'POST') return undefined
    if (reader) return forbidden()
    if (m[5] === 'remove') {
      if ((body as { confirmed?: unknown })?.confirmed !== true) return error(400, 'attachment_not_confirmed', 'لم تُؤكَّد إزالة المرفق، فلم يُزل شيء.')
      this.attachments[owner] = (this.attachments[owner] ?? []).filter((a) => a.id !== fileId)
      return { status: 200, body: listOf(owner) }
    }
    if (m[5] === 'retry') {
      this.attachments[owner] = (this.attachments[owner] ?? []).map((a) => (a.id === fileId ? { ...a, state: 'attached', message: null } : a))
      return { status: 200, body: { attachment: (this.attachments[owner] ?? []).find((a) => a.id === fileId), attachments: this.attachments[owner] } }
    }
    return undefined
  }

  /** The endpoints of packages/shared/src/api-phase7.ts (and sync health); undefined when the path is not one of them. */
  private phase7(method: string, path: string, body: unknown): Reply | undefined {
    const adminOnly = () => error(403, 'forbidden', 'هذا الإجراء مقصور على مسؤول المنصة. اطلبه من مسؤول المنصة.')
    const isAdmin = this.me.user.role === 'admin'
    if (path === '/api/templates' && method === 'GET') return { status: 200, body: { templates: this.templates } }
    if (path === '/api/admin/sync-health' && method === 'GET') return isAdmin ? { status: 200, body: this.syncHealth } : adminOnly()
    if (path === '/api/admin/backups' && method === 'GET') return isAdmin ? { status: 200, body: this.backups } : adminOnly()
    if (path === '/api/admin/backups/retention' && method === 'PUT') {
      if (!isAdmin) return adminOnly()
      const req = body as { keepDaily?: unknown; keepMonthly?: unknown }
      const ok = (n: unknown, min: number, max: number) => typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max
      if (!ok(req.keepDaily, 1, 365) || !ok(req.keepMonthly, 0, 120)) return error(400, 'invalid_request', 'قيم الاحتفاظ بالنسخ الاحتياطية غير صالحة.')
      this.backups = { ...this.backups, retention: { keepDaily: req.keepDaily as number, keepMonthly: req.keepMonthly as number } }
      return { status: 200, body: { retention: this.backups.retention } }
    }
    if (path === '/api/admin/templates' && method === 'POST') {
      if (!isAdmin) return adminOnly()
      const req = body as { workbookId?: string; title?: string; description?: string | null }
      const source = this.workbooks.get(req.workbookId ?? '')
      if (!source) return error(400, 'invalid_request', 'لم يُحدَّد الملف الذي يُحفظ قالباً.')
      const tpl: TemplateSummary = {
        id: `tpl-new-${++this.templateCount}`,
        title: String(req.title ?? '').trim(),
        description: req.description ?? null,
        sheetCount: source.sheets.length,
        sourceWorkbookId: source.workbook.id,
        sourceTitle: source.workbook.title,
        createdAt: now,
        updatedAt: now,
      }
      this.templates = [...this.templates, tpl]
      this.templateSnapshots[tpl.id] = source.snapshot
      return { status: 201, body: tpl }
    }
    const tm = /^\/api\/admin\/templates\/([^/]+)(\/archive)?$/.exec(path)
    if (tm?.[1]) {
      if (!isAdmin) return adminOnly()
      const id = decodeURIComponent(tm[1])
      const tpl = this.templates.find((x) => x.id === id)
      if (!tpl) return error(404, 'template_not_found', 'لم يُعثر على القالب.')
      if (tm[2] && method === 'POST') {
        this.templates = this.templates.filter((x) => x.id !== id)
        return { status: 200, body: { archived: true } }
      }
      if (!tm[2] && method === 'PUT') {
        const req = body as { title: string; description?: string | null }
        Object.assign(tpl, { title: req.title, description: req.description ?? null })
        return { status: 200, body: tpl }
      }
    }
    if (path === '/api/admin/api-tokens') {
      if (!isAdmin) return adminOnly()
      if (method === 'GET') return { status: 200, body: { tokens: this.apiTokens } }
      if (method === 'POST') {
        const name = String((body as { name?: string })?.name ?? '').trim()
        if (!name) return error(400, 'invalid_request', 'اسم الرمز مطلوب.')
        const secret = `nafs_mock${++this.tokenCount}${'x'.repeat(30)}`
        const token: ApiTokenSummary = { id: `tok-${this.tokenCount}`, name, prefix: secret.slice(0, 10), createdAt: now, lastUsedAt: null, revokedAt: null }
        this.apiTokens = [token, ...this.apiTokens]
        return { status: 201, body: { token, secret } }
      }
    }
    const rv = /^\/api\/admin\/api-tokens\/([^/]+)\/revoke$/.exec(path)
    if (rv?.[1] && method === 'POST') {
      if (!isAdmin) return adminOnly()
      const token = this.apiTokens.find((x) => x.id === decodeURIComponent(rv[1]!))
      if (!token) return error(404, 'api_token_not_found', 'لم يُعثر على رمز الخدمة.')
      token.revokedAt = now
      return { status: 200, body: token }
    }
    return undefined
  }

  /** The endpoints of packages/shared/src/api-dashboard.ts; undefined when the path is not one of them. */
  private dashboard(method: string, path: string, body: unknown): Reply | undefined {
    if (path === '/api/appearance' && method === 'GET') return { status: 200, body: { palette: this.palette, updatedAt: null, warnings: contrastWarnings(this.palette) } }
    if (path === '/api/admin/appearance' && method === 'PUT') {
      if (this.me.user.role !== 'admin') return error(403, 'forbidden', 'تعديل مظهر المنصة مقصور على مسؤول المنصة.')
      const palette = normalizePalette((body as { palette?: unknown } | null)?.palette)
      if (!palette) return error(400, 'invalid_palette', 'ألوان المظهر غير صالحة، فلم يُحفظ شيء.')
      this.palette = palette
      return { status: 200, body: { palette, updatedAt: now, warnings: contrastWarnings(palette) } }
    }
    const m = /^\/api\/workbooks\/([^/]+)\/dashboard(?:\/(preview|widgets)(?:\/([^/]+)(?:\/(remove))?)?)?$/.exec(path)
    if (!m?.[1]) return undefined
    const id = decodeURIComponent(m[1])
    const stored = this.workbooks.get(id)
    const base = this.dashboards[id]
    if (!stored || !base) return error(404, 'not_found', 'لم يُعثر على الملف، أو ليس لك وصول إليه.')
    const reader = stored.workbook.access === 'viewer' || this.me.user.role === 'viewer'
    const forbidden = () => error(403, 'forbidden', 'لا تملك صلاحية تعديل لوحة هذا الملف؛ يمكنك الاطلاع عليها فقط.')
    const list = (this.widgets[id] ??= [])
    const result = (w: DashboardWidgetConfig, widgetId: string | null) => ({ ...this.widgetResult(w), widgetId })
    if (!m[2] && method === 'GET') {
      return { status: 200, body: { ...base, canEdit: !reader, widgets: list.map((w, i) => ({ ...w, position: i })), results: list.map((w) => result(w, w.id)) } }
    }
    if (m[2] === 'preview' && method === 'POST') return { status: 200, body: result(body as DashboardWidgetConfig, null) }
    if (m[2] !== 'widgets') return undefined
    if (reader) return forbidden()
    const config = body as DashboardWidgetConfig
    if (!m[3] && method === 'POST') {
      const widget: DashboardWidget = { ...config, id: `w-${++this.widgetCount}`, position: list.length, updatedAt: now }
      list.push(widget)
      return { status: 201, body: { widget, result: result(widget, widget.id) } }
    }
    if (m[3] === 'order' && method === 'PUT') {
      const ids = (body as { ids: string[] }).ids
      this.widgets[id] = ids.map((wid) => list.find((w) => w.id === wid)).filter((w): w is DashboardWidget => w !== undefined)
      return { status: 200, body: { widgets: this.widgets[id].map((w, i) => ({ ...w, position: i })) } }
    }
    const wid = decodeURIComponent(m[3] ?? '')
    const index = list.findIndex((w) => w.id === wid)
    if (index === -1) return error(404, 'widget_not_found', 'لم يُعثر على هذا العنصر في اللوحة.')
    if (!m[4] && method === 'PUT') {
      const widget = { ...(list[index] as DashboardWidget), ...config, updatedAt: now }
      list[index] = widget
      return { status: 200, body: { widget, result: result(widget, widget.id) } }
    }
    if (m[4] === 'remove' && method === 'POST') {
      if ((body as { confirmed?: unknown })?.confirmed !== true) return error(400, 'widget_not_confirmed', 'لم تُؤكَّد إزالة العنصر.')
      list.splice(index, 1)
      return { status: 200, body: { widgets: list.map((w, i) => ({ ...w, position: i })) } }
    }
    return undefined
  }

  /** GET/PUT /api/admin/members (with the API's guards); undefined when the path is not one of them. */
  private members(method: string, path: string, body: unknown): Reply | undefined {
    const one = /^\/api\/admin\/members\/([^/]+)$/.exec(path)
    if (path !== '/api/admin/members' && !one) return undefined
    if (this.me.user.role !== 'admin') return error(403, 'forbidden', 'هذا الإجراء مقصور على مسؤول المنصة. اطلبه من مسؤول المنصة.')
    if (!one && method === 'GET') return { status: 200, body: { members: this.platformMembers } }
    if (!one?.[1] || method !== 'PUT') return undefined
    const userId = decodeURIComponent(one[1])
    const current = this.platformMembers.find((m) => m.userId === userId)
    if (!current) return error(404, 'not_found', 'لم يُعثر على هذا العضو في المنصة. حدّث الصفحة ثم اختر عضواً من القائمة.')
    const req = body as UpdatePlatformMemberRequest
    const next: PlatformMember = { ...current, role: req.role ?? current.role, active: req.active ?? current.active }
    if (next.role === current.role && next.active === current.active) return { status: 200, body: { member: current, changed: false, nafIdReport: 'not_needed' } }
    if (userId === this.me.user.id) return error(409, 'cannot_change_self', 'لا يمكنك تغيير دورك أو إيقاف حسابك بنفسك. اطلب ذلك من مسؤول آخر للمنصة.')
    const otherAdmins = this.platformMembers.filter((m) => m.userId !== userId && m.role === 'admin' && m.active).length
    if (current.role === 'admin' && current.active && (next.role !== 'admin' || !next.active) && otherAdmins === 0) {
      return error(409, 'last_active_admin', 'لم يُحفظ التغيير: هذا آخر مسؤول نشط في المنصة. رقِّ عضواً آخر إلى «مسؤول» أولاً، ثم أعد المحاولة.')
    }
    this.platformMembers = this.platformMembers.map((m) => (m.userId === userId ? next : m))
    return { status: 200, body: { member: next, changed: true, nafIdReport: this.memberReport } }
  }

  private reply(method: string, url: URL, body: unknown): Reply {
    const path = url.pathname
    if (method === 'GET' && path === '/api/me') return { status: 200, body: this.me }
    const members = this.members(method, path, body)
    if (members) return members
    const dashboard = this.dashboard(method, path, body)
    if (dashboard) return dashboard
    const phase7 = this.phase7(method, path, body)
    if (phase7) return phase7
    const phase5 = this.phase5(method, url, body)
    if (phase5) return phase5
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
        const req = body as { title?: unknown; source?: unknown; templateId?: unknown }
        if (typeof req?.title !== 'string') return error(400, 'invalid_title', 'طلب غير صالح.')
        if (req.source === 'template') {
          const tpl = this.templates.find((x) => x.id === req.templateId)
          if (!tpl) return error(404, 'template_not_found', 'لم يُعثر على القالب، فربما أُرشف. اختر قالباً آخر.')
          const id = `wb-tpl-${++this.created}`
          this.add(summary({ id, title: req.title, sheetCount: tpl.sheetCount }), this.templateSnapshots[tpl.id] ?? null, 1)
          return { status: 201, body: { id } }
        }
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
