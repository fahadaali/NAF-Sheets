// Stable codes with their Arabic messages (spec §12.2: every message says what
// happened and what to do; no apologies). Codes are the contract for callers
// and logs; messages are for people.
//
// Two kinds:
// - A refusal (`SheetError`): the operation changed nothing.
// - An issue (`SheetIssue`): about one row or cell; the rest went ahead. An
//   issue on a row means: do not send that row to Basecamp until it is resolved.

import type { TaskUid } from '@naf-sheets/shared'
import { ENGINE_ERROR_MESSAGES } from './engine'

export type SheetErrorCode =
  | 'sheet_not_found'
  | 'system_columns_missing'
  | 'system_columns_duplicated'
  | 'invalid_header_row'
  | 'invalid_column_key'
  | 'title_column_missing'
  | 'hierarchy_required'
  | 'invalid_hierarchy'
  | 'row_not_found'
  | 'third_level_not_allowed'
  | 'parent_has_subtasks'
  | 'no_parent_above'
  | 'no_free_row'
  | 'merged_cells'
  | 'unsupported_formula'
  | 'range_split'
  | 'unsupported_resource'
  | 'parent_not_found'
  | 'title_required'
  | 'uid_exists'
  | 'move_unplaced_cells'
  | 'move_formula_cells'
  | 'unclassified_plan_required'

export type SheetIssueCode =
  | 'untracked_row'
  | 'duplicate_uid'
  | 'invalid_level'
  | 'invalid_hierarchy'
  | 'empty_title'
  | 'invalid_date'
  | 'unknown_assignee'
  | 'ambiguous_assignee'
  | 'checkbox_formula'
  | 'formula_cell'
  | 'assignee_name_unknown'
  | 'note_occupied'

export const ERROR_MESSAGES: Readonly<Record<SheetErrorCode, string>> = {
  sheet_not_found: 'لم يُعثر على الورقة في الملف، فربما حُذفت أو أُعيدت تسميتها. حدّث الملف ثم أعد المحاولة.',
  system_columns_missing:
    'لم تُقرأ الورقة: أعمدة النظام المخفية (__uid و__parent_uid و__level) غير موجودة في صف العناوين. أعد ربط الورقة من لوحة إعدادات الورقة.',
  system_columns_duplicated:
    'لم تُقرأ الورقة: أحد أعمدة النظام المخفية مكرر في صف العناوين، فلا يُعرف أيهما الصحيح. احذف العمود المكرر أو تواصل مع مدير المنصة.',
  invalid_header_row: 'رقم صف العناوين غير صالح. اختر صف العناوين من لوحة إعدادات الورقة ثم أعد المحاولة.',
  invalid_column_key: 'مطابقة الأعمدة تشير إلى عمود غير صالح. راجع مطابقة الأعمدة في لوحة إعدادات الورقة ثم احفظها.',
  title_column_missing:
    'لا يوجد في مطابقة الأعمدة عمود للعنوان، والمزامنة تحتاجه. اختر عمود «المهمة» في مطابقة الأعمدة ثم احفظها.',
  hierarchy_required:
    'لم تُنشأ أعمدة النظام: الورقة مضبوطة على اكتشاف المهام الفرعية، ولم تُرسل نتيجة الاكتشاف. أعد تشغيل معالج الربط.',
  invalid_hierarchy:
    'لم تُنشأ أعمدة النظام: نتيجة اكتشاف المهام الفرعية فيها مهمة فرعية بلا مهمة رئيسية فوقها. راجع الهرمية في معالج الربط ثم أعد المحاولة.',
  row_not_found: 'لم يُعثر على الصف المطلوب في الورقة، فربما حُذف أو نُقل. حدّث الورقة ثم أعد المحاولة.',
  // The hierarchy rules are sync-engine's (src/engine.ts); so are their messages.
  third_level_not_allowed: ENGINE_ERROR_MESSAGES.third_level_not_allowed,
  parent_has_subtasks: ENGINE_ERROR_MESSAGES.parent_has_subtasks,
  no_parent_above: ENGINE_ERROR_MESSAGES.no_parent_above,
  no_free_row:
    'لم يُضف الصف: الصف الذي يلي آخر مهمة في الورقة ليس فارغاً، ولا تكتب المنصة فوق بيانات موجودة. اترك صفاً فارغاً تحت آخر مهمة ثم أعد المزامنة.',
  merged_cells:
    'لم يُنقل الصف: في الصفوف المتأثرة خلايا مدمجة، ونقلها يفسد الدمج. ألغِ دمج الخلايا في جدول المهام ثم أعد المزامنة.',
  unsupported_formula:
    'لم يُنقل الصف: في الصفوف المتأثرة معادلة لا تستطيع المنصة نقلها دون تغيير معناها (معادلة مصفوفة أو صيغة غير مدعومة). انقل الصف يدوياً ثم أعد المزامنة.',
  range_split:
    'لم يُنقل الصف: نقله يقسم نطاق الفلتر في الورقة إلى جزأين. أزل الفلتر أو وسّعه ليشمل جدول المهام كله ثم أعد المزامنة.',
  unsupported_resource:
    'لم يُنقل الصف: في الورقة عناصر مرتبطة بمواضع الصفوف لا تعرف المنصة نقلها (مثل الصور). انقل الصف يدوياً ثم أعد المزامنة.',
  parent_not_found:
    'لم تُضف المهمة الفرعية: مهمتها الرئيسية غير موجودة في الورقة. أعد المزامنة بعد إضافة المهمة الرئيسية.',
  title_required: 'لم يُضف الصف: عنوان المهمة فارغ، وBasecamp لا يقبل مهمة بلا عنوان. أعد المزامنة بعد تصحيح العنوان في Basecamp.',
  uid_exists: 'لم يُضف الصف: في الورقة صف يحمل المعرّف نفسه. حدّث الورقة ثم أعد المزامنة.',
  move_unplaced_cells:
    'لم يُنقل الصف إلى الورقة الأخرى: فيه قيم في أعمدة لا مقابل لها في تلك الورقة، ولا تحذف المنصة بيانات. أضف الأعمدة الناقصة بالعناوين نفسها في الورقة الهدف ثم أعد المزامنة.',
  move_formula_cells:
    'لم يُنقل الصف إلى الورقة الأخرى: فيه معادلات قد يتغير معناها عند نقلها. انقل الصف يدوياً ثم أعد المزامنة.',
  unclassified_plan_required:
    'لم يُنقل الصف إلى ورقة «غير مصنّف»: الورقة موجودة ولم تُرسل مطابقة أعمدتها. أعد المزامنة بعد ضبط مطابقة أعمدة تلك الورقة.',
}

export const ISSUE_MESSAGES: Readonly<Record<SheetIssueCode, string>> = {
  untracked_row:
    'هذا الصف لا يحمل معرّف مهمة بعد، فلن يُزامَن. احفظ الورقة لتُنشأ له هوية، أو أعد ربط الورقة.',
  duplicate_uid:
    'هذا الصف يحمل معرّف مهمة مكرراً في صف آخر (غالباً بعد نسخ صف كامل)، فلن يُزامَن أيٌّ منهما. احذف النسخة الزائدة أو تواصل مع مدير المنصة.',
  invalid_level: 'قيمة المستوى المخفية في هذا الصف غير صالحة، فلن يُزامَن. تواصل مع مدير المنصة لإصلاح الصف.',
  invalid_hierarchy:
    'هذه المهمة الفرعية ليست تحت مهمتها الرئيسية مباشرة (ربما بعد فرز أو نقل)، فلن تُزامَن. أعدها تحت مهمتها الرئيسية أو حوّلها مهمة رئيسية.',
  empty_title: 'عنوان هذه المهمة فارغ، وBasecamp لا يقبل مهمة بلا عنوان. اكتب عنواناً للمهمة.',
  invalid_date: 'التاريخ في هذه الخلية غير مفهوم، فلن يُزامَن هذا الصف. اكتب التاريخ بالصيغة YYYY-MM-DD.',
  unknown_assignee:
    'اسم في خلية المسؤول لا يطابق أحداً من أعضاء المشروع أو الجهات الخارجية، فلن يُزامَن هذا الصف. اختر المسؤول من القائمة.',
  ambiguous_assignee:
    'اسم في خلية المسؤول يطابق أكثر من شخص، فلن يُزامَن هذا الصف. اختر المسؤول من القائمة لتحديده.',
  checkbox_formula:
    'مربع الاختيار في عمود الحالة يعتمد على معادلة لا تقرؤها المنصة، فلن يُزامَن هذا الصف. اجعل قيمتي مربع الاختيار ثابتتين.',
  formula_cell:
    'لم تُكتب القيمة الواردة من Basecamp: الخلية فيها معادلة، ولا تكتب المنصة فوق المعادلات. احذف المعادلة إن أردت أن تُحدَّث الخلية من Basecamp.',
  assignee_name_unknown:
    'لم تُحدَّث خلية المسؤول: أحد المسؤولين غير موجود في قائمة الأعضاء والجهات الخارجية في المنصة. حدّث قائمة أعضاء المشروع ثم أعد المزامنة.',
  note_occupied:
    'لم يُضف تلميح «لا يُزامَن مع Basecamp» لأن على الخلية ملاحظة كتبها مستخدم. لا حاجة لإجراء؛ الخلية ما زالت مميّزة بصرياً.',
}

export interface SheetError {
  code: SheetErrorCode
  message: string
  /** Extra context for logs (a column header, a cell address); never shown alone. */
  detail?: string
}

export interface SheetIssue {
  code: SheetIssueCode
  message: string
  /** Univer sheet id (the key in `workbook.sheets`). */
  sheetId: string
  /** 0-based row in the sheet. */
  row: number
  /** 0-based column, when the issue is about one cell. */
  column?: number
  uid?: TaskUid
  /** Extra context for logs (the unreadable text, the duplicated uid…). */
  detail?: string
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: SheetError }

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function sheetError(code: SheetErrorCode, detail?: string): SheetError {
  return detail === undefined ? { code, message: ERROR_MESSAGES[code] } : { code, message: ERROR_MESSAGES[code], detail }
}

export function fail<T>(code: SheetErrorCode, detail?: string): Result<T> {
  return { ok: false, error: sheetError(code, detail) }
}

export function issue(
  code: SheetIssueCode,
  at: { sheetId: string; row: number; column?: number; uid?: TaskUid; detail?: string },
): SheetIssue {
  const out: SheetIssue = { code, message: ISSUE_MESSAGES[code], sheetId: at.sheetId, row: at.row }
  if (at.column !== undefined) out.column = at.column
  if (at.uid !== undefined) out.uid = at.uid
  if (at.detail !== undefined) out.detail = at.detail
  return out
}
