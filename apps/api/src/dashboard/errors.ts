// Refusals and messages of the dashboard and appearance routes (contract:
// packages/shared/src/api-dashboard.ts). Same body as every other route
// (`ApiError`); messages are Arabic and say what happened and what to do
// (spec §12.2), never apologising.

import type { Context } from 'hono'
import type { ApiError, ApiErrorCode } from '@naf-sheets/shared'
import { MAX_WIDGETS_PER_WORKBOOK, WIDGET_TITLE_MAX_LENGTH } from '@naf-sheets/shared'
import type { AppEnv } from '../auth'
import { ApiFailure, errorBody, jsonResponse } from '../errors'

export const DASHBOARD_MESSAGES = {
  forbidden_write: 'لا تملك صلاحية تعديل لوحة هذا الملف؛ يمكنك الاطلاع عليها فقط. اطلب من مالك الملف أو مسؤول المنصة صلاحية التحرير.',
  admin_only: 'تعديل مظهر المنصة مقصور على مسؤول المنصة. اطلب التغيير من مسؤول المنصة.',
  widget_not_found: 'لم يُعثر على هذا العنصر في اللوحة، فربما أُزيل من قبل. حدّث اللوحة ثم أعد المحاولة.',
  invalid_widget: `إعداد العنصر غير صالح: اختر ورقة، وعموداً (حرف مثل C) أو نطاقاً (مثل B2:B30)، وطريقة حساب وطريقة عرض، والعنوان من 1 إلى ${WIDGET_TITLE_MAX_LENGTH} حرف. صحّح الإعداد ثم احفظ.`,
  widget_not_confirmed: 'لم تُؤكَّد إزالة العنصر، فلم يُزل شيء. أكّد الإزالة في الحوار ثم أعد المحاولة.',
  widget_limit: `بلغت اللوحة الحد الأعلى (${MAX_WIDGETS_PER_WORKBOOK} عنصراً)، فلم يُضف العنصر. أزل عنصراً لا تحتاجه ثم أعد المحاولة.`,
  invalid_order: 'ترتيب العناصر المرسل لا يطابق عناصر اللوحة الحالية، فلم يتغيّر شيء. حدّث اللوحة ثم أعد الترتيب.',
  invalid_palette:
    'ألوان المظهر غير صالحة، فلم يُحفظ شيء: كل لون بصيغة #RRGGBB (ستة أرقام ست عشرية)، ولأسماء الألوان المعروفة فقط. صحّح القيم ثم احفظ.',
  snapshot_missing: 'تعذّر قراءة محتوى الملف من التخزين، فلم تُحسب اللوحة. أعد المحاولة بعد لحظات، وإن تكرّر الخطأ فأبلغ مسؤول المنصة.',
} as const

/** Why one widget shows no figure (`WidgetResult.message`); the rest of the dashboard still shows. */
export const WIDGET_MESSAGES = {
  sheet_missing: 'الورقة التي يقرأ منها هذا العنصر لم تعد في الملف (ربما حُذفت). عدّل العنصر واختر ورقة أخرى.',
  invalid_source: 'العمود أو النطاق في هذا العنصر غير صالح. عدّل العنصر واكتب حرف عمود (مثل C) أو نطاقاً (مثل B2:B30).',
  invalid_group: 'عمود التجميع في هذا العنصر غير صالح. عدّل العنصر واكتب حرف عمود (مثل A) أو أزل التجميع.',
  range_too_large: 'النطاق في هذا العنصر أكبر من أن يُحسب (أكثر من 200000 خلية). عدّل العنصر واختر نطاقاً أصغر.',
} as const

export type DashboardErrorKey = keyof typeof DASHBOARD_MESSAGES

const SHAPE: Record<DashboardErrorKey, { status: number; code: ApiErrorCode }> = {
  forbidden_write: { status: 403, code: 'forbidden' },
  admin_only: { status: 403, code: 'forbidden' },
  widget_not_found: { status: 404, code: 'widget_not_found' },
  invalid_widget: { status: 400, code: 'invalid_widget' },
  widget_not_confirmed: { status: 400, code: 'widget_not_confirmed' },
  widget_limit: { status: 409, code: 'widget_limit' },
  invalid_order: { status: 409, code: 'invalid_request' },
  invalid_palette: { status: 400, code: 'invalid_palette' },
  snapshot_missing: { status: 500, code: 'snapshot_missing' },
}

export class DashboardFailure extends Error {
  override readonly name = 'DashboardFailure'
  readonly key: DashboardErrorKey

  constructor(key: DashboardErrorKey) {
    super(key)
    this.key = key
  }

  get status(): number {
    return SHAPE[this.key].status
  }
}

export function dashboardErrorBody(key: DashboardErrorKey): ApiError {
  return { ok: false, error: SHAPE[key].code, message: DASHBOARD_MESSAGES[key] }
}

/** `onError` of the dashboard sub-apps. Never echoes internals. */
export function onDashboardError(error: Error, c: Context<AppEnv>): Response {
  if (error instanceof DashboardFailure) return jsonResponse(dashboardErrorBody(error.key), error.status)
  if (error instanceof ApiFailure) return jsonResponse(errorBody(error.key), error.status)
  console.error(`dashboard: unhandled ${error.name} on ${c.req.method} ${new URL(c.req.url).pathname}`)
  return jsonResponse(errorBody('internal'), 500)
}
