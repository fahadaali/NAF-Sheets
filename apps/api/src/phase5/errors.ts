// Refusals and messages of the phase 5 routes (contract:
// packages/shared/src/api-phase5.ts). Same body as every other route
// (`ApiError`); messages are Arabic and say what happened and what to do
// (spec §12.2), never apologising.

import type { Context } from 'hono'
import type { ApiError, ApiErrorCode } from '@naf-sheets/shared'
import type { AppEnv } from '../auth'
import { LinkFailure, linkErrorResponse } from '../basecamp-link/errors'
import { ApiFailure, errorBody, jsonResponse } from '../errors'

/** "100 ميغابايت", "512 كيلوبايت", "900 بايت": Latin digits (spec §12.2). */
export function formatBytes(bytes: number): string {
  const mib = 1024 * 1024
  if (bytes >= mib) {
    const v = bytes / mib
    return `${Number.isInteger(v) ? v : v.toFixed(1)} ميغابايت`
  }
  if (bytes >= 1024) {
    const v = bytes / 1024
    return `${Number.isInteger(v) ? v : v.toFixed(1)} كيلوبايت`
  }
  return `${bytes} بايت`
}

export const P5_MESSAGES = {
  forbidden_write:
    'لا تملك صلاحية التعديل على هذا الملف؛ يمكنك الاطلاع على المرفقات والتعليقات فقط. اطلب من مالك الملف أو مسؤول المنصة صلاحية التحرير.',
  admin_only: 'تعديل حدود المرفقات مقصور على مسؤول المنصة. اطلب التغيير من مسؤول المنصة.',
  task_not_found: 'لم يُعثر على هذا الصف في المنصة، فربما لم يُحفظ بعد أو حُذف. انتظر حتى تظهر حالة المزامنة على الصف ثم أعد المحاولة.',
  task_not_in_basecamp: 'هذه المهمة لم تصل إلى Basecamp بعد، فلم يُنفَّذ الطلب. انتظر حتى تظهر حالة «متزامن» على الصف ثم أعد المحاولة.',
  task_deleted_remotely: 'هذه المهمة محذوفة أو مؤرشفة في Basecamp، فلم يُنفَّذ الطلب. استرجعها في Basecamp أولاً ثم أعد المحاولة.',
  task_busy: 'تجري مزامنة هذه المهمة الآن، فلم يكتمل الطلب ولم يتغيّر شيء في Basecamp. أعد المحاولة بعد لحظات.',
  attachment_not_found: 'لم يُعثر على هذا المرفق، فربما أُزيل من قبل. حدّث القائمة ثم أعد المحاولة.',
  attachment_gone_remotely: 'لم يعد هذا الملف موجوداً في Basecamp، فتعذّر تنزيله. حدّث القائمة؛ وإن بقي فيها فاطلب من صاحبه رفعه من جديد.',
  length_required: 'لم يُرسل حجم الملف مع الطلب، فلم يُرفع شيء. ارفع الملف من المنصة نفسها ثم أعد المحاولة.',
  upload_incomplete: 'وصل الملف ناقصاً أو بحجم يخالف المعلن، فلم يُحفظ شيء. أعد رفع الملف.',
  attachment_empty: 'الملف فارغ (0 بايت)، فلم يُرفع. اختر الملف الصحيح ثم أعد المحاولة.',
  attachment_invalid_name: 'اسم الملف مفقود أو غير صالح أو أطول من 255 حرفاً، فلم يُرفع. أعد تسمية الملف ثم ارفعه من جديد.',
  attachment_not_confirmed: 'لم تُؤكَّد إزالة المرفق، فلم يُزل شيء. أكّد الإزالة في الحوار ثم أعد المحاولة.',
  attachment_not_retryable: 'هذا المرفق لا يحتاج إعادة إرسال إلى Basecamp. حدّث القائمة لترى حالته.',
  storage_failed: 'تعذّر حفظ الملف في المنصة، فلم يُرفع شيء. أعد المحاولة بعد لحظات، وإن تكرّر الخطأ فأبلغ مسؤول المنصة.',
  basecamp_access_denied:
    'رفض Basecamp الطلب لأن حسابك لا يصل إلى هذه المهمة هناك (قد لا تكون عضواً في المشروع). اطلب من مدير المشروع في Basecamp إضافتك ثم أعد المحاولة.',
  invalid_settings: 'حد حجم المرفقات يجب أن يكون عدداً صحيحاً من 1 بايت إلى 100 ميغابايت. صحّح القيمة ثم احفظ.',
} as const

export type P5ErrorKey = keyof typeof P5_MESSAGES | 'attachment_too_large' | 'comment_invalid'

const SHAPE: Record<P5ErrorKey, { status: number; code: ApiErrorCode }> = {
  forbidden_write: { status: 403, code: 'forbidden' },
  admin_only: { status: 403, code: 'forbidden' },
  task_not_found: { status: 404, code: 'task_not_found' },
  task_not_in_basecamp: { status: 409, code: 'task_not_in_basecamp' },
  task_deleted_remotely: { status: 409, code: 'task_deleted_remotely' },
  task_busy: { status: 409, code: 'task_busy' },
  attachment_not_found: { status: 404, code: 'attachment_not_found' },
  attachment_gone_remotely: { status: 404, code: 'attachment_not_found' },
  length_required: { status: 411, code: 'attachment_length_required' },
  upload_incomplete: { status: 400, code: 'invalid_request' },
  attachment_empty: { status: 400, code: 'attachment_empty' },
  attachment_invalid_name: { status: 400, code: 'attachment_invalid_name' },
  attachment_not_confirmed: { status: 400, code: 'attachment_not_confirmed' },
  attachment_not_retryable: { status: 409, code: 'attachment_not_retryable' },
  storage_failed: { status: 500, code: 'internal' },
  basecamp_access_denied: { status: 403, code: 'basecamp_access_denied' },
  invalid_settings: { status: 400, code: 'invalid_request' },
  attachment_too_large: { status: 413, code: 'attachment_too_large' },
  comment_invalid: { status: 400, code: 'comment_invalid' },
}

export const tooLargeMessage = (maxBytes: number): string =>
  `حجم الملف أكبر من الحد المسموح (${formatBytes(maxBytes)})، فلم يُرفع شيء. اختر ملفاً أصغر أو اضغطه ثم أعد المحاولة.`

export const commentInvalidMessage = (max: number): string => `نص التعليق فارغ أو أطول من ${max} حرف، فلم يُرسل شيء. اكتب تعليقاً ثم أعد الإرسال.`

/** Thrown by the phase 5 routes; `arabic` replaces the generic text when the refusal can name its cause. */
export class Phase5Failure extends Error {
  override readonly name = 'Phase5Failure'
  readonly key: P5ErrorKey
  readonly arabic: string

  constructor(key: keyof typeof P5_MESSAGES)
  constructor(key: P5ErrorKey, arabic: string)
  constructor(key: P5ErrorKey, arabic?: string) {
    super(key)
    this.key = key
    this.arabic = arabic ?? P5_MESSAGES[key as keyof typeof P5_MESSAGES]
  }

  get status(): number {
    return SHAPE[this.key].status
  }
}

export function phase5ErrorBody(failure: Phase5Failure): ApiError {
  return { ok: false, error: SHAPE[failure.key].code, message: failure.arabic }
}

/** `onError` of the phase 5 sub-apps. Never echoes internals (a token can sit in an error's cause). */
export function onPhase5Error(error: Error, c: Context<AppEnv>): Response {
  if (error instanceof Phase5Failure) return jsonResponse(phase5ErrorBody(error), error.status)
  if (error instanceof LinkFailure) return linkErrorResponse(error.key)
  if (error instanceof ApiFailure) return jsonResponse(errorBody(error.key), error.status)
  console.error(`phase5: unhandled ${error.name} on ${c.req.method} ${new URL(c.req.url).pathname}`)
  return jsonResponse(errorBody('internal'), 500)
}

/**
 * Why a file stayed in the platform when its Basecamp step failed
 * (`attachments.last_error`, shown on its chip with «إعادة المحاولة»).
 */
export const ATTACHMENT_FAILURES = {
  not_linked: 'لم يُرسل الملف إلى Basecamp لأن حسابك غير مربوط به أو انتهت صلاحية ربطه، فبقي في المنصة. اربط حسابك في Basecamp ثم اضغط «إعادة المحاولة».',
  forbidden: 'رفض Basecamp إرفاق الملف لأن حسابك لا يصل إلى هذه المهمة هناك، فبقي في المنصة. اطلب من مدير المشروع في Basecamp إضافتك، ثم اضغط «إعادة المحاولة».',
  not_found: 'لم يُعثر على المهمة في Basecamp، فلم يُرفق الملف بها وبقي في المنصة. تأكّد أن المهمة موجودة في Basecamp ثم اضغط «إعادة المحاولة».',
  rejected: 'رفض Basecamp الملف (قد يكون نوعه أو حجمه غير مقبول هناك)، فبقي في المنصة فقط. جرّب ملفاً آخر، أو اضغط «إعادة المحاولة».',
  unavailable: 'تعذّر الوصول إلى Basecamp، فبقي الملف في المنصة ولم يُرفق بالمهمة هناك. اضغط «إعادة المحاولة» بعد لحظات.',
  busy: 'كانت المهمة تُزامَن لحظة الرفع، فبقي الملف في المنصة ولم يُرفق بها في Basecamp. اضغط «إعادة المحاولة» بعد لحظات.',
  deleted_remotely: 'المهمة محذوفة أو مؤرشفة في Basecamp، فبقي الملف في المنصة. استرجع المهمة في Basecamp ثم اضغط «إعادة المحاولة».',
  account_inactive: 'حساب Basecamp غير نشط، فبقي الملف في المنصة ولم يُرسل. أبلغ مسؤول المنصة ليراجع حالة الحساب.',
  unexpected: 'ردّ Basecamp بما لا تتوقعه المنصة، فبقي الملف فيها ولم يُرفق بالمهمة هناك. اضغط «إعادة المحاولة»، وإن تكرّر الخطأ فأبلغ مسؤول المنصة.',
} as const

export type AttachmentFailureCode = keyof typeof ATTACHMENT_FAILURES

/** Notices over a task's list of files (`TaskAttachmentsResponse.notice`). */
export const ATTACHMENT_NOTICES = {
  subtask_local: 'المهام الفرعية في Basecamp لا تقبل مرفقات، فمرفقات هذا الصف تبقى في المنصة ولا تظهر في Basecamp.',
  sheet_local: 'هذه الورقة لا تُزامَن مع Basecamp، فمرفقات صفوفها تبقى في المنصة.',
  not_in_basecamp: 'هذه المهمة لم تصل إلى Basecamp بعد؛ يمكن إرفاق الملفات بعد أن تظهر حالة «متزامن» على الصف.',
  deleted_remotely: 'هذه المهمة محذوفة أو مؤرشفة في Basecamp، فلا يمكن إرفاق ملفات بها الآن.',
} as const
