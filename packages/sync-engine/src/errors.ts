// Stable error and warning codes with their Arabic messages (spec §12.2:
// every message says what happened and what to do; no apologies).
//
// Codes are the contract for callers and logs; messages are for people.

import type { TaskUid } from '@naf-sheets/shared'

/** A refused operation: nothing was changed. */
export type EngineErrorCode =
  | 'external_requires_follower'
  | 'follower_not_project_member'
  | 'third_level_not_allowed'
  | 'parent_has_subtasks'
  | 'no_parent_above'
  | 'row_not_found'
  | 'invalid_move_target'
  | 'subtask_needs_parent'
  | 'snapshot_required'

/** Something `diffTask` held back or could not decide; the row may need attention. */
export type EngineWarningCode =
  | 'remote_required'
  | 'parent_not_synced'
  | 'hierarchy_change_unsupported'
  | 'invalid_local_assignees'
  | 'follower_removed_remotely'
  | 'directory_incomplete'
  | 'order_conflict'

export const ERROR_MESSAGES: Readonly<Record<EngineErrorCode, string>> = {
  external_requires_follower:
    'لم يُحفظ الإسناد: كل مسؤولي المهمة جهات خارجية، ولا بد أن يبقى لها في Basecamp مسؤول من أعضاء المشروع. حدّد متابعاً داخلياً ثم احفظ.',
  follower_not_project_member:
    'لم يُحفظ الإسناد: المتابع الداخلي المختار ليس عضواً في مشروع Basecamp. اختر متابعاً من أعضاء المشروع ثم احفظ.',
  third_level_not_allowed:
    'لم تُنفَّذ الإزاحة: الصف مهمة فرعية أصلاً، وBasecamp يسمح بمستوى واحد فقط من المهام الفرعية. أبقِه مهمة فرعية، أو أعِده مهمة رئيسية بـ Shift+Tab.',
  parent_has_subtasks:
    'لم تُنفَّذ الإزاحة: لهذه المهمة مهام فرعية، وتحويلها إلى فرعية ينشئ مستوى ثالثاً لا يسمح به Basecamp. أعِد مهامها الفرعية رئيسية أولاً ثم أعد المحاولة.',
  no_parent_above:
    'لم تُنفَّذ الإزاحة: لا توجد مهمة رئيسية فوق هذا الصف لتكون أمّاً له. أضف مهمة رئيسية فوقه ثم أعد المحاولة.',
  row_not_found: 'لم يُعثر على الصف المطلوب، فربما حُذف أو نُقل. حدّث الورقة ثم أعد المحاولة.',
  invalid_move_target:
    'لم يُنقل الصف: لا يمكن وضع مهمة رئيسية بين المهام الفرعية لمهمة أخرى. اختر موضعاً قبل مهمة رئيسية أو في آخر الورقة.',
  subtask_needs_parent:
    'لم يُنقل الصف: المهمة الفرعية تحتاج مهمة رئيسية فوقها. انقلها إلى موضع تحت مهمة رئيسية.',
  snapshot_required:
    'لم تُحذف المهمة الفرعية: حذفها من Basecamp نهائي، ويلزم حفظ نسخة كاملة منها قبل الحذف، والنسخة غير متاحة. أعد تحميل المهمة من Basecamp ثم أعد الحذف.',
}

export const WARNING_MESSAGES: Readonly<Record<EngineWarningCode, string>> = {
  remote_required:
    'لم يُرسل التحديث إلى Basecamp بعد: يلزم جلب المهمة من Basecamp أولاً، لأن التحديث الناقص يمسح حقولها هناك. اجلب المهمة ثم أعد المزامنة.',
  parent_not_synced:
    'لم تُنشأ المهمة الفرعية في Basecamp بعد: مهمتها الرئيسية لم تُنشأ هناك. ستُنشأ بعد إنشاء المهمة الرئيسية.',
  hierarchy_change_unsupported:
    'لم يُزامَن نقل الصف بين المستويات أو بين المهام الرئيسية: هذا التغيير غير مدعوم في المزامنة مع Basecamp. أعد الصف إلى موضعه السابق لتستمر مزامنته.',
  invalid_local_assignees:
    'لم تُرسل تعديلات المهمة إلى Basecamp: كل مسؤوليها جهات خارجية دون متابع داخلي. حدّد متابعاً داخلياً من أعضاء المشروع.',
  follower_removed_remotely:
    'أُزيل المتابع الداخلي من المهمة في Basecamp، فبقيت مسؤولياتها لجهات خارجية فقط. حدّد متابعاً داخلياً للمهمة.',
  directory_incomplete:
    'لم تُحدَّث كتلة بيانات المنصة في وصف المهمة: أسماء بعض المسؤولين غير متاحة في المنصة. حدّث قائمة الأعضاء والجهات الخارجية ثم أعد المزامنة.',
  order_conflict:
    'تغيّر موضع المهمة في المنصة وفي Basecamp معاً، فاعتُمد الموضع الأحدث. راجع موضع الصف في الورقة.',
}

export interface EngineError {
  code: EngineErrorCode
  message: string
}

export interface EngineWarning {
  uid: TaskUid
  code: EngineWarningCode
  message: string
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: EngineError }

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function engineError(code: EngineErrorCode): EngineError {
  return { code, message: ERROR_MESSAGES[code] }
}

export function fail<T>(code: EngineErrorCode): Result<T> {
  return { ok: false, error: engineError(code) }
}

export function warning(uid: TaskUid, code: EngineWarningCode): EngineWarning {
  return { uid, code, message: WARNING_MESSAGES[code] }
}
