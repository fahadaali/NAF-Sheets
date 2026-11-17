// Every non-2xx JSON body is `ApiError` (packages/shared/src/api.ts).
// Messages are Arabic and say what happened and what to do (spec §12.2).

import type { ApiError, ApiErrorCode } from '@naf-sheets/shared'

/** Stable machine codes → Arabic message. */
export const MESSAGES = {
  unauthorized: 'انتهت جلستك أو لم تسجّل الدخول بعد. سجّل الدخول من جديد ثم أعد المحاولة.',
  access_denied: 'حسابك غير مفعّل في هذه المنصة. تواصل مع مسؤول المنصة ليمنحك الوصول.',
  auth_unavailable: 'تعذّر التحقق من جلستك الآن لتعثّر خدمة الدخول. أعد المحاولة بعد لحظات.',
  route_not_found: 'المسار المطلوب غير موجود. تأكّد من العنوان ثم أعد المحاولة.',
  webhook_not_found: 'عنوان الاستقبال غير معروف. تحقّق من إعداد الـ Webhook في Basecamp.',
  invalid_json: 'جسم الطلب ليس JSON صالحاً. أرسل البيانات بصيغة JSON ثم أعد المحاولة.',
  queue_unavailable: 'تعذّر تسجيل الحدث للمعالجة. سيعيد Basecamp الإرسال تلقائياً؛ وإن تكرّر الخطأ فأبلغ مسؤول المنصة.',
  internal: 'حدث خطأ غير متوقّع في الخادم ولم يكتمل الطلب. أعد المحاولة، وإن تكرّر الخطأ فأبلغ مسؤول المنصة.',
  // Admin-only routes and backups (src/phase7).
  admin_only: 'هذا الإجراء مقصور على مسؤول المنصة. اطلبه من مسؤول المنصة.',
  invalid_backup_retention:
    'قيم الاحتفاظ بالنسخ الاحتياطية غير صالحة: عدد النسخ اليومية عدد صحيح من 1 إلى 365، وعدد الأشهر عدد صحيح من 0 إلى 120. صحّحهما ثم أعد المحاولة.',
  // Platform members «أعضاء المنصة» (src/routes/platform-members.ts).
  platform_member_not_found: 'لم يُعثر على هذا العضو في المنصة. حدّث الصفحة ثم اختر عضواً من القائمة.',
  invalid_member_change:
    'الطلب غير صالح: أرسل «role» بإحدى القيم admin أو editor أو viewer، أو «active» بقيمة true أو false، أو كليهما. صحّح الطلب ثم أعد المحاولة.',
  cannot_change_self:
    'لا يمكنك تغيير دورك أو إيقاف حسابك بنفسك، حتى لا تفقد المنصة إدارتها بالخطأ. اطلب ذلك من مسؤول آخر للمنصة.',
  last_active_admin:
    'لم يُحفظ التغيير: هذا آخر مسؤول نشط في المنصة، وبدونه لا يستطيع أحد إدارتها. رقِّ عضواً آخر إلى «مسؤول» أولاً، ثم أعد المحاولة.',
  member_changed: 'تغيّر دور هذا العضو أو حالته في أثناء طلبك، فلم يُحفظ شيء. حدّث الصفحة ثم أعد المحاولة.',
} as const

export type ErrorKey = keyof typeof MESSAGES

/** The machine code sent in `ApiError.error` for each message key (the contract's `ApiErrorCode`). */
const CODES: Record<ErrorKey, ApiErrorCode> = {
  unauthorized: 'unauthorized',
  access_denied: 'access_denied',
  auth_unavailable: 'auth_unavailable',
  route_not_found: 'not_found',
  webhook_not_found: 'not_found',
  invalid_json: 'invalid_json',
  queue_unavailable: 'queue_unavailable',
  internal: 'internal',
  admin_only: 'forbidden',
  invalid_backup_retention: 'invalid_request',
  platform_member_not_found: 'not_found',
  invalid_member_change: 'invalid_request',
  cannot_change_self: 'cannot_change_self',
  last_active_admin: 'last_active_admin',
  member_changed: 'member_changed',
}

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 500 | 503

/** Thrown anywhere in a request; `app.onError` turns it into an `ApiError` response. */
export class ApiFailure extends Error {
  readonly status: ErrorStatus
  readonly key: ErrorKey

  constructor(status: ErrorStatus, key: ErrorKey) {
    super(key)
    this.status = status
    this.key = key
  }
}

export function errorBody(key: ErrorKey): ApiError {
  return { ok: false, error: CODES[key], message: MESSAGES[key] }
}

export function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Arabic message for a code naf-auth puts in its own JSON error bodies. */
export function messageForAuthCode(code: unknown): string | null {
  switch (code) {
    case 'unauthorized':
      return MESSAGES.unauthorized
    case 'access_denied':
      return MESSAGES.access_denied
    case 'auth_unavailable':
      return MESSAGES.auth_unavailable
    default:
      return null
  }
}
