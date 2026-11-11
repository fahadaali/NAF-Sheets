// Univer 1.4.0 values the converter writes into the snapshot.
//
// The converter is pure and runs in the API Worker, so it does not import
// Univer at runtime (the engine and its DI container are large). Enum values
// are mirrored here as typed constants instead, and resource names and data
// shapes as local types. `test/univer-contract.test.ts` checks every value
// below against the installed packages, and `test/univer-load.test.ts` loads
// a converted workbook into a headless Univer 1.4.0 and reads it back.
//
// Sources (installed packages, node_modules/@univerjs/*):
//   core/lib/types/types/enum/text-style.d.ts         HorizontalAlign, VerticalAlign,
//                                                      WrapStrategy, TextDirection,
//                                                      BooleanNumber, CellValueType
//   core/lib/types/types/enum/border-style-types.d.ts  BorderStyleTypes
//   core/lib/types/types/enum/data-validation-*.d.ts   DataValidation* enums
//   core/lib/types/types/interfaces/i-document-data.d.ts  CustomRangeType
//   core/lib/types/types/enum/locale-type.d.ts         LocaleType
//   sheets-conditional-formatting/lib/types/base/const.d.ts + models/type.d.ts
//   sheets-data-validation (DATA_VALIDATION_PLUGIN_NAME), data-validation/lib/es/index.js
//   sheets-filter/lib/types/models/types.d.ts, lib/es/plugin-*.js (SHEET_FILTER_SNAPSHOT_ID)
//   sheets-note/lib/types/const.d.ts, models/sheets-note.model.d.ts
//   sheets/lib/es/plugin-*.js (SHEET_DEFINED_NAME_PLUGIN, SCOPE_WORKBOOK_VALUE_DEFINED_NAME)
//   sheets-note-ui/lib/es/index.js (default note size 160 x 72)

import type {
  BooleanNumber,
  BorderStyleTypes,
  CellValueType,
  CustomRangeType,
  DataValidationErrorStyle,
  DataValidationOperator,
  DataValidationRenderMode,
  DataValidationType,
  HorizontalAlign,
  IRange,
  IStyleBase,
  LocaleType,
  TextDirection,
  VerticalAlign,
  WrapStrategy,
} from '@univerjs/core'

/** The `@univerjs/*` release the mirrored values were read from (CLAUDE.md: pinned exactly). */
export const UNIVER_VERSION = '1.4.0'

export const BOOL = {
  FALSE: 0 as BooleanNumber,
  TRUE: 1 as BooleanNumber,
} as const

export const CELL_TYPE = {
  STRING: 1 as CellValueType,
  NUMBER: 2 as CellValueType,
  BOOLEAN: 3 as CellValueType,
  FORCE_STRING: 4 as CellValueType,
} as const

export const H_ALIGN = {
  LEFT: 1 as HorizontalAlign,
  CENTER: 2 as HorizontalAlign,
  RIGHT: 3 as HorizontalAlign,
} as const

export const V_ALIGN = {
  TOP: 1 as VerticalAlign,
  MIDDLE: 2 as VerticalAlign,
  BOTTOM: 3 as VerticalAlign,
} as const

export const WRAP = {
  OVERFLOW: 1 as WrapStrategy,
  CLIP: 2 as WrapStrategy,
  WRAP: 3 as WrapStrategy,
} as const

export const TEXT_DIRECTION = {
  LEFT_TO_RIGHT: 1 as TextDirection,
  RIGHT_TO_LEFT: 2 as TextDirection,
} as const

export const BORDER_STYLE = {
  THIN: 1 as BorderStyleTypes,
  DOTTED: 3 as BorderStyleTypes,
  DASHED: 4 as BorderStyleTypes,
  DOUBLE: 7 as BorderStyleTypes,
  MEDIUM: 8 as BorderStyleTypes,
  THICK: 13 as BorderStyleTypes,
} as const

export const CUSTOM_RANGE_HYPERLINK = 0 as CustomRangeType

export const LOCALE_AR_SA = 'arSA' as LocaleType

export const DV_TYPE = {
  LIST: 'list' as DataValidationType,
  /** Several items per cell; Univer stores a pick as a JSON array (sheets serializeListOptions). */
  LIST_MULTIPLE: 'listMultiple' as DataValidationType,
  WHOLE: 'whole' as DataValidationType,
  TEXT_LENGTH: 'textLength' as DataValidationType,
  CHECKBOX: 'checkbox' as DataValidationType,
  DECIMAL: 'decimal' as DataValidationType,
  DATE: 'date' as DataValidationType,
  CUSTOM: 'custom' as DataValidationType,
} as const

export const DV_OPERATOR = {
  BETWEEN: 'between' as DataValidationOperator,
  EQUAL: 'equal' as DataValidationOperator,
  GREATER_THAN: 'greaterThan' as DataValidationOperator,
  GREATER_THAN_OR_EQUAL: 'greaterThanOrEqual' as DataValidationOperator,
  LESS_THAN: 'lessThan' as DataValidationOperator,
  LESS_THAN_OR_EQUAL: 'lessThanOrEqual' as DataValidationOperator,
  NOT_BETWEEN: 'notBetween' as DataValidationOperator,
  NOT_EQUAL: 'notEqual' as DataValidationOperator,
} as const

export const DV_ERROR_STYLE = {
  /** Stored; sheets-data-validation-ui 1.4.0 treats it as WARNING (only STOP rejects). */
  INFO: 0 as DataValidationErrorStyle,
  STOP: 1 as DataValidationErrorStyle,
  WARNING: 2 as DataValidationErrorStyle,
} as const

export const DV_RENDER_MODE = {
  TEXT: 0 as DataValidationRenderMode,
  ARROW: 1 as DataValidationRenderMode,
  /** The chip: a rounded fill in the item's colour (sheets-data-validation-ui DropdownWidget). */
  CUSTOM: 2 as DataValidationRenderMode,
} as const

/** `name` of each entry in `IWorkbookData.resources`. */
export const RESOURCE = {
  CONDITIONAL_FORMATTING: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN',
  DATA_VALIDATION: 'SHEET_DATA_VALIDATION_PLUGIN',
  FILTER: 'SHEET_FILTER_PLUGIN',
  NOTE: 'SHEET_NOTE_PLUGIN',
  DEFINED_NAME: 'SHEET_DEFINED_NAME_PLUGIN',
} as const

/** `localSheetId` of a defined name visible in the whole workbook. */
export const DEFINED_NAME_WORKBOOK_SCOPE = 'AllDefaultWorkbook'

/** core DEFAULT_WORKBOOK_CALCULATION_SETTINGS: used for fields Google leaves out. */
export const DEFAULT_ITERATION = { maxIterations: 100, maxChange: 0.001 } as const

/** Size sheets-note-ui gives a note that has none (sheets-note-ui/lib/es/index.js). */
export const DEFAULT_NOTE_SIZE = { width: 160, height: 72 } as const

// ---------------------------------------------------------------------------
// Resource data shapes (local mirrors; see the contract and load tests)
// ---------------------------------------------------------------------------

/** sheets-conditional-formatting `CFNumberOperator`. */
export type CfNumberOperator =
  | 'greaterThan'
  | 'greaterThanOrEqual'
  | 'lessThan'
  | 'lessThanOrEqual'
  | 'notBetween'
  | 'between'
  | 'equal'
  | 'notEqual'

/** sheets-conditional-formatting `CFTextOperator` (the subset the converter writes). */
export type CfTextOperator =
  | 'beginsWith'
  | 'endsWith'
  | 'containsText'
  | 'notContainsText'
  | 'equal'
  | 'containsBlanks'
  | 'notContainsBlanks'

/** sheets-conditional-formatting `CFTimePeriodOperator` (the subset the converter writes). */
export type CfTimePeriodOperator = 'today' | 'yesterday' | 'tomorrow'

/** sheets-conditional-formatting `CFValueType`. */
export type CfValueType = 'num' | 'min' | 'max' | 'percent' | 'percentile' | 'formula'

export type CfHighlightRule =
  | { type: 'highlightCell'; subType: 'number'; operator: 'between' | 'notBetween'; value: [number, number]; style: IStyleBase }
  | { type: 'highlightCell'; subType: 'number'; operator: Exclude<CfNumberOperator, 'between' | 'notBetween'>; value: number; style: IStyleBase }
  | { type: 'highlightCell'; subType: 'text'; operator: CfTextOperator; value?: string; style: IStyleBase }
  | { type: 'highlightCell'; subType: 'timePeriod'; operator: CfTimePeriodOperator; style: IStyleBase }
  | { type: 'highlightCell'; subType: 'formula'; value: string; style: IStyleBase }

export interface CfColorScaleRule {
  type: 'colorScale'
  config: Array<{ index: number; color: string; value: { type: CfValueType; value?: number | string } }>
}

/** sheets-conditional-formatting `IConditionFormattingRule`. Index 0 has the highest priority. */
export interface UniverCfRule {
  cfId: string
  ranges: IRange[]
  stopIfTrue: boolean
  rule: CfHighlightRule | CfColorScaleRule
}

/** sheets-filter `CustomFilterOperator`. */
export type FilterCustomOperator = 'equal' | 'greaterThan' | 'greaterThanOrEqual' | 'lessThan' | 'lessThanOrEqual' | 'notEqual'

export interface UniverCustomFilter {
  val: string | number
  /** Absent: wildcard text match (`*`, `?`), case-insensitive. */
  operator?: FilterCustomOperator
}

/** sheets-filter `IFilterColumn`. `colId` is the absolute column index. */
export interface UniverFilterColumn {
  colId: number
  filters?: { blank?: true; filters?: string[] }
  colorFilters?: { cellFillColors?: Array<string | null>; cellTextColors?: string[] }
  customFilters?: { and?: BooleanNumber; customFilters: [UniverCustomFilter] | [UniverCustomFilter, UniverCustomFilter] }
}

/** sheets-filter `IAutoFilter`. `ref` includes the header row; rows below it are filtered. */
export interface UniverAutoFilter {
  ref: IRange
  filterColumns?: UniverFilterColumn[]
}

/** sheets-note `ISheetNote`. */
export interface UniverSheetNote {
  id: string
  row: number
  col: number
  width: number
  height: number
  note: string
  show?: boolean
}

/** engine-formula `IDefinedNamesServiceParam`. */
export interface UniverDefinedName {
  id: string
  name: string
  formulaOrRefString: string
  comment?: string
  localSheetId?: string
  hidden?: boolean
}
