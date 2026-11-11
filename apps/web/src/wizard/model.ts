// Linking wizard (spec §7.3): state, reducer, validation and the `LinkPlan`
// it sends. Pure: the screen feeds it the workbook's sheets (text grids from
// the current snapshot) and the user's choices; every Basecamp call happens
// in the screen. Unit-tested.
//
// The suggestions come from @naf-sheets/gsheets-import's wizard helpers, so
// the same rules serve an imported file and a blank one.

import {
  analyzeStatusColumn,
  COMPLETED_VALUE_SUGGESTIONS,
  detectHeaderRow,
  detectHierarchy,
  suggestColumnMapping,
  textGridFromWorksheet,
} from '@naf-sheets/gsheets-import'
import type { HierarchyDetection, StatusColumnAnalysis, TextGrid } from '@naf-sheets/gsheets-import'
import type { ColumnPlan, LinkPlan, MappedField, ProjectChoice, SheetMeta, SheetPlan } from '@naf-sheets/shared'
import { isDashboardSheet } from '@naf-sheets/shared'
import type { IWorksheetData } from '@univerjs/core'
import { columnLetters } from '../lib/cell-target'
import { t } from '../strings'

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

export interface WizardSheet {
  /**
   * `SheetPlan.sheetId`.
   * OPEN: the contract does not say whether `SheetPlan.sheetId` is the
   * platform's sheet id (`SheetMeta.id`) or the Univer sheet id; this sends
   * `SheetMeta.id` (apps/web/OPEN_QUESTIONS.md #17).
   */
  planId: string
  univerSheetId: string
  title: string
  grid: TextGrid
}

/** Columns whose header starts with this are the platform's hidden system columns (§8): never mapped. */
const SYSTEM_COLUMN_PREFIX = '__'

/**
 * The wizard's sheets: every sheet the platform knows (`SheetMeta`), in tab
 * order, with the text of its cells from the snapshot. A sheet added in the
 * grid but not registered yet has no `SheetMeta` and cannot be planned; it is
 * counted so the screen can say it stays local.
 * OPEN: apps/web/OPEN_QUESTIONS.md #24.
 */
export function wizardSheets(metas: readonly SheetMeta[], snapshot: { sheets?: Record<string, Partial<IWorksheetData>> } | null): {
  sheets: WizardSheet[]
  unregistered: number
} {
  const ordered = [...metas].sort((a, b) => a.position - b.position)
  const snapshotSheets = snapshot?.sheets ?? {}
  const known = new Set(ordered.map((m) => m.univerSheetId))
  return {
    sheets: ordered.map((m) => {
      const data = snapshotSheets[m.univerSheetId]
      return { planId: m.id, univerSheetId: m.univerSheetId, title: m.title, grid: data ? textGridFromWorksheet(data) : [] }
    }),
    // The dashboard tab «اللوحة» is no sheet to link (@naf-sheets/shared dashboard-sheet.ts).
    unregistered: Object.keys(snapshotSheets).filter((id) => !known.has(id) && !isDashboardSheet(snapshotSheets[id])).length,
  }
}

export const gridWidth = (grid: TextGrid): number => grid.reduce((n, row) => Math.max(n, row.length), 0)
export const cellText = (grid: TextGrid, row: number, column: number): string => grid[row]?.[column] ?? ''

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const STEPS = ['project', 'sheets', 'headerRow', 'columns', 'hierarchy', 'status', 'assignees', 'existingTasks', 'preview'] as const
export type WizardStep = (typeof STEPS)[number]

/** Steps answered per synced sheet (3–8). */
const PER_SHEET_STEPS: ReadonlySet<WizardStep> = new Set(['headerRow', 'columns', 'hierarchy', 'status', 'assignees', 'existingTasks'])

export type SheetMode = SheetPlan['mode']

export interface ColumnDraft {
  column: number
  header: string
  field: MappedField
  /** What `suggestColumnMapping` proposed, to mark it in the screen. */
  suggested: MappedField
  appendToDescription: boolean
}

export type HierarchyDraft = { mode: 'flat' } | { mode: 'numbering'; column: number | null } | { mode: 'indent' }

export interface SheetDraft {
  mode: SheetMode
  todolistId: number | null
  /** 1-based (§7.3 step 3). */
  headerRow: number
  headerDetected: boolean
  columns: ColumnDraft[]
  hierarchy: HierarchyDraft
  completedValues: string[]
  existingTasks: SheetPlan['existingTasks']
  /** Assignee text → Basecamp person id, or null for unassigned (§7.3 step 7). */
  assigneeMatches: Record<string, number | null>
}

export type ProjectDraft = { mode: 'existing'; projectId: number | null } | { mode: 'create' } | { mode: 'none' }

export interface WizardState {
  workbookTitle: string
  sheets: WizardSheet[]
  step: WizardStep
  project: ProjectDraft | null
  drafts: Record<string, SheetDraft>
  /** The sheet shown in steps 3–8. */
  activeSheet: string | null
  /** «راجعتُ المطابقات المقترحة وأعتمدها» (§7.3 step 8, match by title). */
  matchesReviewed: boolean
  /** Index in STEPS of the furthest step reached with «التالي»; the step list jumps only that far. */
  furthest: number
}

// ---------------------------------------------------------------------------
// Suggestions for one sheet
// ---------------------------------------------------------------------------

export function columnDrafts(grid: TextGrid, headerRow: number): ColumnDraft[] {
  const width = gridWidth(grid)
  const headers = Array.from({ length: width }, (_, c) => cellText(grid, headerRow - 1, c))
  return suggestColumnMapping(headers)
    .filter((s) => !s.header.trim().startsWith(SYSTEM_COLUMN_PREFIX))
    .map((s) => ({ column: s.column, header: s.header, field: s.field, suggested: s.field, appendToDescription: false }))
}

export const columnOf = (columns: readonly ColumnDraft[], field: MappedField): number | null =>
  columns.find((c) => c.field === field)?.column ?? null

/** Rows below the header whose title cell is not empty: the sheet's tasks. */
export function taskRows(grid: TextGrid, headerRow: number, titleColumn: number): number[] {
  const rows: number[] = []
  for (let r = headerRow; r < grid.length; r++) if (cellText(grid, r, titleColumn).trim() !== '') rows.push(r)
  return rows
}

export function detectHierarchyFor(grid: TextGrid, headerRow: number, titleColumn: number | null, hierarchy?: HierarchyDraft): HierarchyDetection | null {
  if (titleColumn === null) return null
  const base = { headerRow: headerRow - 1, titleColumn }
  if (!hierarchy) return detectHierarchy(grid, base)
  if (hierarchy.mode === 'numbering') return hierarchy.column === null ? null : detectHierarchy(grid, { ...base, numberingColumn: hierarchy.column })
  if (hierarchy.mode === 'indent') return detectHierarchy(grid, { ...base, numberingColumn: null })
  return { source: 'none', numberingColumn: null, rows: taskRows(grid, headerRow, titleColumn).map((row) => ({ row, level: 0, parentRow: null })), warnings: [] }
}

function suggestedHierarchy(grid: TextGrid, headerRow: number, columns: readonly ColumnDraft[]): HierarchyDraft {
  const detection = detectHierarchyFor(grid, headerRow, columnOf(columns, 'title'))
  if (detection?.source === 'numbering') return { mode: 'numbering', column: detection.numberingColumn }
  if (detection?.source === 'indentation') return { mode: 'indent' }
  return { mode: 'flat' }
}

export function statusAnalysis(grid: TextGrid, headerRow: number, columns: readonly ColumnDraft[]): StatusColumnAnalysis | null {
  const statusColumn = columnOf(columns, 'completed')
  if (statusColumn === null) return null
  const titleColumn = columnOf(columns, 'title')
  const rows = titleColumn === null ? [] : taskRows(grid, headerRow, titleColumn)
  return analyzeStatusColumn(rows.map((r) => cellText(grid, r, statusColumn)))
}

/** The checkbox column's TRUE value, as the text grid writes booleans. */
const BOOLEAN_TRUE = 'TRUE'

/**
 * Values pre-selected as "completed" (§7.3 step 6). A text column takes the
 * package's suggestions found in it; a checkbox column takes TRUE.
 * OPEN: an empty status column has no values to choose from; the screen
 * offers the package's suggestions (منجز، تم، Done), all pre-selected
 * (apps/web/OPEN_QUESTIONS.md #23).
 */
export function suggestedCompletedValues(analysis: StatusColumnAnalysis | null): string[] {
  if (!analysis) return []
  if (analysis.kind === 'boolean') return analysis.suggestedCompleted.length > 0 ? analysis.suggestedCompleted : [BOOLEAN_TRUE]
  if (analysis.kind === 'empty') return [...COMPLETED_VALUE_SUGGESTIONS]
  return analysis.suggestedCompleted
}

/** Everything derived from the grid once a header row is chosen. */
function analyzedDraft(sheet: WizardSheet, headerRow: number, headerDetected: boolean, keep: Pick<SheetDraft, 'mode' | 'todolistId' | 'existingTasks'>): SheetDraft {
  const columns = columnDrafts(sheet.grid, headerRow)
  return {
    ...keep,
    headerRow,
    headerDetected,
    columns,
    hierarchy: suggestedHierarchy(sheet.grid, headerRow, columns),
    completedValues: suggestedCompletedValues(statusAnalysis(sheet.grid, headerRow, columns)),
    assigneeMatches: {},
  }
}

export function initialDraft(sheet: WizardSheet): SheetDraft {
  const detection = detectHeaderRow(sheet.grid)
  // OPEN: every sheet starts as «إنشاء قائمة جديدة باسم الورقة»; the user
  // switches any of them to local (apps/web/OPEN_QUESTIONS.md #25).
  return analyzedDraft(sheet, detection.row + 1, detection.reason === 'synonyms', { mode: 'new', todolistId: null, existingTasks: 'create_all' })
}

export function initialState(workbookTitle: string, sheets: WizardSheet[]): WizardState {
  return {
    workbookTitle,
    sheets,
    step: 'project',
    project: null,
    drafts: Object.fromEntries(sheets.map((s) => [s.planId, initialDraft(s)])),
    activeSheet: null,
    matchesReviewed: false,
    furthest: 0,
  }
}

// ---------------------------------------------------------------------------
// Which steps apply
// ---------------------------------------------------------------------------

export const syncedSheets = (state: WizardState): WizardSheet[] =>
  state.sheets.filter((s) => state.drafts[s.planId]?.mode !== 'local')

const anyDraft = (state: WizardState, test: (d: SheetDraft) => boolean): boolean =>
  syncedSheets(state).some((s) => {
    const d = state.drafts[s.planId]
    return d ? test(d) : false
  })

/**
 * Steps 3–8 apply only to synced sheets; status and assignees only where such
 * a column is mapped; existing tasks only where a sheet joins an existing list.
 */
export function isStepApplicable(state: WizardState, step: WizardStep): boolean {
  if (step === 'project') return true
  if (state.project?.mode === 'none') return false
  if (step === 'sheets' || step === 'preview') return true
  if (syncedSheets(state).length === 0) return false
  if (step === 'status') return anyDraft(state, (d) => columnOf(d.columns, 'completed') !== null)
  if (step === 'assignees') return anyDraft(state, (d) => columnOf(d.columns, 'assignees') !== null)
  if (step === 'existingTasks') return anyDraft(state, (d) => d.mode === 'existing')
  return true
}

export const isPerSheetStep = (step: WizardStep): boolean => PER_SHEET_STEPS.has(step)

/** Synced sheets the step concerns (all synced sheets for 3–5). */
export function sheetsForStep(state: WizardState, step: WizardStep): WizardSheet[] {
  const synced = syncedSheets(state)
  if (step === 'status') return synced.filter((s) => columnOf(state.drafts[s.planId]?.columns ?? [], 'completed') !== null)
  if (step === 'assignees') return synced.filter((s) => columnOf(state.drafts[s.planId]?.columns ?? [], 'assignees') !== null)
  if (step === 'existingTasks') return synced.filter((s) => state.drafts[s.planId]?.mode === 'existing')
  return isPerSheetStep(step) ? synced : []
}

// ---------------------------------------------------------------------------
// Validation (Arabic messages, shown before «التالي» moves on)
// ---------------------------------------------------------------------------

const fieldName = (field: MappedField): string => t.wizard.columns.fields[field]

export function stepErrors(state: WizardState, step: WizardStep): string[] {
  const errors: string[] = []
  const e = t.wizard.errors
  if (step === 'project') {
    if (!state.project) errors.push(e.projectRequired)
    else if (state.project.mode === 'existing' && state.project.projectId === null) errors.push(e.projectMissing)
    return errors
  }
  if (step === 'sheets') {
    const seen = new Set<number>()
    for (const sheet of state.sheets) {
      const d = state.drafts[sheet.planId]
      if (d?.mode !== 'existing') continue
      if (d.todolistId === null) errors.push(e.listMissing(sheet.title))
      else if (seen.has(d.todolistId)) errors.push(e.listTwice(sheet.title))
      else seen.add(d.todolistId)
    }
    return errors
  }
  for (const sheet of sheetsForStep(state, step)) {
    const d = state.drafts[sheet.planId]
    if (!d) continue
    if (step === 'headerRow') {
      const max = Math.max(1, sheet.grid.length)
      if (sheet.grid.length === 0) errors.push(e.emptySheet(sheet.title))
      else if (!Number.isInteger(d.headerRow) || d.headerRow < 1 || d.headerRow > max) errors.push(e.headerRow(sheet.title, max))
    }
    if (step === 'columns') {
      if (columnOf(d.columns, 'title') === null) errors.push(e.titleMissing(sheet.title))
      const counts = new Map<MappedField, number>()
      for (const c of d.columns) if (c.field !== 'free') counts.set(c.field, (counts.get(c.field) ?? 0) + 1)
      for (const [field, n] of counts) if (n > 1) errors.push(e.fieldTwice(sheet.title, fieldName(field)))
    }
    if (step === 'hierarchy' && d.hierarchy.mode === 'numbering' && d.hierarchy.column === null) errors.push(e.numberingMissing(sheet.title))
  }
  return errors
}

/** The steps that must be valid before `step` can be shown. */
export function firstInvalidStepBefore(state: WizardState, step: WizardStep): WizardStep | null {
  for (const s of STEPS) {
    if (s === step) return null
    if (isStepApplicable(state, s) && stepErrors(state, s).length > 0) return s
  }
  return null
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export type WizardAction =
  | { type: 'setProject'; project: ProjectDraft }
  | { type: 'setSheetMode'; sheet: string; mode: SheetMode }
  | { type: 'setTodolist'; sheet: string; todolistId: number | null }
  | { type: 'setHeaderRow'; sheet: string; row: number }
  | { type: 'setColumnField'; sheet: string; column: number; field: MappedField }
  | { type: 'setAppendToDescription'; sheet: string; column: number; value: boolean }
  | { type: 'setHierarchy'; sheet: string; hierarchy: HierarchyDraft }
  | { type: 'setCompletedValue'; sheet: string; value: string; completed: boolean }
  | { type: 'setAssigneeMatch'; sheet: string; text: string; personId: number | null }
  | { type: 'setExistingTasks'; sheet: string; value: SheetPlan['existingTasks'] }
  | { type: 'setMatchesReviewed'; value: boolean }
  | { type: 'setActiveSheet'; sheet: string }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'goTo'; step: WizardStep }

function updateDraft(state: WizardState, sheet: string, change: (d: SheetDraft, s: WizardSheet) => SheetDraft): WizardState {
  const current = state.drafts[sheet]
  const info = state.sheets.find((s) => s.planId === sheet)
  if (!current || !info) return state
  // Any change to what will be sent invalidates a review of the proposed matches.
  return { ...state, matchesReviewed: false, drafts: { ...state.drafts, [sheet]: change(current, info) } }
}

/** The first applicable step after (`dir` 1) or before (`dir` -1) `from`. */
export function neighbourStep(state: WizardState, from: WizardStep, dir: 1 | -1): WizardStep | null {
  for (let i = STEPS.indexOf(from) + dir; i >= 0 && i < STEPS.length; i += dir) {
    const step = STEPS[i] as WizardStep
    if (isStepApplicable(state, step)) return step
  }
  return null
}

/** Keep the sheet tab on a sheet the step concerns. */
function withActiveSheet(state: WizardState): WizardState {
  const sheets = sheetsForStep(state, state.step)
  if (sheets.length === 0) return state.activeSheet === null ? state : { ...state, activeSheet: null }
  if (sheets.some((s) => s.planId === state.activeSheet)) return state
  return { ...state, activeSheet: sheets[0]?.planId ?? null }
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'setProject': {
      // Lists belong to a project: a different project drops every list choice.
      const sameProject =
        state.project?.mode === 'existing' && action.project.mode === 'existing' && state.project.projectId === action.project.projectId
      const drafts = sameProject
        ? state.drafts
        : Object.fromEntries(
            Object.entries(state.drafts).map(([id, d]) => [
              id,
              d.mode === 'existing' ? { ...d, mode: 'new' as const, todolistId: null, existingTasks: 'create_all' as const } : d,
            ]),
          )
      return { ...state, project: action.project, drafts, matchesReviewed: false }
    }
    case 'setSheetMode': {
      if (action.mode === 'existing' && state.project?.mode !== 'existing') return state
      return updateDraft(state, action.sheet, (d) => ({
        ...d,
        mode: action.mode,
        todolistId: action.mode === 'existing' ? d.todolistId : null,
        existingTasks: action.mode === 'existing' ? d.existingTasks : 'create_all',
      }))
    }
    case 'setTodolist':
      return updateDraft(state, action.sheet, (d) => (d.mode === 'existing' ? { ...d, todolistId: action.todolistId } : d))
    case 'setHeaderRow':
      return updateDraft(state, action.sheet, (d, s) => {
        if (!Number.isInteger(action.row) || action.row < 1) return { ...d, headerRow: action.row, headerDetected: false }
        return analyzedDraft(s, action.row, false, d)
      })
    case 'setColumnField':
      return updateDraft(state, action.sheet, (d, s) => {
        const columns = d.columns.map((c) =>
          c.column === action.column ? { ...c, field: action.field, appendToDescription: action.field === 'free' ? c.appendToDescription : false } : c,
        )
        const before = d.columns.find((c) => c.column === action.column)?.field
        let next: SheetDraft = { ...d, columns }
        if (action.field === 'title' || before === 'title') next = { ...next, hierarchy: suggestedHierarchy(s.grid, d.headerRow, columns) }
        if (action.field === 'completed' || before === 'completed' || action.field === 'title' || before === 'title') {
          next = { ...next, completedValues: suggestedCompletedValues(statusAnalysis(s.grid, d.headerRow, columns)) }
        }
        if (action.field === 'assignees' || before === 'assignees') next = { ...next, assigneeMatches: {} }
        return next
      })
    case 'setAppendToDescription':
      return updateDraft(state, action.sheet, (d) => ({
        ...d,
        columns: d.columns.map((c) => (c.column === action.column && c.field === 'free' ? { ...c, appendToDescription: action.value } : c)),
      }))
    case 'setHierarchy':
      return updateDraft(state, action.sheet, (d) => ({ ...d, hierarchy: action.hierarchy }))
    case 'setCompletedValue':
      return updateDraft(state, action.sheet, (d) => {
        const without = d.completedValues.filter((v) => v !== action.value)
        return { ...d, completedValues: action.completed ? [...without, action.value] : without }
      })
    case 'setAssigneeMatch':
      return updateDraft(state, action.sheet, (d) => ({ ...d, assigneeMatches: { ...d.assigneeMatches, [action.text]: action.personId } }))
    case 'setExistingTasks':
      return updateDraft(state, action.sheet, (d) => (d.mode === 'existing' ? { ...d, existingTasks: action.value } : d))
    case 'setMatchesReviewed':
      return { ...state, matchesReviewed: action.value }
    case 'setActiveSheet':
      return sheetsForStep(state, state.step).some((s) => s.planId === action.sheet) ? { ...state, activeSheet: action.sheet } : state
    case 'next': {
      if (stepErrors(state, state.step).length > 0) return state
      const step = neighbourStep(state, state.step, 1)
      return step ? withActiveSheet({ ...state, step, furthest: Math.max(state.furthest, STEPS.indexOf(step)) }) : state
    }
    case 'back': {
      const step = neighbourStep(state, state.step, -1)
      return step ? withActiveSheet({ ...state, step }) : state
    }
    case 'goTo': {
      // Back to any applicable step; forwards only to a step already reached, over steps that are still valid.
      if (!isStepApplicable(state, action.step)) return state
      const target = STEPS.indexOf(action.step)
      if (target > STEPS.indexOf(state.step) && (target > state.furthest || firstInvalidStepBefore(state, action.step) !== null)) return state
      return withActiveSheet({ ...state, step: action.step })
    }
  }
}

// ---------------------------------------------------------------------------
// The plan sent to POST /api/workbooks/:id/link(/preview)
// ---------------------------------------------------------------------------

function projectChoice(state: WizardState): ProjectChoice {
  const p = state.project
  if (p?.mode === 'existing' && p.projectId !== null) return { mode: 'existing', projectId: p.projectId }
  if (p?.mode === 'create') return { mode: 'create', name: state.workbookTitle }
  return { mode: 'none' }
}

function columnPlan(c: ColumnDraft): ColumnPlan {
  const plan: ColumnPlan = { columnKey: columnLetters(c.column), field: c.field }
  if (c.field === 'free') plan.appendToDescription = c.appendToDescription
  return plan
}

export function sheetPlan(sheet: WizardSheet, d: SheetDraft): SheetPlan {
  if (d.mode === 'local') {
    // A local sheet syncs nothing: only its header row is recorded.
    // OPEN: no column mapping is sent for it (OPEN_QUESTIONS.md #32).
    return { sheetId: sheet.planId, mode: 'local', headerRow: d.headerRow, columns: [], hierarchy: { mode: 'flat' }, existingTasks: 'create_all', assigneeMatches: {} }
  }
  const plan: SheetPlan = {
    sheetId: sheet.planId,
    mode: d.mode,
    headerRow: d.headerRow,
    columns: d.columns.map(columnPlan),
    hierarchy:
      d.hierarchy.mode === 'numbering' && d.hierarchy.column !== null
        ? { mode: 'numbering', columnKey: columnLetters(d.hierarchy.column) }
        : d.hierarchy.mode === 'indent'
          ? { mode: 'indent' }
          : { mode: 'flat' },
    existingTasks: d.mode === 'existing' ? d.existingTasks : 'create_all',
    assigneeMatches: columnOf(d.columns, 'assignees') === null ? {} : { ...d.assigneeMatches },
  }
  if (d.mode === 'existing' && d.todolistId !== null) plan.todolistId = d.todolistId
  if (columnOf(d.columns, 'completed') !== null) plan.completedValues = [...d.completedValues]
  return plan
}

export function buildLinkPlan(state: WizardState): LinkPlan {
  return {
    project: projectChoice(state),
    sheets: state.sheets.flatMap((s) => {
      const d = state.drafts[s.planId]
      return d ? [sheetPlan(s, d)] : []
    }),
  }
}

/** True when «بدء المزامنة» may be pressed: every step valid, and proposed matches reviewed when there are any. */
export function canStart(state: WizardState, proposedMatches: number): boolean {
  if (state.project === null || state.project.mode === 'none') return false
  if (firstInvalidStepBefore(state, 'preview') !== null) return false
  return proposedMatches === 0 || state.matchesReviewed
}
