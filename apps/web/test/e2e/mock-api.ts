// An in-memory stand-in for the API contract (packages/shared/src/api.ts),
// installed on a page through route interception. Each test builds its own.

import type { Page, Route } from 'playwright'
import { DEFAULT_COLUMNS } from '@naf-sheets/shared'
import type { ApiError, MeResponse, SaveSnapshotRequest, SheetMeta, WorkbookResponse, WorkbookSummary } from '@naf-sheets/shared'

export interface Recorded {
  method: string
  path: string
  body: unknown
}

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
    await route.fulfill({ status: reply.status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(reply.body) })
  }

  private reply(method: string, url: URL, body: unknown): Reply {
    const path = url.pathname
    if (method === 'GET' && path === '/api/me') return { status: 200, body: this.me }

    if (path === '/api/workbooks') {
      if (method === 'GET') {
        const q = (url.searchParams.get('q') ?? '').trim()
        const workbooks = [...this.workbooks.values()].map((w) => summaryOf(w)).filter((w) => !q || w.title.includes(q))
        return { status: 200, body: { workbooks } }
      }
      if (method === 'POST') {
        const req = body as { title?: unknown; source?: unknown }
        if (typeof req?.title !== 'string' || req.source !== 'blank') return error(400, 'bad_request', 'طلب غير صالح.')
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

export function error(status: number, code: string, message: string): Reply {
  const body: ApiError = { ok: false, error: code, message }
  return { status, body }
}
