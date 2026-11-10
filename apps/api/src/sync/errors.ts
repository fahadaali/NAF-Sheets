// Refusals of the sync routes (contract: packages/shared/src/api-sync.ts and
// the link wizard of api-integrations.ts). Same body as every other route
// (`ApiError`); messages are Arabic and say what happened and what to do.

import type { Context } from 'hono'
import type { ApiError, ApiErrorCode } from '@naf-sheets/shared'
import type { AppEnv } from '../auth'
import { LinkFailure, linkErrorResponse } from '../basecamp-link/errors'
import { ApiFailure, errorBody, jsonResponse } from '../errors'

export const SYNC_MESSAGES = {
  forbidden_link: 'ربط الملف بـ Basecamp مقصور على مالك الملف ومسؤول المنصة. اطلب الربط من مالك الملف.',
  forbidden_write: 'لا تملك صلاحية تعديل هذا الملف أو مزامنته. اطلب من مالك الملف أو مسؤول المنصة منحك صلاحية التحرير.',
  forbidden_contacts: 'إضافة الجهات الخارجية متاحة للمحرّرين ومسؤول المنصة فقط. اطلب من مسؤول المنصة منحك دور «محرّر».',
  admin_only: 'تقرير صحة المزامنة مقصور على مسؤول المنصة. اطلب الاطلاع عليه من مسؤول المنصة.',
  already_linked: 'هذا الملف مربوط بمشروع في Basecamp أصلاً، فلم يُغيَّر شيء. عدّل ربط الأوراق من لوحة إعدادات الملف.',
  not_linked: 'هذا الملف غير مربوط بمشروع في Basecamp. اربطه من معالج الربط ثم أعد المحاولة.',
  invalid_plan: 'خطة الربط غير صالحة، فلم يُنفَّذ شيء. راجع خطوات معالج الربط ثم أعد المحاولة.',
  todolist_not_found: 'لم يُعثر على قائمة المهام المختارة في مشروع Basecamp، أو ليس لك وصول إليها. اختر قائمة من المشروع نفسه ثم أعد المحاولة.',
  todolist_taken: 'قائمة المهام المختارة مربوطة بورقة أخرى في المنصة، ولا تُربط القائمة إلا بورقة واحدة. اختر قائمة أخرى أو «إنشاء قائمة جديدة».',
  project_taken: 'مشروع Basecamp المختار مربوط بملف آخر في المنصة، ولا يُربط المشروع إلا بملف واحد. اختر مشروعاً آخر أو «إنشاء مشروع جديد».',
  link_contended: 'حُفظت نسخة أحدث من الملف أثناء الربط، فلم تكتمل كتابة أعمدة النظام. أعد تشغيل «بدء المزامنة»؛ ما أُنشئ في Basecamp يُعاد استخدامه ولا يتكرر.',
  conflict_not_found: 'لم يُعثر على هذا التعارض في الملف. حدّث الصفحة ثم أعد المحاولة.',
  conflict_resolved: 'هذا التعارض أُغلق من قبل، فلم يُغيَّر شيء. حدّث الصفحة لترى الحالة الحالية.',
  restore_refused: 'تعذّر إعادة القيمة إلى الورقة، فلم يُغيَّر شيء. عدّل الخلية يدوياً ثم احفظ.',
  invalid_contact: 'بيانات الجهة الخارجية غير صالحة: الاسم مطلوب، وكل حقل لا يزيد على 200 حرف، والبريد يحوي «@». صحّح البيانات ثم أعد المحاولة.',
  invalid_person: 'الطلب غير صالح: يجب أن يحوي «bcPersonId» رقماً صحيحاً موجباً. اختر الشخص من القائمة ثم أعد المحاولة.',
  project_people_forbidden: 'لا تملك صلاحية إضافة أعضاء للمشروع؛ اطلب ذلك من مدير المشروع.',
  snapshot_unavailable: 'تعذّر قراءة محتوى الملف من التخزين، فلم يُنفَّذ شيء. أعد المحاولة بعد لحظات.',
  queue_unavailable: 'تعذّر تسجيل طلب المزامنة الآن. أعد المحاولة بعد لحظات، وإن تكرّر الخطأ فأبلغ مسؤول المنصة.',
} as const

export type SyncErrorKey = keyof typeof SYNC_MESSAGES

const SHAPE: Record<SyncErrorKey, { status: number; code: ApiErrorCode }> = {
  forbidden_link: { status: 403, code: 'forbidden' },
  forbidden_write: { status: 403, code: 'forbidden' },
  forbidden_contacts: { status: 403, code: 'forbidden' },
  admin_only: { status: 403, code: 'forbidden' },
  already_linked: { status: 409, code: 'workbook_already_linked' },
  not_linked: { status: 409, code: 'workbook_not_linked' },
  invalid_plan: { status: 400, code: 'invalid_link_plan' },
  todolist_not_found: { status: 404, code: 'basecamp_todolist_not_found' },
  todolist_taken: { status: 409, code: 'invalid_link_plan' },
  project_taken: { status: 409, code: 'basecamp_project_taken' },
  link_contended: { status: 409, code: 'version_conflict' },
  conflict_not_found: { status: 404, code: 'not_found' },
  conflict_resolved: { status: 409, code: 'conflict_already_resolved' },
  restore_refused: { status: 409, code: 'sheet_write_refused' },
  invalid_contact: { status: 400, code: 'invalid_request' },
  invalid_person: { status: 400, code: 'invalid_request' },
  project_people_forbidden: { status: 403, code: 'forbidden' },
  snapshot_unavailable: { status: 500, code: 'snapshot_missing' },
  queue_unavailable: { status: 503, code: 'queue_unavailable' },
}

/** Thrown by the sync routes. `message` replaces the generic text when a refusal can name its cause (e.g. the sheet). */
export class SyncFailure extends Error {
  override readonly name = 'SyncFailure'
  readonly key: SyncErrorKey
  readonly arabic: string

  constructor(key: SyncErrorKey, arabic?: string) {
    super(key)
    this.key = key
    this.arabic = arabic ?? SYNC_MESSAGES[key]
  }

  get status(): number {
    return SHAPE[this.key].status
  }
}

export function syncErrorBody(failure: SyncFailure): ApiError {
  return { ok: false, error: SHAPE[failure.key].code, message: failure.arabic }
}

/** `onError` of the sync sub-apps: SyncFailure, LinkFailure (token problems), ApiFailure. Never echoes internals. */
export function onSyncError(error: Error, c: Context<AppEnv>): Response {
  if (error instanceof SyncFailure) return jsonResponse(syncErrorBody(error), error.status)
  if (error instanceof LinkFailure) return linkErrorResponse(error.key)
  if (error instanceof ApiFailure) return jsonResponse(errorBody(error.key), error.status)
  console.error(`sync: unhandled ${error.name} on ${c.req.method} ${new URL(c.req.url).pathname}`)
  return jsonResponse(errorBody('internal'), 500)
}
