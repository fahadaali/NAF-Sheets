// Errors of the Basecamp link routes. Same body as every other route
// (`ApiError`, built with src/errors.ts `jsonResponse`); messages are Arabic
// and say what happened and what to do (spec §12.2).
//
// Codes follow apps/api/OPEN_QUESTIONS.md "Basecamp link" B8 (decided
// 2026-11-10): a Basecamp-specific code wherever the web app must act
// differently; the remaining refusals keep the general code and the precise
// reason is in `message`. Not linked / expired / revoked (and the service
// account's not linked) also carry `link`, like naf-auth's `login`.

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

/** Navigation that (re)links: the web app appends `?next=` (`&next=` for the service account). */
const START_PATH = '/auth/basecamp/start'
const SERVICE_START_PATH = '/auth/basecamp/start?service=1'

const SHAPE: Record<LinkErrorKey, { status: number; code: ApiErrorCode; link?: string }> = {
  not_configured: { status: 503, code: 'basecamp_not_configured' },
  service_admin_only: { status: 403, code: 'forbidden' },
  admin_only: { status: 403, code: 'forbidden' },
  state_invalid: { status: 403, code: 'basecamp_state_invalid' },
  authorization_denied: { status: 403, code: 'basecamp_authorization_denied' },
  launchpad_refused: { status: 403, code: 'forbidden' },
  basecamp_unavailable: { status: 503, code: 'basecamp_unavailable' },
  account_missing: { status: 403, code: 'basecamp_account_missing' },
  not_a_user: { status: 403, code: 'forbidden' },
  service_not_admin: { status: 403, code: 'forbidden' },
  person_taken: { status: 409, code: 'basecamp_person_taken' },
  not_linked: { status: 403, code: 'basecamp_not_linked', link: START_PATH },
  link_expired: { status: 403, code: 'basecamp_link_expired', link: START_PATH },
  link_revoked: { status: 403, code: 'basecamp_link_revoked', link: START_PATH },
  service_not_linked: { status: 409, code: 'basecamp_service_not_linked', link: SERVICE_START_PATH },
  project_not_found: { status: 404, code: 'basecamp_project_not_found' },
  todoset_disabled: { status: 404, code: 'basecamp_todoset_disabled' },
  invalid_match: { status: 400, code: 'invalid_request' },
  member_not_found: { status: 404, code: 'not_found' },
  person_not_found: { status: 404, code: 'not_found' },
  person_already_matched: { status: 409, code: 'person_already_matched' },
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
  const { code, link } = SHAPE[key]
  return link ? { ok: false, error: code, message: LINK_MESSAGES[key], link } : { ok: false, error: code, message: LINK_MESSAGES[key] }
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
