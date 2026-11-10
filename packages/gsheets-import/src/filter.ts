// Google BasicFilter → Univer sheets-filter auto filter (resource
// SHEET_FILTER_PLUGIN: `{ [sheetId]: IAutoFilter }`, sheets-filter
// SheetsFilterService). Both include the header row in the range and filter
// the rows below it (FilterColumn.calc starts at range.startRow + 1).
// `colId` is the absolute column index (FilterModel._setCriteriaWithoutReCalc).
//
// Per column, Univer holds one kind of criteria; Google may combine several.
//   hiddenValues   → filters (Univer lists the VISIBLE values, compared with
//                    extractPureTextFromCell of the stored cell; Google lists
//                    the HIDDEN displayed values, so the visible set is
//                    computed from the sheet's cells)
//   condition      → customFilters for NUMBER_*, TEXT_CONTAINS/NOT_CONTAINS/
//                    STARTS_WITH/ENDS_WITH/EQ, BLANK, NOT_BLANK
//   visibleBackgroundColor / visibleForegroundColor → colorFilters
// Anything else, or several kinds on one column: the range is kept, that
// column's criteria are reported. `sortSpecs` describe an order the rows
// already have, so nothing is transferred for them.

import type { IRange } from '@univerjs/core'
import type { GridSize } from './a1'
import { gridRangeToRange } from './a1'
import { hexToRgbString, type ColorResolver } from './color'
import { parsePlainNumber } from './conditional-format'
import { normalizeConditionFormula } from './formula'
import type { GsBasicFilter, GsFilterCriteria } from './google-types'
import { BOOL, type UniverAutoFilter, type UniverCustomFilter, type UniverFilterColumn } from './univer-constants'

export interface FilterCellText {
  /** Google's displayed value (`formattedValue`), '' when blank. */
  displayed: string
  /** What Univer's value filter compares for the converted cell, '' when blank. */
  univerText: string
}

export interface FilterColumnFailure {
  column: number
  reason: string
}

export type FilterConversion =
  | { ok: true; filter: UniverAutoFilter; failures: FilterColumnFailure[] }
  | { ok: false; reason: string }

/** Wildcards `*` and `?` cannot be escaped in Univer's text match (regexp.createFromWildcard). */
function hasWildcard(value: string): boolean {
  return value.includes('*') || value.includes('?')
}

function conditionToCustomFilters(condition: NonNullable<GsFilterCriteria['condition']>): UniverFilterColumn['customFilters'] | string {
  const type = condition.type
  const v0 = condition.values?.[0]?.userEnteredValue
  const v1 = condition.values?.[1]?.userEnteredValue
  const num = (v: string | undefined) => (v !== undefined && normalizeConditionFormula(v) === null ? parsePlainNumber(v) : null)
  const one = (f: UniverCustomFilter): UniverFilterColumn['customFilters'] => ({ customFilters: [f] })

  switch (type) {
    case 'NUMBER_GREATER':
    case 'NUMBER_GREATER_THAN_EQ':
    case 'NUMBER_LESS':
    case 'NUMBER_LESS_THAN_EQ':
    case 'NUMBER_EQ':
    case 'NUMBER_NOT_EQ': {
      const n = num(v0)
      if (n === null) return 'قيمة الشرط معادلة أو ليست رقمًا'
      const operator = (
        {
          NUMBER_GREATER: 'greaterThan',
          NUMBER_GREATER_THAN_EQ: 'greaterThanOrEqual',
          NUMBER_LESS: 'lessThan',
          NUMBER_LESS_THAN_EQ: 'lessThanOrEqual',
          NUMBER_EQ: 'equal',
          NUMBER_NOT_EQ: 'notEqual',
        } as const
      )[type]
      return one({ operator, val: n })
    }
    case 'NUMBER_BETWEEN':
    case 'NUMBER_NOT_BETWEEN': {
      const a = num(v0)
      const b = num(v1)
      if (a === null || b === null) return 'قيمة الشرط معادلة أو ليست رقمًا'
      return type === 'NUMBER_BETWEEN'
        ? { and: BOOL.TRUE, customFilters: [{ operator: 'greaterThanOrEqual', val: a }, { operator: 'lessThanOrEqual', val: b }] }
        : { customFilters: [{ operator: 'lessThan', val: a }, { operator: 'greaterThan', val: b }] }
    }
    case 'TEXT_CONTAINS':
    case 'TEXT_NOT_CONTAINS':
    case 'TEXT_STARTS_WITH':
    case 'TEXT_ENDS_WITH':
    case 'TEXT_EQ': {
      if (v0 === undefined || normalizeConditionFormula(v0) !== null) return 'قيمة الشرط معادلة أو غير محددة'
      if (hasWildcard(v0)) return 'قيمة الشرط تحوي * أو ? ولا يمكن مطابقتها حرفيًا'
      // OPEN: OPEN_QUESTIONS.md §6 — Univer's text match is case-insensitive; Google's is not documented.
      if (type === 'TEXT_CONTAINS') return one({ val: `*${v0}*` })
      if (type === 'TEXT_NOT_CONTAINS') return one({ operator: 'notEqual', val: `*${v0}*` })
      if (type === 'TEXT_STARTS_WITH') return one({ val: `${v0}*` })
      if (type === 'TEXT_ENDS_WITH') return one({ val: `*${v0}` })
      return one({ val: v0 })
    }
    case 'BLANK':
      return one({ val: '' })
    case 'NOT_BLANK':
      // sheets-filter notEquals treats ' ' as "any non-empty value".
      return one({ operator: 'notEqual', val: ' ' })
    default:
      return `نوع الشرط ${type ?? 'غير المحدد'} غير مدعوم`
  }
}

function hiddenValuesToFilters(hidden: string[], range: IRange, column: number, cellText: (row: number, column: number) => FilterCellText): UniverFilterColumn['filters'] | string {
  const hiddenSet = new Set(hidden)
  const visible = new Set<string>()
  const hiddenKeys = new Set<string>()
  for (let row = range.startRow + 1; row <= range.endRow; row++) {
    const { displayed, univerText } = cellText(row, column)
    if (univerText === '') continue
    if (hiddenSet.has(displayed)) hiddenKeys.add(univerText)
    else visible.add(univerText)
  }
  for (const key of hiddenKeys) {
    if (visible.has(key)) return 'قيمة واحدة تظهر بأكثر من صيغة عرض فلا يمكن فصل المخفي عن الظاهر'
  }
  // OPEN: OPEN_QUESTIONS.md §8 — assumed: Google lists hidden blanks as "".
  const filters: NonNullable<UniverFilterColumn['filters']> = { filters: [...visible].sort() }
  if (!hiddenSet.has('')) filters.blank = true
  return filters
}

export function convertBasicFilter(
  basicFilter: GsBasicFilter,
  size: GridSize,
  colors: ColorResolver,
  cellText: (row: number, column: number) => FilterCellText,
): FilterConversion {
  const ref = gridRangeToRange(basicFilter.range, size)
  if (!ref) return { ok: false, reason: basicFilter.tableId ? 'الفلتر مرتبط بجدول دون نطاق' : 'نطاق الفلتر فارغ' }

  const specs: Array<{ column: number | undefined; criteria: GsFilterCriteria | undefined; dataSource: boolean }> = basicFilter.filterSpecs
    ? basicFilter.filterSpecs.map((s) => ({ column: s.columnIndex, criteria: s.filterCriteria, dataSource: !!s.dataSourceColumnReference }))
    : Object.entries(basicFilter.criteria ?? {}).map(([k, c]) => ({ column: Number(k), criteria: c, dataSource: false }))

  const filterColumns: UniverFilterColumn[] = []
  const failures: FilterColumnFailure[] = []
  for (const spec of specs) {
    const column = spec.column
    const criteria = spec.criteria
    if (spec.dataSource || column === undefined || !Number.isInteger(column)) {
      failures.push({ column: column ?? ref.startColumn, reason: 'العمود مرجع لمصدر بيانات' })
      continue
    }
    if (column < ref.startColumn || column > ref.endColumn) {
      failures.push({ column, reason: 'العمود خارج نطاق الفلتر' })
      continue
    }
    if (!criteria) continue
    const hidden = criteria.hiddenValues ?? []
    const bg = criteria.visibleBackgroundColorStyle || criteria.visibleBackgroundColor
    const fg = criteria.visibleForegroundColorStyle || criteria.visibleForegroundColor
    const kinds = [hidden.length > 0, !!criteria.condition?.type, !!bg, !!fg].filter(Boolean).length
    if (kinds === 0) continue
    if (kinds > 1) {
      failures.push({ column, reason: 'العمود يجمع أكثر من نوع من المعايير' })
      continue
    }

    if (hidden.length > 0) {
      const filters = hiddenValuesToFilters(hidden, ref, column, cellText)
      if (typeof filters === 'string') failures.push({ column, reason: filters })
      else filterColumns.push({ colId: column, filters })
    } else if (criteria.condition?.type) {
      const custom = conditionToCustomFilters(criteria.condition)
      if (typeof custom === 'string' || !custom) failures.push({ column, reason: custom ?? 'شرط غير صالح' })
      else filterColumns.push({ colId: column, customFilters: custom })
    } else if (bg) {
      const hex = colors.resolve(criteria.visibleBackgroundColorStyle, criteria.visibleBackgroundColor)
      if (!hex) failures.push({ column, reason: 'تعذّر قراءة لون التعبئة' })
      else filterColumns.push({ colId: column, colorFilters: { cellFillColors: [hexToRgbString(hex)] } })
    } else {
      const hex = colors.resolve(criteria.visibleForegroundColorStyle, criteria.visibleForegroundColor)
      if (!hex) failures.push({ column, reason: 'تعذّر قراءة لون النص' })
      else filterColumns.push({ colId: column, colorFilters: { cellTextColors: [hexToRgbString(hex)] } })
    }
  }
  filterColumns.sort((a, b) => a.colId - b.colId)
  const filter: UniverAutoFilter = { ref }
  if (filterColumns.length > 0) filter.filterColumns = filterColumns
  return { ok: true, filter, failures }
}
