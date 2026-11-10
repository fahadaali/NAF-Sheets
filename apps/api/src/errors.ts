// Every non-2xx JSON body is `ApiError` (packages/shared/src/api.ts).
// Messages are Arabic and say what happened and what to do (spec §12.2).

import type { ApiError, ApiErrorCode } from '@naf-sheets/shared'

/** Stable machine codes → Arabic message. */
export const MESSAGES = {
  unauthorized: 'انتهت جلستك أو لم تسجّل الدخول بعد. سجّل الدخول من جديد ثم أعد المحاولة.',
  access_denied: 'حسابك غير مفعّل في هذه المنصة. تواصل مع مسؤول المنصة ليمنحك الوصول.',
  auth_unavailable: 'تعذّر التحقق من جلستك الآن لتعثّر خدمة الدخول. أعد المحاولة بعد لحظات.',
  forbidden_create: 'لا تملك صلاحية إنشاء الملفات. اطلب من مسؤول المنصة منحك دور «محرّر».',
  forbidden_write: 'لا تملك صلاحية تعديل هذا الملف. اطلب من مالك الملف أو مسؤول المنصة منحك صلاحية التحرير.',
  forbidden_members: 'إدارة أعضاء الملف مقصورة على مالكه ومسؤول المنصة. اطلب التغيير من مالك الملف.',
  workbook_not_found: 'لم يُعثر على الملف، أو ليس لك وصول إليه. تأكّد من الرابط، أو اطلب من مالك الملف إضافتك.',
  route_not_found: 'المسار المطلوب غير موجود. تأكّد من العنوان ثم أعد المحاولة.',
  webhook_not_found: 'عنوان الاستقبال غير معروف. تحقّق من إعداد الـ Webhook في Basecamp.',
  invalid_json: 'جسم الطلب ليس JSON صالحاً. أرسل البيانات بصيغة JSON ثم أعد المحاولة.',
  invalid_title: 'عنوان الملف مطلوب، ولا يزيد على 200 حرف. اكتب عنواناً صالحاً ثم أعد المحاولة.',
  unsupported_source: 'إنشاء الملفات متاح حالياً من «ملف فارغ» فقط. اختر «ملف فارغ» ثم أعد المحاولة.',
  invalid_snapshot: 'محتوى الملف المرسل غير صالح، فلم يُحفظ شيء. أعد تحميل الملف ثم أعد المحاولة.',
  invalid_base_version: 'رقم نسخة الملف مفقود أو غير صالح، فلم يُحفظ شيء. أعد تحميل الملف ثم أعد المحاولة.',
  version_conflict: 'حُفظت نسخة أحدث من هذا الملف قبل حفظ تعديلاتك، فلم يُحفظ شيء. أعد تحميل الملف ثم أعد تطبيق تعديلاتك.',
  room_active: 'الملف مفتوح الآن للتحرير المشترك، وتُحفظ تعديلاته من هناك، فلم يُحفظ هذا الطلب. أعد تحميل الملف لتنضم إلى التحرير المشترك ثم أعد تطبيق تعديلاتك.',
  invalid_members: 'قائمة الأعضاء غير صالحة: يجب أن يكون لكل عضو معرّف ودور («محرّر» أو «قارئ») دون تكرار. صحّح القائمة ثم أعد المحاولة.',
  owner_in_members: 'مالك الملف لا يُضاف إلى قائمة الأعضاء لأن له كل الصلاحيات أصلاً. احذفه من القائمة ثم أعد المحاولة.',
  unknown_user: 'بعض الأشخاص المختارين ليسوا أعضاء في المنصة بعد. يجب أن يسجّل كل منهم الدخول مرة واحدة أولاً، ثم أعد المحاولة.',
  websocket_required: 'هذا العنوان يقبل اتصال WebSocket فقط. افتح الملف من المنصة ليتصل تلقائياً.',
  room_forbidden: 'تعذّر فتح الاتصال اللحظي بالملف لأن صلاحيتك عليه لم يُتحقَّق منها. افتح الملف من المنصة ليتصل تلقائياً.',
  snapshot_missing: 'تعذّر تحميل محتوى الملف من التخزين. أعد المحاولة بعد لحظات، وإن تكرّر الخطأ فأبلغ مسؤول المنصة.',
  queue_unavailable: 'تعذّر تسجيل الحدث للمعالجة. سيعيد Basecamp الإرسال تلقائياً؛ وإن تكرّر الخطأ فأبلغ مسؤول المنصة.',
  internal: 'حدث خطأ غير متوقّع في الخادم ولم يكتمل الطلب. أعد المحاولة، وإن تكرّر الخطأ فأبلغ مسؤول المنصة.',
} as const

export type ErrorKey = keyof typeof MESSAGES

/** The machine code sent in `ApiError.error` for each message key (the contract's `ApiErrorCode`). */
const CODES: Record<ErrorKey, ApiErrorCode> = {
  unauthorized: 'unauthorized',
  access_denied: 'access_denied',
  auth_unavailable: 'auth_unavailable',
  forbidden_create: 'forbidden',
  forbidden_write: 'forbidden',
  forbidden_members: 'forbidden',
  workbook_not_found: 'not_found',
  route_not_found: 'not_found',
  webhook_not_found: 'not_found',
  invalid_json: 'invalid_json',
  invalid_title: 'invalid_title',
  unsupported_source: 'unsupported_source',
  invalid_snapshot: 'invalid_snapshot',
  invalid_base_version: 'invalid_base_version',
  version_conflict: 'version_conflict',
  room_active: 'room_active',
  invalid_members: 'invalid_members',
  owner_in_members: 'owner_in_members',
  unknown_user: 'unknown_user',
  websocket_required: 'websocket_required',
  room_forbidden: 'forbidden',
  snapshot_missing: 'snapshot_missing',
  queue_unavailable: 'queue_unavailable',
  internal: 'internal',
}

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 426 | 500 | 503

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

export function errorResponse(status: ErrorStatus, key: ErrorKey): Response {
  return jsonResponse(errorBody(key), status)
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
