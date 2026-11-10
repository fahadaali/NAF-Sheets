// Google DataValidationRule (per cell) → Univer sheet data-validation rules
// (resource SHEET_DATA_VALIDATION_PLUGIN: `{ [sheetId]: ISheetDataValidationRule[] }`,
// data-validation/lib/es/index.js DataValidationResourceController).
//
// Google stores a rule on every cell; identical rules are grouped and their
// cells merged into rectangles (convert.ts). Mapping:
//   ONE_OF_LIST     → list, formula1 = JSON array of the items (the form
//                     @univerjs/sheets serializeListOptions writes and
//                     deserializeListOptions reads)
//   ONE_OF_RANGE    → list, formula1 = "=<range>"
//   NUMBER_*        → decimal + operator
//   DATE_*          → date + operator (ISO dates, serial numbers or formulas only)
//   DATE_IS_VALID   → date without operator
//   CUSTOM_FORMULA  → custom
//   BOOLEAN         → checkbox (no values, or checked/unchecked pair)
//   strict          → errorStyle STOP, else WARNING
//   inputMessage    → prompt
//   showCustomUi    → renderMode ARROW (dropdown), else TEXT
// Anything else is reported as not transferred.

import type { ISheetDataValidationRule } from '@univerjs/core'
import { findUnsupportedFunctions, normalizeConditionFormula } from './formula'
import { parsePlainNumber } from './conditional-format'
import type { GsDataValidationRule } from './google-types'
import { DV_ERROR_STYLE, DV_OPERATOR, DV_RENDER_MODE, DV_TYPE } from './univer-constants'

export type DvRuleBody = Omit<ISheetDataValidationRule, 'uid' | 'ranges'>
export type DvConversion = { ok: true; rule: DvRuleBody } | { ok: false; reason: string }

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

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
}

export function convertDataValidation(rule: GsDataValidationRule, supportedFunctions: ReadonlySet<string>): DvConversion {
  const condition = rule.condition
  const type = condition?.type
  if (!type) return { ok: false, reason: 'القاعدة بلا شرط' }
  const values = condition?.values ?? []
  const raw = (i: number) => values[i]?.userEnteredValue

  const options: Partial<DvRuleBody> = {
    allowBlank: true,
    errorStyle: rule.strict ? DV_ERROR_STYLE.STOP : DV_ERROR_STYLE.WARNING,
  }
  if (rule.inputMessage) {
    options.prompt = rule.inputMessage
    options.showInputMessage = true
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

  if (type === 'ONE_OF_LIST') {
    const items = values.map((v) => v.userEnteredValue ?? '').filter((v) => v !== '')
    if (items.length === 0) return { ok: false, reason: 'القائمة فارغة' }
    return {
      ok: true,
      rule: {
        ...options,
        type: DV_TYPE.LIST,
        formula1: JSON.stringify(items),
        renderMode: rule.showCustomUi ? DV_RENDER_MODE.ARROW : DV_RENDER_MODE.TEXT,
      },
    }
  }

  if (type === 'ONE_OF_RANGE') {
    const value = raw(0)?.trim()
    if (!value) return { ok: false, reason: 'نطاق القائمة مفقود' }
    const formula = normalizeConditionFormula(value) ?? `=${value}`
    return {
      ok: true,
      rule: { ...options, type: DV_TYPE.LIST, formula1: formula, renderMode: rule.showCustomUi ? DV_RENDER_MODE.ARROW : DV_RENDER_MODE.TEXT },
    }
  }

  if (type in NUMBER_OPS || type in DATE_OPS) {
    const isDate = type in DATE_OPS
    const operator = isDate ? DATE_OPS[type as keyof typeof DATE_OPS] : NUMBER_OPS[type as keyof typeof NUMBER_OPS]
    if (values.some((v) => v.relativeDate)) return { ok: false, reason: 'التواريخ النسبية غير مدعومة في التحقق من البيانات' }
    const f1 = operand(raw(0), isDate)
    if (typeof f1 !== 'string') return { ok: false, reason: f1.error }
    const body: DvRuleBody = { ...options, type: isDate ? DV_TYPE.DATE : DV_TYPE.DECIMAL, operator, formula1: f1 }
    if (TWO_VALUE_OPS.has(type)) {
      const f2 = operand(raw(1), isDate)
      if (typeof f2 !== 'string') return { ok: false, reason: f2.error }
      body.formula2 = f2
    }
    return { ok: true, rule: body }
  }

  if (type === 'DATE_IS_VALID') return { ok: true, rule: { ...options, type: DV_TYPE.DATE } }

  if (type === 'CUSTOM_FORMULA') {
    const f = operand(raw(0), false)
    if (typeof f !== 'string' || !f.startsWith('=')) return { ok: false, reason: typeof f === 'string' ? 'معادلة الشرط مفقودة' : f.error }
    return { ok: true, rule: { ...options, type: DV_TYPE.CUSTOM, formula1: f } }
  }

  if (type === 'BOOLEAN') {
    if (values.length === 0) return { ok: true, rule: { ...options, type: DV_TYPE.CHECKBOX } }
    if (values.length === 2 && raw(0) !== undefined && raw(1) !== undefined && raw(0) !== raw(1)) {
      return { ok: true, rule: { ...options, type: DV_TYPE.CHECKBOX, formula1: raw(0), formula2: raw(1) } }
    }
    // Google: one value means "checked when it holds that value, unchecked when blank";
    // Univer's checkbox needs both values (CheckboxValidator.validatorFormula).
    return { ok: false, reason: 'مربع الاختيار بقيمة واحدة لا مقابل له' }
  }

  return { ok: false, reason: `نوع الشرط ${type} غير مدعوم` }
}
