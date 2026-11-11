// Every Univer value the converter mirrors (src/univer-constants.ts,
// src/univer-functions.generated.ts) checked against the installed 1.4.0
// packages. Raising the @univerjs/* pin makes this file fail until the
// mirrors are updated (CLAUDE.md: never raise the pin silently).

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import {
  BooleanNumber,
  BorderStyleTypes,
  CellValueType,
  ColorKit,
  CustomRangeType,
  DataValidationErrorStyle,
  DataValidationOperator,
  DataValidationRenderMode,
  DataValidationType,
  HorizontalAlign,
  LocaleType,
  normalizeWorkbookCalculationSettings,
  TextDirection,
  VerticalAlign,
  WrapStrategy,
} from '@univerjs/core'
import { ALL_IMPLEMENTED_FUNCTIONS_SET } from '@univerjs/engine-formula'
import { deserializeListOptions, SCOPE_WORKBOOK_VALUE_DEFINED_NAME } from '@univerjs/sheets'
import { CFNumberOperator, CFRuleType, CFSubRuleType, CFTextOperator, CFTimePeriodOperator, CFValueType, SHEET_CONDITIONAL_FORMATTING_PLUGIN } from '@univerjs/sheets-conditional-formatting'
import { DATA_VALIDATION_PLUGIN_NAME } from '@univerjs/sheets-data-validation'
import { CustomFilterOperator, SHEET_FILTER_SNAPSHOT_ID } from '@univerjs/sheets-filter'
import { UniverSheetsNotePlugin } from '@univerjs/sheets-note'
import { describe, expect, it } from 'vitest'
import { hexToRgbString } from '../src/color'
import { UNIVER_SUPPORTED_FUNCTIONS } from '../src/formula'
import {
  BOOL,
  BORDER_STYLE,
  CELL_TYPE,
  CUSTOM_RANGE_HYPERLINK,
  DEFAULT_ITERATION,
  DEFINED_NAME_WORKBOOK_SCOPE,
  DV_ERROR_STYLE,
  DV_OPERATOR,
  DV_RENDER_MODE,
  DV_TYPE,
  H_ALIGN,
  LOCALE_AR_SA,
  RESOURCE,
  TEXT_DIRECTION,
  UNIVER_VERSION,
  V_ALIGN,
  WRAP,
} from '../src/univer-constants'
import { UNIVER_FUNCTIONS_SOURCE_VERSION } from '../src/univer-functions.generated'

const require = createRequire(import.meta.url)
function installedVersion(pkg: string): string {
  const entry = require.resolve(pkg)
  return (JSON.parse(readFileSync(join(entry.slice(0, entry.lastIndexOf('/lib/')), 'package.json'), 'utf8')) as { version: string }).version
}

describe('installed Univer', () => {
  it('is the version the mirrors were read from', () => {
    for (const pkg of ['@univerjs/core', '@univerjs/engine-formula', '@univerjs/sheets', '@univerjs/sheets-conditional-formatting', '@univerjs/sheets-data-validation', '@univerjs/sheets-filter', '@univerjs/sheets-note', '@univerjs/sheets-hyper-link']) {
      expect(installedVersion(pkg), pkg).toBe(UNIVER_VERSION)
    }
    expect(UNIVER_FUNCTIONS_SOURCE_VERSION).toBe(UNIVER_VERSION)
  })
})

describe('formula engine function list', () => {
  it('equals engine-formula ALL_IMPLEMENTED_FUNCTIONS_SET (regenerate with scripts/generate-univer-functions.mjs)', () => {
    expect([...UNIVER_SUPPORTED_FUNCTIONS].sort()).toEqual([...ALL_IMPLEMENTED_FUNCTIONS_SET].map(String).sort())
  })
})

describe('core enums', () => {
  it('match the mirrored constants', () => {
    expect(BOOL).toEqual({ FALSE: BooleanNumber.FALSE, TRUE: BooleanNumber.TRUE })
    expect(CELL_TYPE).toEqual({ STRING: CellValueType.STRING, NUMBER: CellValueType.NUMBER, BOOLEAN: CellValueType.BOOLEAN, FORCE_STRING: CellValueType.FORCE_STRING })
    expect(H_ALIGN).toEqual({ LEFT: HorizontalAlign.LEFT, CENTER: HorizontalAlign.CENTER, RIGHT: HorizontalAlign.RIGHT })
    expect(V_ALIGN).toEqual({ TOP: VerticalAlign.TOP, MIDDLE: VerticalAlign.MIDDLE, BOTTOM: VerticalAlign.BOTTOM })
    expect(WRAP).toEqual({ OVERFLOW: WrapStrategy.OVERFLOW, CLIP: WrapStrategy.CLIP, WRAP: WrapStrategy.WRAP })
    expect(TEXT_DIRECTION).toEqual({ LEFT_TO_RIGHT: TextDirection.LEFT_TO_RIGHT, RIGHT_TO_LEFT: TextDirection.RIGHT_TO_LEFT })
    expect(BORDER_STYLE).toEqual({
      THIN: BorderStyleTypes.THIN,
      DOTTED: BorderStyleTypes.DOTTED,
      DASHED: BorderStyleTypes.DASHED,
      DOUBLE: BorderStyleTypes.DOUBLE,
      MEDIUM: BorderStyleTypes.MEDIUM,
      THICK: BorderStyleTypes.THICK,
    })
    expect(CUSTOM_RANGE_HYPERLINK).toBe(CustomRangeType.HYPERLINK)
    expect(LOCALE_AR_SA).toBe(LocaleType.AR_SA)
    // DEFAULT_WORKBOOK_CALCULATION_SETTINGS is not exported; normalising an empty object returns it.
    const defaults = normalizeWorkbookCalculationSettings({})
    expect(DEFAULT_ITERATION).toEqual({ maxIterations: defaults.maxIterations, maxChange: defaults.maxChange })
  })

  it('match the data-validation constants', () => {
    expect(DV_TYPE).toEqual({
      LIST: DataValidationType.LIST,
      LIST_MULTIPLE: DataValidationType.LIST_MULTIPLE,
      WHOLE: DataValidationType.WHOLE,
      TEXT_LENGTH: DataValidationType.TEXT_LENGTH,
      CHECKBOX: DataValidationType.CHECKBOX, DECIMAL: DataValidationType.DECIMAL, DATE: DataValidationType.DATE, CUSTOM: DataValidationType.CUSTOM })
    expect(DV_OPERATOR).toEqual({
      BETWEEN: DataValidationOperator.BETWEEN,
      EQUAL: DataValidationOperator.EQUAL,
      GREATER_THAN: DataValidationOperator.GREATER_THAN,
      GREATER_THAN_OR_EQUAL: DataValidationOperator.GREATER_THAN_OR_EQUAL,
      LESS_THAN: DataValidationOperator.LESS_THAN,
      LESS_THAN_OR_EQUAL: DataValidationOperator.LESS_THAN_OR_EQUAL,
      NOT_BETWEEN: DataValidationOperator.NOT_BETWEEN,
      NOT_EQUAL: DataValidationOperator.NOT_EQUAL,
    })
    expect(DV_ERROR_STYLE).toEqual({ INFO: DataValidationErrorStyle.INFO, STOP: DataValidationErrorStyle.STOP, WARNING: DataValidationErrorStyle.WARNING })
    expect(DV_RENDER_MODE).toEqual({ TEXT: DataValidationRenderMode.TEXT, ARROW: DataValidationRenderMode.ARROW, CUSTOM: DataValidationRenderMode.CUSTOM })
  })
})

describe('plugin resources', () => {
  it('use the names the plugins register', () => {
    expect(RESOURCE.CONDITIONAL_FORMATTING).toBe(SHEET_CONDITIONAL_FORMATTING_PLUGIN)
    expect(RESOURCE.DATA_VALIDATION).toBe(DATA_VALIDATION_PLUGIN_NAME)
    expect(RESOURCE.FILTER).toBe(SHEET_FILTER_SNAPSHOT_ID)
    expect(RESOURCE.NOTE).toBe(UniverSheetsNotePlugin.pluginName)
    // SHEET_DEFINED_NAME_PLUGIN is not exported; univer-load.test.ts reads it back from a live instance.
    expect(DEFINED_NAME_WORKBOOK_SCOPE).toBe(SCOPE_WORKBOOK_VALUE_DEFINED_NAME)
  })

  it('use the conditional-formatting enum values', () => {
    expect([CFRuleType.highlightCell, CFRuleType.colorScale]).toEqual(['highlightCell', 'colorScale'])
    expect([CFSubRuleType.number, CFSubRuleType.text, CFSubRuleType.timePeriod, CFSubRuleType.formula]).toEqual(['number', 'text', 'timePeriod', 'formula'])
    expect(Object.values(CFNumberOperator).sort()).toEqual(['between', 'equal', 'greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual', 'notBetween', 'notEqual'])
    for (const op of ['beginsWith', 'endsWith', 'containsText', 'notContainsText', 'equal', 'containsBlanks', 'notContainsBlanks']) {
      expect(Object.values(CFTextOperator)).toContain(op)
    }
    for (const op of ['today', 'yesterday', 'tomorrow']) expect(Object.values(CFTimePeriodOperator)).toContain(op)
    expect(Object.values(CFValueType).sort()).toEqual(['formula', 'max', 'min', 'num', 'percent', 'percentile'])
  })

  it('use the filter operator values and colour format', () => {
    expect(Object.values(CustomFilterOperator).sort()).toEqual(['equal', 'greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual', 'notEqual'])
    expect(hexToRgbString('#1b4b5a')).toBe(new ColorKit('#1b4b5a').toRgbString())
  })

  it('write list items in the form @univerjs/sheets reads back (commas inside items survive)', () => {
    const items = ['منجز', 'قيد التنفيذ', 'متأخر، جزئيًا, بانتظار']
    expect(deserializeListOptions(JSON.stringify(items))).toEqual(items)
  })
})
