// Univer 1.4.0 values this package reads and writes in a workbook snapshot.
//
// The package is pure and runs in the API Worker, so it never imports Univer
// at runtime (the engine and its DI container are large): types come from
// `@univerjs/core` with `import type`, and enum values and resource names are
// mirrored here. `test/univer-contract.test.ts` checks every value below
// against the installed packages; `test/univer-load.test.ts` loads snapshots
// written by this package into a headless Univer 1.4.0.
//
// Sources (installed packages, node_modules/@univerjs/*):
//   core/lib/types/types/enum/text-style.d.ts          BooleanNumber, CellValueType
//   core/lib/types/types/enum/data-validation-type.d.ts DataValidationType
//   core/lib/types/types/enum/date-system.d.ts         DateSystem
//   core/lib/types/sheets/typedef.d.ts                 RANGE_TYPE, FormulaType
//   core/lib/types/sheets/typedef.d.ts                 IWorkbookData, IWorksheetData, ICellData,
//                                                      IColumnData (`hd`), ICellData.custom
//   core/lib/types/types/interfaces/i-style-data.d.ts  IStyleData (`pd` padding, `st`, `cl`, `bg`, `n`)
//   sheets/lib/es/plugin-*.js                           SHEET_RANGE_PROTECTION_PLUGIN, serializeListOptions
//   sheets-data-validation/lib/es/index.js             CHECKBOX_FORMULA_1/2, SHEET_DATA_VALIDATION_PLUGIN
//   sheets-note/lib/es/index.js                        SHEET_NOTE_PLUGIN ({sheet: {row: {col: note}}})
//   sheets-conditional-formatting, sheets-filter       resource names (gsheets-import contract test)

import type { BooleanNumber, CellValueType, DataValidationType, DateSystem } from '@univerjs/core'

export type {
  ICellData,
  IColumnData,
  IRange,
  IRowData,
  ISheetDataValidationRule,
  IStyleData,
  IWorkbookData,
  IWorksheetData,
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

export const DV_TYPE = {
  CHECKBOX: 'checkbox' as DataValidationType,
  LIST: 'list' as DataValidationType,
  LIST_MULTIPLE: 'listMultiple' as DataValidationType,
} as const

export const DATE_SYSTEM = {
  D1900: 'date1900' as DateSystem,
  D1904: 'date1904' as DateSystem,
} as const

/** core `RANGE_TYPE`: whole rows (ROW), whole columns (COLUMN) or the whole sheet (ALL). */
export const RANGE_TYPE = { NORMAL: 0, ROW: 1, COLUMN: 2, ALL: 3 } as const

/** core `FormulaType.ARRAY` (`ICellData.ft`). */
export const FORMULA_TYPE_ARRAY = 2

/** Checked / unchecked values of a checkbox rule without its own (sheets-data-validation CHECKBOX_FORMULA_1/2). */
export const CHECKBOX_DEFAULT = { checked: 1, unchecked: 0 } as const

/** Names of the plugin resources this package reads or moves. */
export const RESOURCE = {
  NOTE: 'SHEET_NOTE_PLUGIN',
  DATA_VALIDATION: 'SHEET_DATA_VALIDATION_PLUGIN',
  CONDITIONAL_FORMATTING: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN',
  FILTER: 'SHEET_FILTER_PLUGIN',
  RANGE_PROTECTION: 'SHEET_RANGE_PROTECTION_PLUGIN',
  DEFINED_NAME: 'SHEET_DEFINED_NAME_PLUGIN',
} as const

/**
 * Resources that hold nothing tied to a row position: reordering rows leaves
 * them as they are. Defined names point at addresses, and a reorder keeps
 * addresses (Univer's own sort does the same).
 */
export const ROW_INDEPENDENT_RESOURCES: ReadonlySet<string> = new Set([
  RESOURCE.DEFINED_NAME,
  'SHEET_WORKSHEET_PROTECTION_PLUGIN',
  'SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN',
  'SHEET_AuthzIoMockService_PLUGIN',
])

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

/** Size sheets-note-ui gives a note that has none (same value as @naf-sheets/gsheets-import). */
export const DEFAULT_NOTE_SIZE = { width: 160, height: 72 } as const
