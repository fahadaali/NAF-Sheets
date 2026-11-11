// Import report (spec §7.2 "تقرير الاستيراد"): counts of what was transferred,
// and every item that was not transferred, transferred as a static value, or
// changed on the way, each with a location the UI can link to.
//
// Messages are Arabic (spec §12.2): what happened, then what to do.

import type { IRange } from '@univerjs/core'
import { quoteSheetName, sheetRef } from './a1'

export type ImportItemOutcome =
  /** Nothing of it reached the workbook (its cells' own values and formats may have). */
  | 'not_transferred'
  /** Kept as its last computed value; no longer recalculates. */
  | 'value_only'
  /** Transferred in a different form (e.g. alternating colours as static fills). */
  | 'converted'

export type ImportItemKind =
  | 'unsupported_formula'
  | 'image'
  | 'derived_value'
  | 'pivot_table'
  | 'data_source_table'
  | 'data_source_sheet'
  | 'object_sheet'
  | 'chart'
  | 'slicer'
  | 'filter_view'
  | 'protected_range'
  | 'banded_range'
  | 'conditional_format'
  | 'data_validation'
  | 'filter'
  | 'filter_criteria'
  | 'hyperlink'
  | 'smart_chip'
  | 'number_format'
  | 'table'
  | 'row_group'
  | 'column_group'
  | 'comment'
  | 'named_range'
  | 'theme_color'
  // .xlsx imports (@naf-sheets/xlsx-import)
  /** A Google checkbox that the .xlsx export wrote as a plain TRUE/FALSE, restored as a checkbox. */
  | 'checkbox'
  /** A picture placed over the grid. */
  | 'drawing_image'
  /** A shape, text box or form control placed over the grid. */
  | 'drawing_shape'
  /** Something the file holds that the platform has no place for (macros, sparklines, links to other files…). */
  | 'unsupported_feature'
  /** A cell format the platform shows differently (patterned fill, gradient). */
  | 'cell_format'

export interface ImportLocation {
  /** Univer sheet id in the converted workbook. */
  sheetId: string
  sheetName: string
  /** Inclusive, 0-based. Null: the whole sheet. */
  range: IRange | null
  /** `'المهام'!B4:C10`, or `'المهام'` for the whole sheet. */
  ref: string
}

export interface ImportReportItem {
  kind: ImportItemKind
  outcome: ImportItemOutcome
  /** Null: the workbook as a whole. */
  location: ImportLocation | null
  /** Arabic, for the report screen. */
  message: string
  /** Original formula, chart title, URL… as found in the source. */
  detail?: string
}

export interface ImportCounts {
  sheets: number
  /** Cells holding a value, a formula or rich text (style-only cells are not counted). */
  cells: number
  /** Formulas kept as formulas. */
  formulas: number
  /** Formulas replaced by their last computed value. */
  valueOnlyFormulas: number
  styles: number
  merges: number
  conditionalFormatRules: number
  dataValidationRules: number
  filters: number
  notes: number
  hyperlinks: number
  richTextCells: number
  definedNames: number
}

export interface ImportedSheetInfo {
  googleSheetId: number | null
  sheetId: string
  name: string
  hidden: boolean
  rightToLeft: boolean
}

/**
 * Where an import came from (owner decision 2026-11-11: .xlsx upload and
 * public Google Sheets links, besides the Sheets API).
 *   google_api     the Sheets API (`spreadsheets.get`)
 *   google_export  an .xlsx that Google Sheets wrote (the platform's own
 *                  download of a public link, or File → Download → .xlsx)
 *   excel          an .xlsx that Microsoft Excel wrote
 *   other          an .xlsx from another program (named in `application` when it says)
 */
export type ImportOriginKind = 'google_api' | 'google_export' | 'excel' | 'other'

/** How the file reached the platform. */
export type ImportVia = 'google_api' | 'upload' | 'google_link'

export interface ImportOrigin {
  kind: ImportOriginKind
  via: ImportVia
  /** docProps/app.xml `<Application>`, when the file names its writer. */
  application: string | null
  /** The uploaded file's name (upload only). */
  fileName?: string | null
  /** The workbook's default font as the file states it (Calibri 11, Arial 10…); .xlsx only. */
  defaultFont?: { family: string | null; size: number | null } | null
  /** Date serial system of the file; .xlsx only (`date1904`: the Mac 1904 system, kept as is). */
  dateSystem?: 'date1900' | 'date1904'
  /**
   * Alignment is written as given: the file's "left" is stored as the
   * platform's start of the line (the right side on a right-to-left sheet),
   * CLAUDE.md §2 "Alignment is logical".
   */
  alignment: 'as_given'
}

export interface ImportReport {
  /** `origin` is absent in reports stored before 2026-11-11 (all of them from the Sheets API). */
  source: { spreadsheetId: string | null; title: string; locale: string | null; origin?: ImportOrigin }
  counts: ImportCounts
  sheets: ImportedSheetInfo[]
  items: ImportReportItem[]
}

export function emptyCounts(): ImportCounts {
  return {
    sheets: 0,
    cells: 0,
    formulas: 0,
    valueOnlyFormulas: 0,
    styles: 0,
    merges: 0,
    conditionalFormatRules: 0,
    dataValidationRules: 0,
    filters: 0,
    notes: 0,
    hyperlinks: 0,
    richTextCells: 0,
    definedNames: 0,
  }
}

export function location(sheetId: string, sheetName: string, range: IRange | null): ImportLocation {
  return { sheetId, sheetName, range, ref: range ? sheetRef(sheetName, range) : quoteSheetName(sheetName) }
}

/** Arabic report messages. */
export const MESSAGES = {
  unsupportedFormula: (names: string[], from: string = GOOGLE_SHEETS) =>
    `المعادلة تستخدم دالة أو مرجعًا لا تحسبه المنصة كما يحسبه ${from} (${names.join('، ')})، فنُقلت آخر قيمة محسوبة لها وأُضيفت المعادلة الأصلية في ملاحظة الخلية. القيمة لن تتحدّث؛ أعد كتابة المعادلة بدوال مدعومة إن احتجت إلى تحديثها.`,
  imageFormula: () =>
    'الصورة المُدرجة بالدالة IMAGE لم تُنقل، وأُضيفت المعادلة الأصلية في ملاحظة الخلية. أضف الصورة مرفقًا إن احتجت إليها.',
  derivedValue: () =>
    'قيم ناتجة عن معادلة مصفوفة أو جدول محوري نُقلت قيمًا ثابتة لا تتحدّث. راجعها في الملف الأصلي إن احتجت إلى تحديثها.',
  pivotTable: () =>
    'الجدول المحوري لم يُنقل؛ الجداول المحورية خارج الإصدار الأول. نُقلت نتائجه الحالية قيمًا ثابتة، وراجع الجدول في الملف الأصلي.',
  dataSourceTable: () =>
    'جدول مصدر البيانات لم يُنقل اتصاله بمصدره، ونُقلت قيمه الحالية قيمًا ثابتة. حدّثها يدويًا عند الحاجة.',
  dataSourceSheet: () =>
    'ورقة مصدر البيانات نُقلت قيمًا ثابتة دون اتصالها بمصدرها. حدّث قيمها يدويًا عند الحاجة.',
  objectSheet: () =>
    'ورقة الرسم البياني لم تُنقل؛ الرسوم البيانية خارج الإصدار الأول. راجعها في الملف الأصلي.',
  chart: () => 'الرسم البياني لم يُنقل؛ الرسوم البيانية خارج الإصدار الأول. راجعه في الملف الأصلي.',
  slicer: () => 'أداة التقطيع (Slicer) لم تُنقل؛ غير مدعومة في الإصدار الأول. استخدم فلتر الورقة بدلًا منها.',
  filterView: () => 'عرض الفلتر لم يُنقل؛ عروض الفلاتر خارج الإصدار الأول. أعد ضبطه بفلتر الورقة إن احتجت إليه.',
  protectedRange: () =>
    'حماية النطاق لم تُنقل؛ صلاحيات التعديل في المنصة تُدار من أعضاء الملف. راجع الأعضاء وأدوارهم بعد الاستيراد.',
  bandedRangeConverted: () =>
    'الألوان المتناوبة حُوّلت إلى تعبئة ثابتة، فلن تتناوب الألوان تلقائيًا في الصفوف المضافة لاحقًا. لوّن الصفوف الجديدة يدويًا عند الحاجة.',
  bandedRangeNotTransferred: () =>
    'الألوان المتناوبة لم تُنقل لتعذّر قراءة ألوانها من سمة الملف. لوّن النطاق يدويًا إن احتجت إليها.',
  conditionalFormat: (reason: string) =>
    `قاعدة التنسيق الشرطي لم تُنقل: ${reason}. أعد إنشاءها يدويًا من التنسيق الشرطي.`,
  dataValidation: (reason: string) => `قاعدة التحقق من البيانات لم تُنقل: ${reason}. أعد إنشاءها يدويًا.`,
  filter: (reason: string) => `فلتر الورقة لم يُنقل: ${reason}. أعد إنشاءه يدويًا.`,
  filterCriteria: (reason: string) =>
    `معيار الفلتر على هذا العمود لم يُنقل: ${reason}. نُقل نطاق الفلتر فقط؛ أعد ضبط المعيار من زر الفلتر.`,
  hyperlinkNotText: () => 'الرابط في هذه الخلية لم يُنقل لأن قيمتها ليست نصًا. أضف الرابط يدويًا.',
  hyperlinkPlainText: () => 'الرابط في هذه الخلية لم يُنقل لأنه مضبوط في الملف الأصلي على العرض نصًا عاديًا.',
  smartChip: () => 'الشريحة الذكية (شخص أو ملف) لم تُنقل، وبقي نص الخلية فقط. أضف الرابط أو الشخص يدويًا.',
  numberFormat: (type: string) =>
    `تنسيق الأرقام (${type}) لم يُنقل لأن الملف الأصلي لم يحدّد نمطه. اضبط تنسيق هذه الخلايا يدويًا.`,
  table: () => 'خصائص الجدول (الاسم وأنواع الأعمدة) لم تُنقل، ونُقلت بياناته وتنسيقه.',
  rowGroup: () => 'تجميع الصفوف لم يُنقل؛ غير مدعوم في الإصدار الأول.',
  columnGroup: () => 'تجميع الأعمدة لم يُنقل؛ غير مدعوم في الإصدار الأول.',
  comment: () => 'سلسلة التعليقات لم تُنقل؛ التعليقات في المنصة تُضاف من لوحة التفاصيل.',
  namedRange: (reason: string) => `النطاق المسمّى لم يُنقل: ${reason}. المعادلات التي تستخدمه قد تُظهر خطأ؛ أعد تعريفه يدويًا.`,
  checkbox: () =>
    'قيم TRUE وFALSE في هذه الخلايا كانت مربعات اختيار في Google Sheets، وملف Excel المصدَّر منه لا يحفظها مربعات، فأُعيدت مربعات اختيار. إن كانت قيمًا عادية فاحذف قاعدة التحقق من البيانات عنها.',
  drawingImage: () => 'الصورة الموضوعة فوق الخلايا لم تُنقل؛ الصور العائمة غير مدعومة في الإصدار الأول. أضفها مرفقًا إن احتجت إليها.',
  drawingShape: () => 'الشكل أو مربع النص أو عنصر التحكم الموضوع فوق الخلايا لم يُنقل. راجعه في الملف الأصلي.',
  excelTable: () =>
    'جدول Excel نُقلت بياناته وتنسيق خلاياه، ولم تُنقل خصائصه (الاسم، الأعمدة المحسوبة، نمط الجدول). المعادلات التي تشير إلى الجدول باسمه نُقلت قيمًا.',
  tableStyleConverted: () =>
    'ألوان نمط الجدول (العنوان والصفوف المتناوبة) حُوّلت إلى تعبئة ثابتة، فلن تتلوّن الصفوف المضافة لاحقًا تلقائيًا.',
  tableStyleNotTransferred: (name: string) =>
    `نمط الجدول ${name} من الأنماط المضمّنة في Excel ولا يحمل الملف ألوانه، فلم يُنقل. لوّن رأس الجدول وصفوفه يدويًا إن احتجت إليها.`,
  macros: () => 'وحدات الماكرو (VBA) لا تُنقل ولا تعمل في المنصة. الخلايا ونتائجها الحالية نُقلت.',
  sparklines: () => 'خطوط المؤشرات (Sparklines) لم تُنقل؛ غير مدعومة في الإصدار الأول.',
  externalLinks: () =>
    'الملف يرتبط بملفات أخرى، والمعادلات التي تقرأ منها نُقلت قيمًا ثابتة. حدّث القيم يدويًا عند الحاجة.',
  dataConnections: () => 'اتصالات البيانات الخارجية في الملف لم تُنقل، ونُقلت القيم الحالية فقط.',
  excelCheckboxes: () =>
    'مربعات الاختيار في Excel نُقلت قيمًا TRUE وFALSE. أضف قاعدة «مربع اختيار» من التحقق من البيانات إن احتجت إليها.',
  printSettings: () => 'إعدادات الطباعة (نطاق الطباعة والعناوين المكرّرة) لم تُنقل؛ الطباعة خارج الإصدار الأول.',
  patternFill: () => 'تعبئة بنقش أو تدرّج لونيّ نُقلت لونًا واحدًا ثابتًا. راجع ألوان الخلايا المتأثرة.',
  threadedComment: () => 'التعليق لم يُنقل؛ التعليقات في المنصة تُضاف من لوحة تفاصيل المهمة.',
  themeColor: (types: string[]) =>
    `تعذّر تحويل ألوان من سمة الملف (${types.join('، ')})، فتُركت بلا لون. راجع تلوين الخلايا المتأثرة.`,
} as const

/** The program a Google API import comes from, as the messages name it. */
export const GOOGLE_SHEETS = 'Google Sheets'

/** Arabic note text added to a cell whose formula was replaced by its value. */
export function formulaNote(formula: string, existingNote: string | undefined, from: string = GOOGLE_SHEETS): string {
  const line = `المعادلة الأصلية من ${from} (غير مدعومة في المنصة، ونُقلت قيمتها فقط): ${formula}`
  return existingNote ? `${existingNote}\n\n${line}` : line
}
