// Errors of the Google import routes. Same body shape as `ApiError`
// (packages/shared/src/api.ts): `{ ok: false, error, message }`, the message
// in Arabic saying what happened and what to do (spec §12.2).
//
// The codes below are part of the contract's `ApiErrorCode` (added for
// OPEN_QUESTIONS.md "Google import" G8; the type check under
// `GoogleImportErrorCode` keeps the two in step). Errors that already have a code and a message in
// ../errors.ts (forbidden, invalid_json, invalid_title, not_found for a
// workbook) are thrown as `ApiFailure` and answered by `app.onError`.

import type { ApiErrorCode } from '@naf-sheets/shared'
import { GOOGLE_START_PATH } from './config'

export const GOOGLE_MESSAGES = {
  google_not_configured: 'الاستيراد من Google Sheets غير مهيّأ في المنصة بعد. أبلغ مسؤول المنصة ليضبط إعدادات ربط Google.',
  google_not_linked: 'لم تربط حسابك في Google بعد، فتعذّرت قراءة الملف. اربط حسابك في Google ثم أعد الاستيراد.',
  google_link_expired: 'انتهت صلاحية ربط حسابك في Google، فتعذّرت قراءة الملف. أعد ربط حسابك في Google ثم أعد الاستيراد.',
  google_state_invalid: 'طلب ربط Google منتهي الصلاحية أو لم يبدأ من جلستك هذه، فلم يُربط شيء. ابدأ الربط من جديد من شاشة الاستيراد.',
  invalid_source: 'الرابط أو المعرّف ليس لملف Google Sheets. افتح الملف في Google Sheets، وانسخ الرابط من شريط العنوان، ثم أعد المحاولة.',
  google_file_forbidden: 'حسابك المربوط في Google لا يملك صلاحية فتح هذا الملف. اطلب من مالك الملف مشاركته مع حسابك، أو أعد الربط بالحساب الذي يملك الصلاحية، ثم أعد الاستيراد.',
  google_file_not_found: 'لم يُعثر على الملف في Google Sheets. تأكّد من الرابط، وأنه ملف Google Sheets لا ملف Excel مرفوع إلى Drive، ثم أعد المحاولة.',
  google_file_too_large: 'الملف أكبر من الحد المسموح للاستيراد، فلم يُستورد شيء. احذف الأوراق أو الصفوف والأعمدة الفارغة في نسخة من الملف ثم استورد النسخة.',
  google_no_sheets: 'لا يحتوي الملف على ورقة بيانات يمكن استيرادها؛ أوراق الرسوم البيانية لا تُستورد. أضف ورقة بيانات إلى الملف ثم أعد الاستيراد.',
  google_rate_limited: 'تجاوزت الطلبات إلى Google الحد المسموح مؤقتاً، فلم يُستورد شيء. انتظر دقيقة ثم أعد الاستيراد.',
  google_unavailable: 'تعذّر الوصول إلى Google Sheets الآن، فلم يُستورد شيء. أعد المحاولة بعد لحظات، وإن تكرّر الخطأ فأبلغ مسؤول المنصة.',
  google_bad_response: 'ردّت Google على طلب قراءة الملف بخطأ غير متوقّع، فلم يُستورد شيء. أعد المحاولة، وإن تكرّر الخطأ فأبلغ مسؤول المنصة.',
  import_report_not_found: 'لا يوجد تقرير استيراد لهذا الملف لأنه لم يُستورد من Google Sheets. التقرير متاح للملفات المستوردة فقط.',
} as const

export type GoogleErrorKey = keyof typeof GOOGLE_MESSAGES

/** Machine codes this module adds to the contract's `ApiErrorCode`. */
export type GoogleImportErrorCode =
  | 'google_not_configured'
  | 'google_not_linked'
  | 'google_link_expired'
  | 'google_state_invalid'
  | 'invalid_source'
  | 'google_file_forbidden'
  | 'google_file_not_found'
  | 'google_file_too_large'
  | 'google_no_sheets'
  | 'google_rate_limited'
  | 'google_unavailable'
  | 'google_bad_response'

// Compile-time guard: every code this module sends must exist in the contract.
const _codesInContract: GoogleImportErrorCode extends ApiErrorCode ? true : never = true
void _codesInContract

const CODES: Record<GoogleErrorKey, GoogleImportErrorCode | ApiErrorCode> = {
  google_not_configured: 'google_not_configured',
  google_not_linked: 'google_not_linked',
  google_link_expired: 'google_link_expired',
  google_state_invalid: 'google_state_invalid',
  invalid_source: 'invalid_source',
  google_file_forbidden: 'google_file_forbidden',
  google_file_not_found: 'google_file_not_found',
  google_file_too_large: 'google_file_too_large',
  google_no_sheets: 'google_no_sheets',
  google_rate_limited: 'google_rate_limited',
  google_unavailable: 'google_unavailable',
  google_bad_response: 'google_bad_response',
  import_report_not_found: 'not_found',
}

export type GoogleErrorStatus = 400 | 403 | 404 | 409 | 413 | 422 | 429 | 502 | 503

export interface GoogleErrorBody {
  ok: false
  error: GoogleImportErrorCode | ApiErrorCode
  message: string
  /**
   * Not linked / expired only: where to send the browser to (re)link Google.
   * The web app appends `?next=<the page it is on>`, as with naf-auth's `login`.
   */
  link?: string
}

/** Thrown inside the Google routes; turned into a response by `respond()`. */
export class GoogleImportFailure extends Error {
  readonly status: GoogleErrorStatus
  readonly key: GoogleErrorKey
  /** Seconds, for 429/503 only. */
  readonly retryAfter: number | null

  constructor(status: GoogleErrorStatus, key: GoogleErrorKey, options: { retryAfter?: number | null } = {}) {
    super(key)
    this.status = status
    this.key = key
    this.retryAfter = options.retryAfter ?? null
  }
}

export function googleErrorBody(key: GoogleErrorKey): GoogleErrorBody {
  const body: GoogleErrorBody = { ok: false, error: CODES[key], message: GOOGLE_MESSAGES[key] }
  if (key === 'google_not_linked' || key === 'google_link_expired') body.link = GOOGLE_START_PATH
  return body
}

export function googleErrorResponse(failure: GoogleImportFailure): Response {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  if (failure.retryAfter !== null) headers.set('retry-after', String(failure.retryAfter))
  return new Response(JSON.stringify(googleErrorBody(failure.key)), { status: failure.status, headers })
}
