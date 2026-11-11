// Errors of the .xlsx upload and the public Google Sheets link (owner
// decision 2026-11-11). Same body as `ApiError`: Arabic, what happened and
// what to do (spec §12.2). Codes are in the contract's `ApiErrorCode`
// (packages/shared/src/api.ts); the type check below keeps them in step.

import type { ApiErrorCode } from '@naf-sheets/shared'
import { XLSX_MAX_FILE_BYTES } from '@naf-sheets/shared'
import type { XlsxErrorCode } from '@naf-sheets/xlsx-import'

const MB = Math.round(XLSX_MAX_FILE_BYTES / (1024 * 1024))

/** How to get a Google file in without a link: the user downloads it and uploads it. */
const DOWNLOAD_HINT = 'أو نزّل الملف من Google Sheets عبر «ملف ← تنزيل ← Microsoft Excel (‎.xlsx‎)» وارفعه من «رفع ملف Excel».'

export const XLSX_MESSAGES = {
  xlsx_length_required: 'لم يصل حجم الملف مع الطلب، فلم يُستورد شيء. أعد رفع الملف من شاشة «ملف جديد».',
  xlsx_empty: 'الملف المرفوع فارغ، فلم يُستورد شيء. اختر ملف Excel يحتوي على بيانات ثم أعد المحاولة.',
  xlsx_file_too_large: `الملف أكبر من الحد المسموح للاستيراد (${MB} ميغابايت)، فلم يُستورد شيء. احذف الأوراق أو الصور غير اللازمة في نسخة من الملف ثم ارفع النسخة.`,
  xlsx_not_xlsx: 'الملف ليس ملف Excel بصيغة ‎.xlsx‎، فلم يُستورد شيء. افتحه في Excel أو Google Sheets واحفظه بصيغة ‎.xlsx‎ ثم ارفعه.',
  xlsx_legacy_or_encrypted:
    'الملف بصيغة Excel القديمة (‎.xls‎) أو محمي بكلمة مرور، فتعذّرت قراءته. افتحه في Excel، وأزل كلمة المرور إن وُجدت، واحفظه بصيغة ‎.xlsx‎ ثم ارفعه.',
  xlsx_corrupt: 'تعذّرت قراءة الملف لأنه تالف أو غير مكتمل، فلم يُستورد شيء. افتحه في Excel أو Google Sheets واحفظه من جديد بصيغة ‎.xlsx‎ ثم أعد المحاولة.',
  xlsx_unpacked_too_large:
    'محتوى الملف أكبر من الحد المسموح للاستيراد (عدد الخلايا أو حجم البيانات بعد فكّ الضغط)، فلم يُستورد شيء. قسّم الملف إلى ملفات أصغر أو احذف الأوراق والصفوف غير اللازمة ثم أعد المحاولة.',
  xlsx_no_sheets: 'لا يحتوي الملف على ورقة بيانات يمكن استيرادها؛ أوراق الرسوم البيانية لا تُستورد. أضف ورقة بيانات إلى الملف ثم أعد المحاولة.',
  invalid_source: `الرابط ليس رابط ملف Google Sheets، فلم يُستورد شيء. افتح الملف في Google Sheets وانسخ الرابط من شريط العنوان ثم أعد المحاولة، ${DOWNLOAD_HINT}`,
  gsheets_link_private: `تعذّر تنزيل الملف لأنه غير مشارك بالرابط، فقد طلبت Google تسجيل الدخول. افتح الملف في Google Sheets واختر «مشاركة» ثم «أي شخص لديه الرابط» بصلاحية «عارض» وأعد المحاولة، ${DOWNLOAD_HINT}`,
  gsheets_link_not_found: `لم يُعثر على الملف في Google Sheets، فربما حُذف أو الرابط غير صحيح. افتح الرابط في المتصفح للتأكّد منه ثم أعد المحاولة، ${DOWNLOAD_HINT}`,
  gsheets_link_too_large: `ملف Google Sheets أكبر من الحد المسموح للاستيراد (${MB} ميغابايت بصيغة Excel)، فلم يُستورد شيء. احذف الأوراق أو الصفوف غير اللازمة في نسخة من الملف ثم استورد النسخة.`,
  gsheets_link_rate_limited: `رفضت Google التنزيل مؤقتاً لكثرة الطلبات، فلم يُستورد شيء. انتظر دقيقة ثم أعد المحاولة، ${DOWNLOAD_HINT}`,
  gsheets_link_unavailable: `تعذّر تنزيل الملف من Google الآن، فلم يُستورد شيء. أعد المحاولة بعد لحظات، ${DOWNLOAD_HINT}`,
} as const

export type XlsxErrorKey = keyof typeof XLSX_MESSAGES

/** Every key is its own contract code. */
const _codesInContract: XlsxErrorKey extends ApiErrorCode ? true : never = true
void _codesInContract

export type XlsxErrorStatus = 400 | 403 | 404 | 411 | 413 | 415 | 422 | 429 | 502 | 503

export class XlsxRouteFailure extends Error {
  readonly status: XlsxErrorStatus
  readonly key: XlsxErrorKey
  readonly retryAfter: number | null

  constructor(status: XlsxErrorStatus, key: XlsxErrorKey, retryAfter: number | null = null) {
    super(key)
    this.status = status
    this.key = key
    this.retryAfter = retryAfter
  }
}

/** The reader's failure as the API answers it. */
export function fromReaderError(code: XlsxErrorCode): XlsxRouteFailure {
  switch (code) {
    case 'not_xlsx':
      return new XlsxRouteFailure(415, 'xlsx_not_xlsx')
    case 'legacy_or_encrypted':
      return new XlsxRouteFailure(415, 'xlsx_legacy_or_encrypted')
    case 'too_large':
      return new XlsxRouteFailure(413, 'xlsx_unpacked_too_large')
    case 'no_sheets':
      return new XlsxRouteFailure(422, 'xlsx_no_sheets')
    default:
      return new XlsxRouteFailure(422, 'xlsx_corrupt')
  }
}

export function xlsxErrorResponse(failure: XlsxRouteFailure): Response {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  if (failure.retryAfter !== null) headers.set('retry-after', String(failure.retryAfter))
  return new Response(JSON.stringify({ ok: false, error: failure.key, message: XLSX_MESSAGES[failure.key] }), { status: failure.status, headers })
}
