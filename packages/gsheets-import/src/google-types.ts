// Google Sheets API v4 — the subset of the `spreadsheets.get` response
// (includeGridData=true) that the converter reads or reports.
//
// Field names, nesting and enum values are copied from the official REST
// reference (checked 2026-11-10, pages "Last updated 2026-09-30 UTC"):
//   https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets
//   .../spreadsheets/sheets   (Sheet, SheetProperties, GridData, DimensionProperties,
//                              ConditionalFormatRule, FilterView, ProtectedRange,
//                              BasicFilter, BandedRange, DimensionGroup, Slicer, Table,
//                              CommentAnchor)
//   .../spreadsheets/cells    (CellData, CellFormat, NumberFormat, Borders, Padding,
//                              TextRotation, TextFormatRun, DataValidationRule, ChipRun)
//   .../spreadsheets/other    (Color, ColorStyle, HorizontalAlign, TextFormat, Link,
//                              ExtendedValue, ErrorValue, BooleanCondition, ConditionValue,
//                              GridRange, FilterSpec, FilterCriteria, SortSpec,
//                              EmbeddedObjectPosition, OverlayPosition, GridCoordinate)
//   .../spreadsheets/charts   (EmbeddedChart, ChartSpec.title)
//   .../v4/DimensionRange
//
// Every field is optional: the API omits default values (proto3), and the
// caller's fields mask may omit whole objects. Deprecated fields that the
// API still returns (`tabColor`, `backgroundColor`, `criteria` …) are listed
// because the docs say which one takes precedence.

// ---------------------------------------------------------------------------
// Spreadsheet
// ---------------------------------------------------------------------------

export interface GsSpreadsheet {
  spreadsheetId?: string
  properties?: GsSpreadsheetProperties
  sheets?: GsSheet[]
  namedRanges?: GsNamedRange[]
  spreadsheetUrl?: string
  developerMetadata?: unknown[]
  dataSources?: unknown[]
  /** Comment threads; only present with commentsViewMode INCLUDED. */
  comments?: GsCommentThread[]
}

export interface GsSpreadsheetProperties {
  title?: string
  locale?: string
  autoRecalc?: 'RECALCULATION_INTERVAL_UNSPECIFIED' | 'ON_CHANGE' | 'MINUTE' | 'HOUR'
  timeZone?: string
  /** Read-only. Default format of all cells. */
  defaultFormat?: GsCellFormat
  iterativeCalculationSettings?: { maxIterations?: number; convergenceThreshold?: number }
  spreadsheetTheme?: GsSpreadsheetTheme
  importFunctionsExternalUrlAccessAllowed?: boolean
}

export interface GsSpreadsheetTheme {
  primaryFontFamily?: string
  themeColors?: Array<{ colorType?: GsThemeColorType; color?: GsColorStyle }>
}

export interface GsNamedRange {
  namedRangeId?: string
  name?: string
  range?: GsGridRange
}

export interface GsCommentThread {
  commentId?: string
  anchorId?: string
  headPost?: { content?: string }
  replies?: unknown[]
  status?: 'STATUS_UNSPECIFIED' | 'OPEN' | 'RESOLVED'
  plainTextQuote?: string
}

// ---------------------------------------------------------------------------
// Sheet
// ---------------------------------------------------------------------------

export interface GsSheet {
  properties?: GsSheetProperties
  data?: GsGridData[]
  merges?: GsGridRange[]
  conditionalFormats?: GsConditionalFormatRule[]
  filterViews?: GsFilterView[]
  protectedRanges?: GsProtectedRange[]
  basicFilter?: GsBasicFilter
  charts?: GsEmbeddedChart[]
  bandedRanges?: GsBandedRange[]
  developerMetadata?: unknown[]
  rowGroups?: GsDimensionGroup[]
  columnGroups?: GsDimensionGroup[]
  slicers?: GsSlicer[]
  tables?: GsTable[]
  commentAnchors?: GsCommentAnchor[]
}

export type GsSheetType = 'SHEET_TYPE_UNSPECIFIED' | 'GRID' | 'OBJECT' | 'DATA_SOURCE'

export interface GsSheetProperties {
  sheetId?: number
  title?: string
  index?: number
  sheetType?: GsSheetType
  gridProperties?: GsGridProperties
  hidden?: boolean
  /** Deprecated: `tabColorStyle` takes precedence. */
  tabColor?: GsColor
  tabColorStyle?: GsColorStyle
  rightToLeft?: boolean
  dataSourceSheetProperties?: unknown
}

export interface GsGridProperties {
  rowCount?: number
  columnCount?: number
  frozenRowCount?: number
  frozenColumnCount?: number
  hideGridlines?: boolean
  rowGroupControlAfter?: boolean
  columnGroupControlAfter?: boolean
}

export interface GsGridData {
  startRow?: number
  startColumn?: number
  rowData?: GsRowData[]
  rowMetadata?: GsDimensionProperties[]
  columnMetadata?: GsDimensionProperties[]
}

export interface GsRowData {
  values?: GsCellData[]
}

export interface GsDimensionProperties {
  /** Read-only. */
  hiddenByFilter?: boolean
  hiddenByUser?: boolean
  pixelSize?: number
  developerMetadata?: unknown[]
  dataSourceColumnReference?: { name?: string }
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

export interface GsCellData {
  userEnteredValue?: GsExtendedValue
  /** Read-only. For formulas, the calculated value. */
  effectiveValue?: GsExtendedValue
  /** Read-only. The value as shown to the user. */
  formattedValue?: string
  userEnteredFormat?: GsCellFormat
  /** Read-only. Includes conditional formatting results and computed number formats. */
  effectiveFormat?: GsCellFormat
  /** Read-only. Empty when the cell holds several links. */
  hyperlink?: string
  note?: string
  textFormatRuns?: GsTextFormatRun[]
  dataValidation?: GsDataValidationRule
  /** Only the top-left cell of a pivot table holds its definition. */
  pivotTable?: Record<string, unknown>
  dataSourceTable?: Record<string, unknown>
  dataSourceFormula?: Record<string, unknown>
  chipRuns?: GsChipRun[]
}

export interface GsExtendedValue {
  numberValue?: number
  stringValue?: string
  boolValue?: boolean
  formulaValue?: string
  /** Read-only. */
  errorValue?: GsErrorValue
}

export type GsErrorType =
  | 'ERROR_TYPE_UNSPECIFIED'
  | 'ERROR'
  | 'NULL_VALUE'
  | 'DIVIDE_BY_ZERO'
  | 'VALUE'
  | 'REF'
  | 'NAME'
  | 'NUM'
  | 'N_A'
  | 'LOADING'

export interface GsErrorValue {
  type?: GsErrorType
  message?: string
}

export interface GsCellFormat {
  numberFormat?: GsNumberFormat
  /** Deprecated: `backgroundColorStyle` takes precedence. */
  backgroundColor?: GsColor
  backgroundColorStyle?: GsColorStyle
  borders?: GsBorders
  padding?: GsPadding
  horizontalAlignment?: GsHorizontalAlign
  verticalAlignment?: GsVerticalAlign
  wrapStrategy?: GsWrapStrategy
  textDirection?: GsTextDirection
  textFormat?: GsTextFormat
  hyperlinkDisplayType?: 'HYPERLINK_DISPLAY_TYPE_UNSPECIFIED' | 'LINKED' | 'PLAIN_TEXT'
  textRotation?: GsTextRotation
}

export type GsNumberFormatType =
  | 'NUMBER_FORMAT_TYPE_UNSPECIFIED'
  | 'TEXT'
  | 'NUMBER'
  | 'PERCENT'
  | 'CURRENCY'
  | 'DATE'
  | 'TIME'
  | 'DATE_TIME'
  | 'SCIENTIFIC'

export interface GsNumberFormat {
  type?: GsNumberFormatType
  pattern?: string
}

export interface GsBorders {
  top?: GsBorder
  bottom?: GsBorder
  left?: GsBorder
  right?: GsBorder
}

export type GsBorderStyle =
  | 'STYLE_UNSPECIFIED'
  | 'DOTTED'
  | 'DASHED'
  | 'SOLID'
  | 'SOLID_MEDIUM'
  | 'SOLID_THICK'
  | 'NONE'
  | 'DOUBLE'

export interface GsBorder {
  style?: GsBorderStyle
  /** Deprecated; the width is determined by `style`. */
  width?: number
  /** Deprecated: `colorStyle` takes precedence. */
  color?: GsColor
  colorStyle?: GsColorStyle
}

/** In pixels. */
export interface GsPadding {
  top?: number
  right?: number
  bottom?: number
  left?: number
}

export type GsHorizontalAlign = 'HORIZONTAL_ALIGN_UNSPECIFIED' | 'LEFT' | 'CENTER' | 'RIGHT'
export type GsVerticalAlign = 'VERTICAL_ALIGN_UNSPECIFIED' | 'TOP' | 'MIDDLE' | 'BOTTOM'
export type GsWrapStrategy = 'WRAP_STRATEGY_UNSPECIFIED' | 'OVERFLOW_CELL' | 'LEGACY_WRAP' | 'CLIP' | 'WRAP'
export type GsTextDirection = 'TEXT_DIRECTION_UNSPECIFIED' | 'LEFT_TO_RIGHT' | 'RIGHT_TO_LEFT'

export interface GsTextRotation {
  /** Degrees, -90..90. */
  angle?: number
  vertical?: boolean
}

export interface GsTextFormat {
  /** Deprecated: `foregroundColorStyle` takes precedence. */
  foregroundColor?: GsColor
  foregroundColorStyle?: GsColorStyle
  fontFamily?: string
  fontSize?: number
  bold?: boolean
  italic?: boolean
  strikethrough?: boolean
  underline?: boolean
  link?: GsLink
}

export interface GsLink {
  uri?: string
}

export interface GsTextFormatRun {
  /** Zero-based, in UTF-16 code units. The run continues until the next run's start. */
  startIndex?: number
  /** Absent values inherit the cell's format. */
  format?: GsTextFormat
}

export interface GsChipRun {
  startIndex?: number
  chip?: {
    personProperties?: { email?: string; displayFormat?: string }
    richLinkProperties?: { uri?: string; mimeType?: string }
  }
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

/** RGBA in [0, 1]. Omitted components are 0 (proto3 default). */
export interface GsColor {
  red?: number
  green?: number
  blue?: number
  alpha?: number
}

export type GsThemeColorType =
  | 'THEME_COLOR_TYPE_UNSPECIFIED'
  | 'TEXT'
  | 'BACKGROUND'
  | 'ACCENT1'
  | 'ACCENT2'
  | 'ACCENT3'
  | 'ACCENT4'
  | 'ACCENT5'
  | 'ACCENT6'
  | 'LINK'

/** Union field `kind`: at most one is set. */
export interface GsColorStyle {
  rgbColor?: GsColor
  themeColor?: GsThemeColorType
}

// ---------------------------------------------------------------------------
// Conditions, validation, conditional formats
// ---------------------------------------------------------------------------

export type GsConditionType =
  | 'CONDITION_TYPE_UNSPECIFIED'
  | 'NUMBER_GREATER'
  | 'NUMBER_GREATER_THAN_EQ'
  | 'NUMBER_LESS'
  | 'NUMBER_LESS_THAN_EQ'
  | 'NUMBER_EQ'
  | 'NUMBER_NOT_EQ'
  | 'NUMBER_BETWEEN'
  | 'NUMBER_NOT_BETWEEN'
  | 'TEXT_CONTAINS'
  | 'TEXT_NOT_CONTAINS'
  | 'TEXT_STARTS_WITH'
  | 'TEXT_ENDS_WITH'
  | 'TEXT_EQ'
  | 'TEXT_IS_EMAIL'
  | 'TEXT_IS_URL'
  | 'DATE_EQ'
  | 'DATE_BEFORE'
  | 'DATE_AFTER'
  | 'DATE_ON_OR_BEFORE'
  | 'DATE_ON_OR_AFTER'
  | 'DATE_BETWEEN'
  | 'DATE_NOT_BETWEEN'
  | 'DATE_IS_VALID'
  | 'ONE_OF_RANGE'
  | 'ONE_OF_LIST'
  | 'BLANK'
  | 'NOT_BLANK'
  | 'CUSTOM_FORMULA'
  | 'BOOLEAN'
  | 'TEXT_NOT_EQ'
  | 'DATE_NOT_EQ'
  | 'FILTER_EXPRESSION'

export type GsRelativeDate =
  | 'RELATIVE_DATE_UNSPECIFIED'
  | 'PAST_YEAR'
  | 'PAST_MONTH'
  | 'PAST_WEEK'
  | 'YESTERDAY'
  | 'TODAY'
  | 'TOMORROW'

/** Union field `value`: exactly one is set. */
export interface GsConditionValue {
  relativeDate?: GsRelativeDate
  /** Parsed as if typed into a cell; formulas begin with `=` or `+`. */
  userEnteredValue?: string
}

export interface GsBooleanCondition {
  type?: GsConditionType
  values?: GsConditionValue[]
}

export interface GsDataValidationRule {
  condition?: GsBooleanCondition
  inputMessage?: string
  strict?: boolean
  showCustomUi?: boolean
  /**
   * NOT part of the Sheets API: the discovery document (revision 20261109)
   * has no field for chip colours, display style or multiple selection.
   * Filled only by @naf-sheets/xlsx-import from what an .xlsx carries (and,
   * for a public Google link, from Google's own rendering of the sheet).
   * apps/api OPEN_QUESTIONS.md "Google import" G32.
   */
  naf?: GsValidationExtras
}

/** Dropdown and validation details an .xlsx (or Google's rendering) carries beyond the API model. */
export interface GsValidationExtras {
  /**
   * How a list shows in the cell. CHIP only on evidence (Google rendered the
   * cell as a chip); PLAIN_TEXT for Excel's hidden arrow (`showDropDown="1"`).
   * Absent: `showCustomUi` decides (arrow or plain text).
   */
  displayStyle?: 'CHIP' | 'ARROW' | 'PLAIN_TEXT'
  /** Chip colour per item text, `#rrggbb` (Google colours an item, not a position). */
  itemColors?: Record<string, string>
  /** Excel's three error styles; `strict` keeps meaning STOP. */
  errorStyle?: 'STOP' | 'WARNING' | 'INFORMATION'
  /** False: Excel raised no alert at all for invalid input (`showErrorMessage` off). */
  showErrorMessage?: boolean
  errorTitle?: string
  errorMessage?: string
  /** Title of the input message (`inputMessage` holds its text). */
  inputTitle?: string
  /** Excel "Ignore blank" unchecked (`allowBlank` off). */
  rejectBlank?: boolean
  /** NUMBER_* conditions that Excel applies to whole numbers or to the length of text. */
  numberKind?: 'WHOLE' | 'TEXT_LENGTH'
}

export interface GsConditionalFormatRule {
  ranges?: GsGridRange[]
  booleanRule?: { condition?: GsBooleanCondition; format?: GsCellFormat }
  gradientRule?: { minpoint?: GsInterpolationPoint; midpoint?: GsInterpolationPoint; maxpoint?: GsInterpolationPoint }
}

export type GsInterpolationPointType =
  | 'INTERPOLATION_POINT_TYPE_UNSPECIFIED'
  | 'MIN'
  | 'MAX'
  | 'NUMBER'
  | 'PERCENT'
  | 'PERCENTILE'

export interface GsInterpolationPoint {
  /** Deprecated: `colorStyle` takes precedence. */
  color?: GsColor
  colorStyle?: GsColorStyle
  type?: GsInterpolationPointType
  /** May be a formula. Unused for MIN and MAX. */
  value?: string
}

// ---------------------------------------------------------------------------
// Ranges, filters, embedded objects
// ---------------------------------------------------------------------------

/** Half open: start inclusive, end exclusive. A missing index is unbounded. */
export interface GsGridRange {
  sheetId?: number
  startRowIndex?: number
  endRowIndex?: number
  startColumnIndex?: number
  endColumnIndex?: number
}

export interface GsDimensionRange {
  sheetId?: number
  dimension?: 'DIMENSION_UNSPECIFIED' | 'ROWS' | 'COLUMNS'
  startIndex?: number
  endIndex?: number
}

export interface GsFilterCriteria {
  hiddenValues?: string[]
  condition?: GsBooleanCondition
  /** Deprecated: `visibleBackgroundColorStyle` takes precedence. */
  visibleBackgroundColor?: GsColor
  visibleBackgroundColorStyle?: GsColorStyle
  /** Deprecated: `visibleForegroundColorStyle` takes precedence. */
  visibleForegroundColor?: GsColor
  visibleForegroundColorStyle?: GsColorStyle
}

export interface GsFilterSpec {
  filterCriteria?: GsFilterCriteria
  columnIndex?: number
  dataSourceColumnReference?: { name?: string }
}

export interface GsSortSpec {
  sortOrder?: 'SORT_ORDER_UNSPECIFIED' | 'ASCENDING' | 'DESCENDING'
  dimensionIndex?: number
}

export interface GsBasicFilter {
  range?: GsGridRange
  tableId?: string
  sortSpecs?: GsSortSpec[]
  /** Deprecated in favour of `filterSpecs`; keyed by column index. */
  criteria?: Record<string, GsFilterCriteria>
  filterSpecs?: GsFilterSpec[]
}

export interface GsFilterView extends GsBasicFilter {
  filterViewId?: number
  title?: string
  namedRangeId?: string
}

export interface GsProtectedRange {
  protectedRangeId?: number
  /** May be fully unbounded: a protected sheet. */
  range?: GsGridRange
  namedRangeId?: string
  tableId?: string
  description?: string
  warningOnly?: boolean
  requestingUserCanEdit?: boolean
  unprotectedRanges?: GsGridRange[]
  editors?: { users?: string[]; groups?: string[]; domainUsersCanEdit?: boolean }
}

export interface GsGridCoordinate {
  sheetId?: number
  rowIndex?: number
  columnIndex?: number
}

export interface GsEmbeddedObjectPosition {
  sheetId?: number
  overlayPosition?: {
    anchorCell?: GsGridCoordinate
    offsetXPixels?: number
    offsetYPixels?: number
    widthPixels?: number
    heightPixels?: number
  }
  newSheet?: boolean
}

export interface GsEmbeddedChart {
  chartId?: number
  spec?: { title?: string; altText?: string; [key: string]: unknown }
  position?: GsEmbeddedObjectPosition
  border?: unknown
}

export interface GsBandingProperties {
  headerColor?: GsColor
  headerColorStyle?: GsColorStyle
  firstBandColor?: GsColor
  firstBandColorStyle?: GsColorStyle
  secondBandColor?: GsColor
  secondBandColorStyle?: GsColorStyle
  footerColor?: GsColor
  footerColorStyle?: GsColorStyle
}

export interface GsBandedRange {
  bandedRangeId?: number
  bandedRangeReference?: string
  range?: GsGridRange
  rowProperties?: GsBandingProperties
  columnProperties?: GsBandingProperties
}

export interface GsDimensionGroup {
  range?: GsDimensionRange
  depth?: number
  collapsed?: boolean
}

export interface GsSlicer {
  slicerId?: number
  spec?: { title?: string; dataRange?: GsGridRange; columnIndex?: number; [key: string]: unknown }
  position?: GsEmbeddedObjectPosition
}

export interface GsTable {
  tableId?: string
  name?: string
  range?: GsGridRange
  rowsProperties?: unknown
  columnProperties?: unknown[]
}

export interface GsCommentAnchor {
  anchorId?: string
  range?: GsGridRange
}
