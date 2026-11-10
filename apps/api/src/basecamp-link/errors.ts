// Errors of the Basecamp link routes. Same body as every other route
// (`ApiError`, built with src/errors.ts `jsonResponse`); messages are Arabic
// and say what happened and what to do (spec §12.2).
//
// OPEN: the contract's `ApiErrorCode` (packages/shared/src/api.ts) is closed
// and has no Basecamp-specific code. Each failure below uses the nearest
// existing code; the precise reason is in `message` only. Proposed new codes
// are listed in apps/api/OPEN_QUESTIONS.md ("Basecamp link" B8).

import type { Context } from 'hono'
import type { ApiError, ApiErrorCode } from '@naf-sheets/shared'
import type { AppEnv } from '../auth'
import { ApiFailure, errorBody, jsonResponse } from '../errors'

export const LINK_MESSAGES = {
  not_configured: 'ربط Basecamp غير مهيّأ في المنصة بعد، فلم يُنفَّذ شيء. أبلغ مسؤول المنصة ليكمل إعداده.',
  service_admin_only: 'ربط حساب الخدمة في Basecamp مقصور على مسؤول المنصة. اربط حسابك الشخصي بدلاً منه، أو اطلب ذلك من مسؤول المنصة.',
  admin_only: 'مطابقة أعضاء المنصة بأشخاص Basecamp مقصورة على مسؤول المنصة. اطلب التغيير من مسؤول المنصة.',
  state_invalid: 'طلب الربط انتهت مهلته أو لم يبدأ من حسابك، فلم يُربط شيء. ابدأ ربط حسابك في Basecamp من جديد من داخل المنصة.',
  authorization_denied: 'لم يُمنح الإذن في Basecamp، فلم يُربط شيء. ابدأ الربط من جديد واختر السماح للمنصة بالوصول.',
  launchpad_refused: 'رفض Basecamp إكمال الربط، فلم يُربط شيء. ابدأ ربط حسابك من جديد، وإن تكرّر الخطأ فأبلغ مسؤول المنصة.',
  basecamp_unavailable: 'تعذّر الوصول إلى Basecamp الآن، فلم يكتمل الطلب. أعد المحاولة بعد لحظات.',
  account_missing: 'حسابك في Basecamp لا يصل إلى حساب ناف، فلم يُربط شيء. سجّل الدخول في Basecamp بالحساب العضو في حساب ناف ثم أعد الربط.',
  not_a_user: 'الحساب الذي سجّلت به في Basecamp ليس حساب شخص، فلم يُربط شيء. سجّل الدخول في Basecamp بحسابك الشخصي ثم أعد الربط.',
  service_not_admin: 'حساب الخدمة يجب أن يكون مديراً أو مالكاً في حساب ناف على Basecamp، فلم يُربط. سجّل الدخول في Basecamp بحساب مدير ثم أعد ربط حساب الخدمة.',
  person_taken: 'حساب Basecamp هذا مربوط بعضو آخر في المنصة، فلم يُربط شيء. سجّل الدخول في Basecamp بحسابك أنت، أو اطلب المساعدة من مسؤول المنصة.',
  not_linked: 'لم تربط حسابك في Basecamp بعد. اربط حسابك من «اربط حسابك في Basecamp» ثم أعد المحاولة.',
  link_expired: 'انتهت صلاحية ربط حسابك في Basecamp وتعذّر تجديده، فلم يُرسل شيء باسمك. أعد ربط حسابك ثم أعد المحاولة.',
  link_revoked: 'ألغيت ربط حسابك في Basecamp. أعد ربط حسابك ثم أعد المحاولة.',
  service_not_linked: 'حساب الخدمة في Basecamp غير مربوط أو انتهت صلاحيته. اربطه من «ربط حساب الخدمة» ثم أعد المحاولة.',
  project_not_found: 'لم يُعثر على المشروع في Basecamp، أو ليس لك وصول إليه. تأكّد من المشروع، أو اطلب من مديره في Basecamp إضافتك إليه.',
  todoset_disabled: 'أداة المهام غير مفعّلة في هذا المشروع على Basecamp. فعّلها من إعدادات المشروع في Basecamp ثم أعد المحاولة.',
  invalid_match: 'الطلب غير صالح: يجب أن يحوي «bcPersonId» رقماً صحيحاً موجباً أو null. صحّح الطلب ثم أعد المحاولة.',
  member_not_found: 'لم يُعثر على هذا العضو في المنصة. حدّث الصفحة ثم اختر عضواً من القائمة.',
  person_not_found: 'لم يُعثر على هذا الشخص بين أشخاص حساب ناف في Basecamp. حدّث القائمة ثم اختر شخصاً منها.',
  person_already_matched: 'هذا الشخص في Basecamp مطابَق لعضو آخر في المنصة. أزل تلك المطابقة أولاً ثم أعد المحاولة.',
} as const

export type LinkErrorKey = keyof typeof LINK_MESSAGES

const SHAPE: Record<LinkErrorKey, { status: number; code: ApiErrorCode }> = {
  not_configured: { status: 503, code: 'internal' },
  service_admin_only: { status: 403, code: 'forbidden' },
  admin_only: { status: 403, code: 'forbidden' },
  state_invalid: { status: 403, code: 'forbidden' },
  authorization_denied: { status: 403, code: 'forbidden' },
  launchpad_refused: { status: 403, code: 'forbidden' },
  basecamp_unavailable: { status: 503, code: 'internal' },
  account_missing: { status: 403, code: 'forbidden' },
  not_a_user: { status: 403, code: 'forbidden' },
  service_not_admin: { status: 403, code: 'forbidden' },
  person_taken: { status: 409, code: 'forbidden' },
  not_linked: { status: 403, code: 'forbidden' },
  link_expired: { status: 403, code: 'forbidden' },
  link_revoked: { status: 403, code: 'forbidden' },
  service_not_linked: { status: 409, code: 'forbidden' },
  project_not_found: { status: 404, code: 'not_found' },
  todoset_disabled: { status: 404, code: 'not_found' },
  invalid_match: { status: 400, code: 'invalid_json' },
  member_not_found: { status: 404, code: 'not_found' },
  person_not_found: { status: 404, code: 'not_found' },
  person_already_matched: { status: 409, code: 'forbidden' },
}

/** Thrown anywhere in the link code; the link routes' `onError` turns it into an `ApiError`. */
export class LinkFailure extends Error {
  override readonly name = 'LinkFailure'
  readonly key: LinkErrorKey

  constructor(key: LinkErrorKey) {
    super(key)
    this.key = key
  }

  get status(): number {
    return SHAPE[this.key].status
  }
}

export function linkErrorBody(key: LinkErrorKey): ApiError {
  return { ok: false, error: SHAPE[key].code, message: LINK_MESSAGES[key] }
}

export function linkErrorResponse(key: LinkErrorKey): Response {
  return jsonResponse(linkErrorBody(key), SHAPE[key].status)
}

/**
 * `onError` for the link sub-apps: the same contract as `app.onError` in
 * src/app.ts, plus `LinkFailure`. Never echoes internals: a token can sit in
 * an error's cause, so only the error's name is logged.
 */
export function onLinkError(error: Error, c: Context<AppEnv>): Response {
  if (error instanceof LinkFailure) return linkErrorResponse(error.key)
  if (error instanceof ApiFailure) return jsonResponse(errorBody(error.key), error.status)
  console.error(`basecamp-link: unhandled ${error.name} on ${c.req.method} ${new URL(c.req.url).pathname}`)
  return jsonResponse(errorBody('internal'), 500)
}
