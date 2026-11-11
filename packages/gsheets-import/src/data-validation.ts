// Google DataValidationRule (per cell) → Univer sheet data-validation rules
// (resource SHEET_DATA_VALIDATION_PLUGIN: `{ [sheetId]: ISheetDataValidationRule[] }`,
// data-validation/lib/es/index.js DataValidationResourceController).
//
// Google stores a rule on every cell; identical rules are grouped and their
// cells merged into rectangles (convert.ts). Mapping (Univer 1.4.0 read from
// sheets-data-validation and sheets-data-validation-ui; apps/api
// OPEN_QUESTIONS.md "Google import" G32 has the full table per origin):
//   ONE_OF_LIST     → list, formula1 = JSON array of the items (the form
//                     @univerjs/sheets serializeListOptions writes and
//                     deserializeListOptions reads)
//   ONE_OF_RANGE    → list, formula1 = "=<range>" (other sheets, defined
//                     names, INDIRECT and OFFSET are evaluated by Univer)
//   several items in a cell (convert.ts detects it) → listMultiple
//   item colours    → formula2 = colours aligned with the items, by position
//                     (DataValidationListCacheService.computeAndCache)
//   display style   → renderMode CUSTOM (chip) / ARROW / TEXT (plain)
//   NUMBER_*        → decimal + operator; whole numbers → whole; text length → textLength
//   DATE_*          → date + operator (ISO dates, serial numbers or formulas only)
//   DATE_IS_VALID   → date without operator
//   CUSTOM_FORMULA  → custom
//   BOOLEAN         → checkbox (no values, or checked/unchecked pair)
//   strict          → errorStyle STOP, else WARNING (Excel: its own three styles)
//   inputMessage    → prompt (+ promptTitle)
// Anything else is reported as not transferred; anything that changes on the
// way comes back as a note for the report.

import type { ISheetDataValidationRule } from '@univerjs/core'
import { findUnsupportedFunctions, normalizeConditionFormula } from './formula'
import { parsePlainNumber } from './conditional-format'
import type { GsDataValidationRule } from './google-types'
import type { ImportItemOutcome } from './report'
import { MESSAGES } from './report'
import { DV_ERROR_STYLE, DV_OPERATOR, DV_RENDER_MODE, DV_TYPE } from './univer-constants'

export type DvRuleBody = Omit<ISheetDataValidationRule, 'uid' | 'ranges'>
/** Something the report must say about a rule that was transferred. */
export interface DvNote {
  outcome: ImportItemOutcome
  message: string
}
export type DvConversion = { ok: true; rule: DvRuleBody; notes: DvNote[] } | { ok: false; reason: string }

export interface DvContext {
  /**
   * The items of a range list as Univer will list them (unique cell texts in
   * reading order), for aligning colours; null when only Univer can compute
   * them (INDIRECT, OFFSET…).
   */
  listItems?: string[] | null
  /** The cells hold several items each: Google's "Allow multiple selections". */
  multiple?: boolean
}

const NUMBER_OPS = {
  NUMBER_GREATER: DV_OPERATOR.GREATER_THAN,
  NUMBER_GREATER_THAN_EQ: DV_OPERATOR.GREATER_THAN_OR_EQUAL,
  NUMBER_LESS: DV_OPERATOR.LESS_THAN,
  NUMBER_LESS_THAN_EQ: DV_OPERATOR.LESS_THAN_OR_EQUAL,
  NUMBER_EQ: DV_OPERATOR.EQUAL,
  NUMBER_NOT_EQ: DV_OPERATOR.NOT_EQUAL,
  NUMBER_BETWEEN: DV_OPERATOR.BETWEEN,
  NUMBER_NOT_BETWEEN: DV_OPERATOR.NOT_BETWEEN,
} as const

const DATE_OPS = {
  DATE_EQ: DV_OPERATOR.EQUAL,
  DATE_BEFORE: DV_OPERATOR.LESS_THAN,
  DATE_AFTER: DV_OPERATOR.GREATER_THAN,
  DATE_ON_OR_BEFORE: DV_OPERATOR.LESS_THAN_OR_EQUAL,
  DATE_ON_OR_AFTER: DV_OPERATOR.GREATER_THAN_OR_EQUAL,
  DATE_BETWEEN: DV_OPERATOR.BETWEEN,
  DATE_NOT_BETWEEN: DV_OPERATOR.NOT_BETWEEN,
} as const

const TWO_VALUE_OPS = new Set<string>(['NUMBER_BETWEEN', 'NUMBER_NOT_BETWEEN', 'DATE_BETWEEN', 'DATE_NOT_BETWEEN'])

/** Google's colour for a chip nobody coloured (observed in Google's own rendering, 2026-11-11). */
export const GOOGLE_DEFAULT_CHIP_COLOR = '#e8eaed'

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
}

function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value)
}

export function convertDataValidation(rule: GsDataValidationRule, supportedFunctions: ReadonlySet<string>, context: DvContext = {}): DvConversion {
  const condition = rule.condition
  const type = condition?.type
  if (!type) return { ok: false, reason: 'القاعدة بلا شرط' }
  const values = condition?.values ?? []
  const raw = (i: number) => values[i]?.userEnteredValue
  const extra = rule.naf ?? {}
  const notes: DvNote[] = []

  // ---- options shared by every type ---------------------------------------------
  const errorStyle =
    extra.errorStyle === 'STOP' ? DV_ERROR_STYLE.STOP
    : extra.errorStyle === 'WARNING' ? DV_ERROR_STYLE.WARNING
    : extra.errorStyle === 'INFORMATION' ? DV_ERROR_STYLE.INFO
    : rule.strict ? DV_ERROR_STYLE.STOP : DV_ERROR_STYLE.WARNING
  const options: Partial<DvRuleBody> = { allowBlank: true, errorStyle }
  // OPEN: G32 — Excel "Ignore blank" off. Univer would mark every empty cell of the range invalid.
  if (extra.rejectBlank) notes.push({ outcome: 'converted', message: MESSAGES.dvBlankAllowed() })
  if (extra.errorStyle === 'WARNING' || extra.errorStyle === 'INFORMATION') {
    notes.push({ outcome: 'converted', message: MESSAGES.dvExcelWarning(extra.errorStyle === 'WARNING' ? 'تحذير' : 'معلومة') })
  } else if (extra.showErrorMessage === false) {
    notes.push({ outcome: 'converted', message: MESSAGES.dvNoAlert() })
  }
  const errorTitle = extra.errorTitle?.trim()
  const errorMessage = extra.errorMessage?.trim()
  if (errorTitle || errorMessage) {
    // Univer 1.4.0 shows `error` (the reject dialog, the hover alert) and never `errorTitle`.
    options.showErrorMessage = true
    options.error = errorTitle && errorMessage ? `${errorTitle}: ${errorMessage}` : (errorMessage ?? errorTitle)
    if (errorTitle) options.errorTitle = errorTitle
  }
  if (rule.inputMessage) {
    options.prompt = rule.inputMessage
    options.showInputMessage = true
    if (extra.inputTitle?.trim()) options.promptTitle = extra.inputTitle.trim()
  }

  /** A value usable as a Univer formula1/formula2: a plain number, a supported formula, or (dates) an ISO date. */
  const operand = (value: string | undefined, allowIsoDate: boolean): string | { error: string } => {
    if (value === undefined || value.trim() === '') return { error: 'قيمة الشرط مفقودة' }
    const formula = normalizeConditionFormula(value)
    if (formula) {
      const unsupported = findUnsupportedFunctions(formula, supportedFunctions)
      return unsupported.length > 0 ? { error: `معادلة الشرط تستخدم دالة غير مدعومة (${unsupported.join('، ')})` } : formula
    }
    if (parsePlainNumber(value) !== null) return value.trim()
    if (allowIsoDate && isIsoDate(value)) return value.trim()
    // OPEN: OPEN_QUESTIONS.md §7 — a date typed in the sheet's locale (e.g. 1/2/2026) is ambiguous.
    return { error: allowIsoDate ? 'قيمة التاريخ ليست بصيغة YYYY-MM-DD' : 'قيمة الشرط ليست رقمًا' }
  }

  // ---- lists ------------------------------------------------------------------------
  if (type === 'ONE_OF_LIST' || type === 'ONE_OF_RANGE') {
    let formula1: string
    let items: string[] | null
    if (type === 'ONE_OF_LIST') {
      items = values.map((v) => v.userEnteredValue ?? '').filter((v) => v !== '')
      if (items.length === 0) return { ok: false, reason: 'القائمة فارغة' }
      formula1 = JSON.stringify(items)
    } else {
      const value = raw(0)?.trim()
      if (!value) return { ok: false, reason: 'نطاق القائمة مفقود' }
      formula1 = normalizeConditionFormula(value) ?? `=${value}`
      // Google writes #REF! for a source its .xlsx cannot express (a table's column, real file 2026-11-11).
      if (/#REF!/i.test(formula1)) return { ok: false, reason: 'مصدر القائمة مرجع مكسور (#REF!)؛ ملف Google المصدَّر يكتبه هكذا حين تأتي القائمة من عمود جدول' }
      const unsupported = findUnsupportedFunctions(formula1, supportedFunctions)
      if (unsupported.length > 0) return { ok: false, reason: `مصدر القائمة يستخدم دالة غير مدعومة (${unsupported.join('، ')})` }
      items = context.listItems ?? null
    }
    const multiple = context.multiple === true
    const renderMode = multiple
      ? DV_RENDER_MODE.CUSTOM
      : extra.displayStyle === 'CHIP' ? DV_RENDER_MODE.CUSTOM
      : extra.displayStyle === 'ARROW' ? DV_RENDER_MODE.ARROW
      : extra.displayStyle === 'PLAIN_TEXT' ? DV_RENDER_MODE.TEXT
      : rule.showCustomUi ? DV_RENDER_MODE.ARROW : DV_RENDER_MODE.TEXT
    const body: DvRuleBody = { ...options, type: multiple ? DV_TYPE.LIST_MULTIPLE : DV_TYPE.LIST, formula1, renderMode }
    if (multiple) notes.push({ outcome: 'converted', message: MESSAGES.dvMultipleSelection() })

    const colors = Object.entries(extra.itemColors ?? {}).filter(([, c]) => isHexColor(c) && c.toLowerCase() !== GOOGLE_DEFAULT_CHIP_COLOR)
    if (colors.length > 0) {
      if (!items) {
        notes.push({ outcome: 'not_transferred', message: MESSAGES.dvColorsNotTransferred() })
      } else {
        const byItem = new Map(colors.map(([item, c]) => [item, c.toLowerCase()]))
        const aligned = items.map((item) => byItem.get(item) ?? '')
        if (aligned.some((c) => c !== '')) {
          body.formula2 = aligned.join(',')
          notes.push({ outcome: 'converted', message: MESSAGES.dvColors(type === 'ONE_OF_RANGE') })
        }
      }
    }
    return { ok: true, rule: body, notes }
  }

  if (type in NUMBER_OPS || type in DATE_OPS) {
    const isDate = type in DATE_OPS
    const operator = isDate ? DATE_OPS[type as keyof typeof DATE_OPS] : NUMBER_OPS[type as keyof typeof NUMBER_OPS]
    if (values.some((v) => v.relativeDate)) return { ok: false, reason: 'التواريخ النسبية غير مدعومة في التحقق من البيانات' }
    const f1 = operand(raw(0), isDate)
    if (typeof f1 !== 'string') return { ok: false, reason: f1.error }
    const numberType = extra.numberKind === 'WHOLE' ? DV_TYPE.WHOLE : extra.numberKind === 'TEXT_LENGTH' ? DV_TYPE.TEXT_LENGTH : DV_TYPE.DECIMAL
    const body: DvRuleBody = { ...options, type: isDate ? DV_TYPE.DATE : numberType, operator, formula1: f1 }
    if (TWO_VALUE_OPS.has(type)) {
      const f2 = operand(raw(1), isDate)
      if (typeof f2 !== 'string') return { ok: false, reason: f2.error }
      body.formula2 = f2
    }
    return { ok: true, rule: body, notes }
  }

  if (type === 'DATE_IS_VALID') return { ok: true, rule: { ...options, type: DV_TYPE.DATE }, notes }

  if (type === 'CUSTOM_FORMULA') {
    const f = operand(raw(0), false)
    if (typeof f !== 'string' || !f.startsWith('=')) return { ok: false, reason: typeof f === 'string' ? 'معادلة الشرط مفقودة' : f.error }
    return { ok: true, rule: { ...options, type: DV_TYPE.CUSTOM, formula1: f }, notes }
  }

  if (type === 'BOOLEAN') {
    if (values.length === 0) return { ok: true, rule: { ...options, type: DV_TYPE.CHECKBOX }, notes }
    if (values.length === 2 && raw(0) !== undefined && raw(1) !== undefined && raw(0) !== raw(1)) {
      return { ok: true, rule: { ...options, type: DV_TYPE.CHECKBOX, formula1: raw(0), formula2: raw(1) }, notes }
    }
    // Google: one value means "checked when it holds that value, unchecked when blank";
    // Univer's checkbox needs both values (CheckboxValidator.validatorFormula).
    return { ok: false, reason: 'مربع الاختيار بقيمة واحدة لا مقابل له' }
  }

  return { ok: false, reason: `نوع الشرط ${type} غير مدعوم` }
}

/**
 * Items as Google's "Allow multiple selections" writes them into one cell:
 * `"Product B, Product D"` (real export, 2026-11-11). Univer reads the same
 * text (deserializeListOptions: split on commas, trimmed).
 */
export function splitMultipleSelection(text: string): string[] {
  return text.split(',').map((s) => s.trim()).filter((s) => s !== '')
}

/**
 * Whether the texts of a list's cells show several items per cell: at least
 * one cell holds two or more items of the list joined by commas (and is not
 * itself an item, which a comma inside an item would be).
 */
export function looksLikeMultipleSelection(cellTexts: Iterable<string>, items: readonly string[]): boolean {
  const known = new Set(items)
  for (const text of cellTexts) {
    const t = text.trim()
    if (t === '' || known.has(t) || !t.includes(',')) continue
    const parts = splitMultipleSelection(t)
    if (parts.length >= 2 && parts.every((p) => known.has(p))) return true
  }
  return false
}
