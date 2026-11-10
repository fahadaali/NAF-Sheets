// Google ConditionalFormatRule (booleanRule, gradientRule) → Univer
// sheets-conditional-formatting rules (resource SHEET_CONDITIONAL_FORMATTING_PLUGIN).
//
// Order and priority: Google "Rules are evaluated in the order listed. The
// first rule found to be true will define the format of the cell or range"
// (support.google.com/docs/answer/78413). Univer keeps index 0 as the highest
// priority and, with `stopIfTrue`, applies only rules up to the first match
// (ConditionalFormattingStyleComposer.composeStyle). So the order is kept and
// every rule gets `stopIfTrue: true`.
//
// BooleanRule.format: the API reference says conditional formats apply only
// bold, italic, strikethrough, foreground and background colour; underline is
// mapped too when present.

import type { IStyleBase } from '@univerjs/core'
import type { GridSize } from './a1'
import { gridRangeToRange } from './a1'
import type { ColorResolver } from './color'
import { findUnsupportedFunctions, normalizeConditionFormula } from './formula'
import type { GsCellFormat, GsConditionalFormatRule, GsConditionValue, GsInterpolationPoint } from './google-types'
import { textFormatToStyle } from './style'
import type { CfColorScaleRule, CfHighlightRule, CfNumberOperator, CfTextOperator, CfValueType, UniverCfRule } from './univer-constants'

export type CfConversion = { ok: true; rule: UniverCfRule } | { ok: false; reason: string; ranges: UniverCfRule['ranges'] }

const NUMBER_OPERATORS: Record<string, CfNumberOperator> = {
  NUMBER_GREATER: 'greaterThan',
  NUMBER_GREATER_THAN_EQ: 'greaterThanOrEqual',
  NUMBER_LESS: 'lessThan',
  NUMBER_LESS_THAN_EQ: 'lessThanOrEqual',
  NUMBER_EQ: 'equal',
  NUMBER_NOT_EQ: 'notEqual',
  NUMBER_BETWEEN: 'between',
  NUMBER_NOT_BETWEEN: 'notBetween',
}

const TEXT_OPERATORS: Record<string, CfTextOperator> = {
  TEXT_CONTAINS: 'containsText',
  TEXT_NOT_CONTAINS: 'notContainsText',
  TEXT_STARTS_WITH: 'beginsWith',
  TEXT_ENDS_WITH: 'endsWith',
  TEXT_EQ: 'equal',
}

/** A plain number written by a user (no formula, no locale grouping). */
export function parsePlainNumber(value: string | undefined): number | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

function literal(values: GsConditionValue[] | undefined, index: number): string | undefined {
  return values?.[index]?.userEnteredValue
}

function formatStyle(format: GsCellFormat | undefined, colors: ColorResolver): IStyleBase {
  const style = textFormatToStyle(format?.textFormat, colors)
  // Fonts and sizes are not applied by Google conditional formats.
  delete style.ff
  delete style.fs
  const bg = colors.resolve(format?.backgroundColorStyle, format?.backgroundColor)
  if (bg) style.bg = { rgb: bg }
  return style
}

export function convertConditionalFormat(
  rule: GsConditionalFormatRule,
  cfId: string,
  size: GridSize,
  colors: ColorResolver,
  supportedFunctions: ReadonlySet<string>,
): CfConversion {
  const ranges = (rule.ranges ?? []).map((r) => gridRangeToRange(r, size)).filter((r): r is NonNullable<typeof r> => r !== null)
  const fail = (reason: string): CfConversion => ({ ok: false, reason, ranges })
  if (ranges.length === 0) return fail('نطاق القاعدة فارغ')

  if (rule.gradientRule) {
    const scale = convertGradient(rule.gradientRule, colors)
    if (typeof scale === 'string') return fail(scale)
    return { ok: true, rule: { cfId, ranges, stopIfTrue: true, rule: scale } }
  }

  const condition = rule.booleanRule?.condition
  if (!rule.booleanRule || !condition?.type) return fail('القاعدة بلا شرط')
  const style = formatStyle(rule.booleanRule.format, colors)
  const type = condition.type
  const values = condition.values

  let highlight: CfHighlightRule | string
  const numberOperator = NUMBER_OPERATORS[type]
  const textOperator = TEXT_OPERATORS[type]
  if (numberOperator) {
    if (numberOperator === 'between' || numberOperator === 'notBetween') {
      const a = parsePlainNumber(literal(values, 0))
      const b = parsePlainNumber(literal(values, 1))
      highlight =
        a === null || b === null
          ? 'قيمة الشرط معادلة أو ليست رقمًا'
          : { type: 'highlightCell', subType: 'number', operator: numberOperator, value: [a, b], style }
    } else {
      const a = parsePlainNumber(literal(values, 0))
      highlight = a === null ? 'قيمة الشرط معادلة أو ليست رقمًا' : { type: 'highlightCell', subType: 'number', operator: numberOperator, value: a, style }
    }
  } else if (textOperator) {
    const v = literal(values, 0)
    // OPEN: OPEN_QUESTIONS.md §6 — Univer compares text case-sensitively; Google's behaviour is not documented.
    highlight =
      v === undefined || normalizeConditionFormula(v) !== null
        ? 'قيمة الشرط معادلة أو غير محددة'
        : { type: 'highlightCell', subType: 'text', operator: textOperator, value: v, style }
  } else if (type === 'BLANK') {
    highlight = { type: 'highlightCell', subType: 'text', operator: 'containsBlanks', style }
  } else if (type === 'NOT_BLANK') {
    highlight = { type: 'highlightCell', subType: 'text', operator: 'notContainsBlanks', style }
  } else if (type === 'DATE_EQ') {
    const rel = values?.[0]?.relativeDate
    if (rel === 'TODAY') highlight = { type: 'highlightCell', subType: 'timePeriod', operator: 'today', style }
    else if (rel === 'YESTERDAY') highlight = { type: 'highlightCell', subType: 'timePeriod', operator: 'yesterday', style }
    else if (rel === 'TOMORROW') highlight = { type: 'highlightCell', subType: 'timePeriod', operator: 'tomorrow', style }
    else highlight = 'شرط التاريخ ليس اليوم أو أمس أو غدًا، ولا مقابل مطابق له'
  } else if (type === 'CUSTOM_FORMULA') {
    const formula = normalizeConditionFormula(literal(values, 0) ?? '')
    if (!formula) highlight = 'معادلة الشرط مفقودة'
    else {
      const unsupported = findUnsupportedFunctions(formula, supportedFunctions)
      highlight =
        unsupported.length > 0
          ? `معادلة الشرط تستخدم دالة غير مدعومة (${unsupported.join('، ')})`
          : { type: 'highlightCell', subType: 'formula', value: formula, style }
    }
  } else {
    highlight = `نوع الشرط ${type} غير مدعوم`
  }

  if (typeof highlight === 'string') return fail(highlight)
  return { ok: true, rule: { cfId, ranges, stopIfTrue: true, rule: highlight } }
}

function pointValue(point: GsInterpolationPoint): { type: CfValueType; value?: number | string } | string {
  switch (point.type) {
    case 'MIN':
      return { type: 'min' }
    case 'MAX':
      return { type: 'max' }
    case 'NUMBER':
    case 'PERCENT':
    case 'PERCENTILE': {
      const raw = point.value ?? ''
      const formula = normalizeConditionFormula(raw)
      if (formula) {
        // A formula point is a number computed by formula, whatever its type.
        return point.type === 'NUMBER' ? { type: 'formula', value: formula } : 'نقطة التدرج نسبة محسوبة بمعادلة'
      }
      const n = parsePlainNumber(raw)
      if (n === null) return 'قيمة نقطة التدرج ليست رقمًا'
      // Univer's percent and percentile take 0–100 like Google's (getValueByType).
      return { type: point.type === 'NUMBER' ? 'num' : point.type === 'PERCENT' ? 'percent' : 'percentile', value: n }
    }
    default:
      return 'نوع نقطة التدرج غير محدد'
  }
}

function convertGradient(gradient: NonNullable<GsConditionalFormatRule['gradientRule']>, colors: ColorResolver): CfColorScaleRule | string {
  const points = [gradient.minpoint, gradient.midpoint, gradient.maxpoint]
  if (!gradient.minpoint || !gradient.maxpoint) return 'التدرج اللوني ينقصه حدّه الأدنى أو الأعلى'
  const config: CfColorScaleRule['config'] = []
  for (const point of points) {
    if (!point) continue
    const color = colors.resolve(point.colorStyle, point.color)
    if (!color) return 'تعذّر قراءة لون من ألوان التدرج'
    const value = pointValue(point)
    if (typeof value === 'string') return value
    config.push({ index: config.length, color, value })
  }
  return { type: 'colorScale', config }
}
