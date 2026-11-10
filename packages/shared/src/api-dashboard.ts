// The workbook dashboard («اللوحة») and the platform's appearance («المظهر»).
// Implemented by apps/api/src/dashboard/. Every error body is `ApiError` (./api.ts).
//
// The dashboard only reflects a workbook: nothing here writes a cell. Its
// figures are computed on the server from the latest committed snapshot, read
// exactly as the sync engine reads it (sheet-model `readTasks` for task
// sheets, plain cell values for the others), with the same permissions as
// opening the workbook (GET /api/workbooks/:id).

import type { IsoDate, IsoDateTime, SyncState, TaskLevel } from './domain'

// ---------------------------------------------------------------------------
// Deep links
// ---------------------------------------------------------------------------

/**
 * Where a figure's cells are: the editor opens `/workbooks/:id?sheet=&range=`.
 * `sheetId` is the Univer sheet id; `range` is A1 (`B4` or `B4:C10`).
 */
export interface CellLink {
  sheetId: string
  range: string
}

// ---------------------------------------------------------------------------
// The automatic dashboard
// ---------------------------------------------------------------------------

export type DashboardTaskStatus = 'done' | 'open' | 'overdue'

export interface DashboardTask {
  uid: string
  /** Univer sheet id. */
  sheetId: string
  sheetTitle: string
  title: string
  level: TaskLevel
  status: DashboardTaskStatus
  dueOn: IsoDate | null
  /** Names as the dashboard shows them (people, external contacts, unmatched names). */
  assignees: string[]
  /** The row's title cell. */
  link: CellLink
}

export interface DashboardSheet {
  /** Univer sheet id. */
  sheetId: string
  title: string
  /**
   * `tasks`: a sheet with a column mapping and task identities (a synced
   * sheet); its rows are read as tasks. `plain`: every other sheet; only
   * custom widgets read it.
   */
  kind: 'tasks' | 'plain'
  /** To-dos (level 0) still active; 0 for a plain sheet. */
  todos: number
  done: number
  open: number
  overdue: number
  /** done / todos, 0..1; null without to-dos. */
  completion: number | null
  /** Rows of the sheet that cannot be read as tasks yet (an unreadable date, an empty title…). */
  issues: number
  /** The completion column of its to-dos (or the sheet's first cell). */
  link: CellLink
  /**
   * The sheet's columns up to its last used one (at most 60), with the text of
   * the header row, for choosing a widget's column. System columns are left out.
   */
  columns: Array<{ key: string; header: string }>
  /** 1-based header row (D1 `sheets.header_row`; 1 for a sheet D1 does not know). */
  headerRow: number
}

export interface DashboardAssignee {
  /** `bc:<person id>`, `ext:<contact id>` or `name:<text>`. */
  key: string
  kind: 'bc_person' | 'external' | 'unmatched'
  name: string
  done: number
  open: number
  overdue: number
  /** The assignee cells of their rows (bounding range in the sheet holding most of them). */
  link: CellLink | null
}

export interface DashboardWeek {
  /** First day of the week (Sunday), YYYY-MM-DD. */
  weekStart: IsoDate
  done: number
  open: number
  overdue: number
  /** The due-date cells of the week's rows. */
  link: CellLink | null
}

export interface DashboardParentProgress {
  uid: string
  sheetId: string
  title: string
  done: number
  total: number
  link: CellLink
}

export interface DashboardActivity {
  id: number
  at: IsoDateTime
  direction: 'out' | 'in'
  /** sync_log.action, as stored (the client names it). */
  action: string
  field: string | null
  /** sync_log.status, as stored. */
  status: string
  /** The member's name; null for the system (reconciliation, webhooks, the automatic rule). */
  actorName: string | null
  /** The row's current title, when the row still exists. */
  taskTitle: string | null
  link: CellLink | null
}

export interface DashboardSync {
  state: SyncState | 'unlinked'
  lastSuccessAt: IsoDateTime | null
  counts: { pending: number; error: number; conflict: number }
}

export interface DashboardTotals {
  /** To-dos (level 0) of task sheets, still active in Basecamp. */
  todos: number
  done: number
  /** done / todos, 0..1; null without to-dos. */
  completion: number | null
  /** Rows (to-dos and subtasks) not completed whose due date is before today. */
  overdue: number
  /** Rows not completed due from today to the end of this week (Saturday). */
  dueThisWeek: number
  /** Rows with no due date and not completed. */
  undated: number
  /** Link for the completion figure: the completion column of the sheet with most to-dos. */
  completionLink: CellLink | null
  overdueLink: CellLink | null
  dueThisWeekLink: CellLink | null
}

/** GET /api/workbooks/:id/dashboard */
export interface DashboardResponse {
  workbookId: string
  /** The snapshot version the figures were computed from. */
  version: number
  /** Today in the platform's time zone (Asia/Riyadh), YYYY-MM-DD. */
  asOf: IsoDate
  weekStart: IsoDate
  weekEnd: IsoDate
  /** The caller may change the widgets (owner, editor, admin; never a viewer). */
  canEdit: boolean
  totals: DashboardTotals
  sheets: DashboardSheet[]
  /** Oldest due date first; at most `listLimit`. */
  overdue: DashboardTask[]
  /** Earliest due date first; at most `listLimit`. */
  dueThisWeek: DashboardTask[]
  listLimit: number
  /** Most rows first. */
  assignees: DashboardAssignee[]
  /** Consecutive weeks with due dates, oldest first; at most `timelineLimit`, around today. */
  timeline: DashboardWeek[]
  timelineLimit: number
  timelineTruncated: boolean
  /** `link`: the title cells of every subtask. */
  subtasks: { total: number; done: number; link: CellLink | null; parents: DashboardParentProgress[] }
  /** Newest first (sync_log), at most 20. */
  activity: DashboardActivity[]
  sync: DashboardSync
  widgets: DashboardWidget[]
  /** One per widget, in the same order. */
  results: WidgetResult[]
}

// ---------------------------------------------------------------------------
// Custom widgets
// ---------------------------------------------------------------------------

export type DashboardAggregation = 'sum' | 'count' | 'average' | 'min' | 'max'
export type DashboardDisplay = 'kpi' | 'bar' | 'pie' | 'donut' | 'line' | 'table'

export const DASHBOARD_AGGREGATIONS: readonly DashboardAggregation[] = ['sum', 'count', 'average', 'min', 'max']
export const DASHBOARD_DISPLAYS: readonly DashboardDisplay[] = ['kpi', 'bar', 'pie', 'donut', 'line', 'table']
export const WIDGET_TITLE_MAX_LENGTH = 120
export const MAX_WIDGETS_PER_WORKBOOK = 40

/**
 * What a widget reads. `column`: every data row of a column (the rows under
 * the sheet's header row). `range`: an A1 range (`B2:D30`), every cell in it.
 */
export type WidgetSource = { kind: 'column'; column: string } | { kind: 'range'; range: string }

export interface DashboardWidgetConfig {
  title: string
  /** Univer sheet id. */
  sheetId: string
  source: WidgetSource
  /**
   * `count`: non-empty cells (text included). `sum`, `average`, `min`, `max`:
   * numeric cells only; a formula cell counts with its computed value.
   */
  aggregation: DashboardAggregation
  /** A column letter: values are grouped by that column's text on the same row. */
  groupBy: string | null
  display: DashboardDisplay
}

export interface DashboardWidget extends DashboardWidgetConfig {
  id: string
  /** 0-based order on the dashboard. */
  position: number
  updatedAt: IsoDateTime
}

export interface WidgetGroup {
  /** The group cell's text (a date-formatted serial as YYYY-MM-DD); '' for rows whose group cell is empty. */
  label: string
  /** The aggregate of the group; null when it has no numeric value (sum, average, min, max). */
  value: number | null
  /** Non-empty cells in the group. */
  cells: number
  /** The group's source cells (bounding range). */
  link: CellLink | null
}

export type WidgetResult =
  | {
      widgetId: string | null
      ok: true
      /** The aggregate over every cell; null when nothing numeric was found. */
      value: number | null
      /** Non-empty cells read. */
      cells: number
      /** Non-empty cells that are not numbers (left out of sum, average, min, max). */
      skipped: number
      /** Formula cells without a computed value yet (left out). */
      uncomputed: number
      /** Null without `groupBy`. First-appearance order. At most `groupLimit`; the rest are counted in `otherGroups`. */
      groups: WidgetGroup[] | null
      otherGroups: number
      groupLimit: number
      /** All the widget's source cells. */
      link: CellLink | null
    }
  | {
      widgetId: string | null
      ok: false
      /** Arabic: what is wrong with the widget and what to do. */
      message: string
    }

/** POST /api/workbooks/:id/dashboard/widgets → 201 */
export type CreateWidgetRequest = DashboardWidgetConfig
/** PUT /api/workbooks/:id/dashboard/widgets/:widgetId */
export type UpdateWidgetRequest = DashboardWidgetConfig

export interface WidgetResponse {
  widget: DashboardWidget
  result: WidgetResult
}

/** POST /api/workbooks/:id/dashboard/widgets/:widgetId/remove — `confirmed` must be true. Nothing is deleted (removed_at). */
export interface RemoveWidgetRequest {
  confirmed: true
}

/** PUT /api/workbooks/:id/dashboard/widgets/order — every live widget id, once, in the new order. */
export interface ReorderWidgetsRequest {
  ids: string[]
}

/** Answer of remove and reorder. */
export interface WidgetListResponse {
  widgets: DashboardWidget[]
}

/** POST /api/workbooks/:id/dashboard/preview — computes a configuration without storing it. */
export type PreviewWidgetRequest = DashboardWidgetConfig

// ---------------------------------------------------------------------------
// Appearance («المظهر»): palette overrides, admin only
// ---------------------------------------------------------------------------

/**
 * The editable palette: each name maps to one CSS custom property of
 * apps/web/src/styles/theme.css, where the defaults live. The values here are
 * overrides only; an empty palette means the defaults.
 */
export const APPEARANCE_TOKENS = {
  accent: '--color-accent',
  accentContrast: '--color-accent-contrast',
  page: '--color-page',
  surface: '--color-surface',
  surfaceMuted: '--color-surface-muted',
  border: '--color-border',
  text: '--color-text',
  textMuted: '--color-text-muted',
  series1: '--chart-1',
  series2: '--chart-2',
  series3: '--chart-3',
  series4: '--chart-4',
  series5: '--chart-5',
  series6: '--chart-6',
  series7: '--chart-7',
  series8: '--chart-8',
} as const

export type AppearanceToken = keyof typeof APPEARANCE_TOKENS
export type AppearancePalette = Partial<Record<AppearanceToken, string>>

export const APPEARANCE_TOKEN_NAMES = Object.keys(APPEARANCE_TOKENS) as AppearanceToken[]
export const SERIES_TOKENS: readonly AppearanceToken[] = ['series1', 'series2', 'series3', 'series4', 'series5', 'series6', 'series7', 'series8']

/** `#rrggbb` only (lower or upper case). */
export const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/

/** GET /api/appearance (everyone signed in) and the answer of PUT /api/admin/appearance. */
export interface AppearanceResponse {
  palette: AppearancePalette
  updatedAt: IsoDateTime | null
  /** Warnings for the stored palette (contrast below WCAG AA); they never block a save. */
  warnings: ContrastWarning[]
}

/** PUT /api/admin/appearance — the whole palette; `{}` restores the defaults («استعادة الافتراضي»). */
export interface PutAppearanceRequest {
  palette: AppearancePalette
}

export interface ContrastCheck {
  foreground: AppearanceToken
  background: AppearanceToken
  /** WCAG 2.1: 4.5 for text, 3 for graphical objects and large text. */
  minimum: number
  use: 'text' | 'graphic'
}

/** The pairs the platform draws on each other. */
export const CONTRAST_CHECKS: readonly ContrastCheck[] = [
  { foreground: 'text', background: 'surface', minimum: 4.5, use: 'text' },
  { foreground: 'text', background: 'page', minimum: 4.5, use: 'text' },
  { foreground: 'text', background: 'surfaceMuted', minimum: 4.5, use: 'text' },
  { foreground: 'textMuted', background: 'surface', minimum: 4.5, use: 'text' },
  { foreground: 'textMuted', background: 'page', minimum: 4.5, use: 'text' },
  { foreground: 'accent', background: 'surface', minimum: 4.5, use: 'text' },
  { foreground: 'accentContrast', background: 'accent', minimum: 4.5, use: 'text' },
  ...SERIES_TOKENS.map((t): ContrastCheck => ({ foreground: t, background: 'surface', minimum: 3, use: 'graphic' })),
]

export interface ContrastWarning {
  foreground: AppearanceToken
  background: AppearanceToken
  /** Rounded to two decimals. */
  ratio: number
  minimum: number
}

function channel(hex: string, offset: number): number {
  const c = parseInt(hex.slice(offset, offset + 2), 16) / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG 2.1 relative luminance of `#rrggbb`. */
export function relativeLuminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5)
}

/** WCAG 2.1 contrast ratio of two `#rrggbb` colours, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** Every check whose two colours are both in `palette` and fall below the minimum. */
export function contrastWarnings(palette: AppearancePalette): ContrastWarning[] {
  const out: ContrastWarning[] = []
  for (const check of CONTRAST_CHECKS) {
    const fg = palette[check.foreground]
    const bg = palette[check.background]
    if (!fg || !bg || !HEX_COLOUR.test(fg) || !HEX_COLOUR.test(bg)) continue
    const ratio = contrastRatio(fg, bg)
    if (ratio < check.minimum) out.push({ foreground: check.foreground, background: check.background, ratio: Math.round(ratio * 100) / 100, minimum: check.minimum })
  }
  return out
}

/**
 * The palette as stored (names known, values `#rrggbb` lower-cased), or null
 * when anything in it is not: an unknown name or a value that is not hex.
 */
export function normalizePalette(value: unknown): AppearancePalette | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const out: AppearancePalette = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!(key in APPEARANCE_TOKENS)) return null
    if (typeof raw !== 'string' || !HEX_COLOUR.test(raw)) return null
    out[key as AppearanceToken] = raw.toLowerCase()
  }
  return out
}
