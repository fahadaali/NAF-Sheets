// Pure helpers of the dashboard («اللوحة»): links, numbers, the widget form,
// pie slices, ordering. No DOM, so every rule here is unit-tested.

import type { CellLink, DashboardAggregation, DashboardDisplay, DashboardSheet, DashboardWidget, DashboardWidgetConfig, WidgetGroup } from '@naf-sheets/shared'
import { WIDGET_TITLE_MAX_LENGTH } from '@naf-sheets/shared'
import { parseA1Range } from '../lib/cell-target'
import { pathFor } from '../lib/routes'
import { t } from '../strings'

/** The editor at a figure's cells (`?sheet=&range=`). */
export function cellsHref(workbookId: string, link: CellLink): string {
  return pathFor({ name: 'editor', id: workbookId, target: { sheet: link.sheetId, range: parseA1Range(link.range) } })
}

/** Latin digits, thousands grouped, at most two decimals: «1,250.5». */
export function formatNumber(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return t.dashboard.widgets.noValue
  return new Intl.NumberFormat('en-US', { numberingSystem: 'latn', maximumFractionDigits: 2 }).format(n)
}

/** Share 0..1 → «45%» (Latin digits); «—» without one. */
export function formatShare(share: number | null): string {
  if (share === null || !Number.isFinite(share)) return t.dashboard.widgets.noValue
  return `${Math.round(Math.min(1, Math.max(0, share)) * 100)}%`
}

/** A group's label as shown («(فارغ)» for rows whose group cell is empty). */
export function groupLabel(label: string): string {
  return label === '' ? t.dashboard.widgets.emptyGroup : label
}

export interface Slice {
  label: string
  value: number
  link: CellLink | null
  /** The «أخرى» slice gathers the smaller groups. */
  other: boolean
}

/**
 * Slices of a pie or donut: groups with a positive value, largest first. Past
 * `limit`, the rest become one «أخرى» slice when values add up (sum, count);
 * for average, min and max they are left out (adding them would mean nothing).
 */
export function pieSlices(groups: readonly WidgetGroup[], aggregation: DashboardAggregation, limit = 7): { slices: Slice[]; hidden: number } {
  const positive = groups.filter((g) => g.value !== null && g.value > 0).sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
  if (positive.length <= limit + 1) return { slices: positive.map((g) => ({ label: groupLabel(g.label), value: g.value ?? 0, link: g.link, other: false })), hidden: 0 }
  const head = positive.slice(0, limit).map((g) => ({ label: groupLabel(g.label), value: g.value ?? 0, link: g.link, other: false }))
  const rest = positive.slice(limit)
  if (aggregation === 'sum' || aggregation === 'count') {
    return { slices: [...head, { label: t.dashboard.widgets.others, value: rest.reduce((n, g) => n + (g.value ?? 0), 0), link: null, other: true }], hidden: 0 }
  }
  return { slices: head, hidden: rest.length }
}

/** The ids after moving the widget at `index` by `delta` (−1 earlier, +1 later); unchanged at the ends. */
export function moveWidget(ids: readonly string[], index: number, delta: -1 | 1): string[] {
  const target = index + delta
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) return [...ids]
  const out = [...ids]
  const [moved] = out.splice(index, 1)
  out.splice(target, 0, moved as string)
  return out
}

/** Arabic name of a sync_log action. */
export function activityLabel(action: string): string {
  return t.dashboard.activity.actions[action] ?? t.dashboard.activity.fallback
}

// ---------------------------------------------------------------------------
// The widget form
// ---------------------------------------------------------------------------

export interface WidgetDraft {
  title: string
  sheetId: string
  sourceKind: 'column' | 'range'
  column: string
  range: string
  aggregation: DashboardAggregation
  groupBy: string
  display: DashboardDisplay
}

export const GROUPED_DISPLAYS: readonly DashboardDisplay[] = ['bar', 'pie', 'donut', 'line']

const RANGE = /^[A-Z]{1,3}[1-9]\d{0,6}(:[A-Z]{1,3}[1-9]\d{0,6})?$/

export function draftFromWidget(widget: DashboardWidget): WidgetDraft {
  return {
    title: widget.title,
    sheetId: widget.sheetId,
    sourceKind: widget.source.kind,
    column: widget.source.kind === 'column' ? widget.source.column : '',
    range: widget.source.kind === 'range' ? widget.source.range : '',
    aggregation: widget.aggregation,
    groupBy: widget.groupBy ?? '',
    display: widget.display,
  }
}

/** A new widget: the first sheet, its second column (often the numbers), grouped by its first. */
export function newDraft(sheets: readonly DashboardSheet[]): WidgetDraft {
  const sheet = sheets[0]
  const columns = sheet?.columns ?? []
  return {
    title: '',
    sheetId: sheet?.sheetId ?? '',
    sourceKind: 'column',
    column: columns[1]?.key ?? columns[0]?.key ?? 'A',
    range: '',
    aggregation: 'count',
    groupBy: columns[0]?.key ?? '',
    display: 'bar',
  }
}

export type DraftProblem = 'title' | 'range' | 'group' | 'sheet'

/**
 * The configuration to send, and what stops it. `forPreview` ignores an empty
 * title (the preview does not need one).
 */
export function checkDraft(draft: WidgetDraft, options: { forPreview?: boolean } = {}): { config: DashboardWidgetConfig | null; problems: DraftProblem[] } {
  const problems: DraftProblem[] = []
  const title = draft.title.replace(/\s+/g, ' ').trim()
  if (!options.forPreview && (title === '' || [...title].length > WIDGET_TITLE_MAX_LENGTH)) problems.push('title')
  if (draft.sheetId === '') problems.push('sheet')
  const range = draft.range.trim().toUpperCase()
  if (draft.sourceKind === 'range' && !RANGE.test(range)) problems.push('range')
  const groupBy = draft.groupBy.trim().toUpperCase()
  if (groupBy === '' && GROUPED_DISPLAYS.includes(draft.display)) problems.push('group')
  if (problems.length > 0) return { config: null, problems }
  return {
    config: {
      title: title || t.dashboard.dialog.preview,
      sheetId: draft.sheetId,
      source: draft.sourceKind === 'column' ? { kind: 'column', column: draft.column.toUpperCase() } : { kind: 'range', range },
      aggregation: draft.aggregation,
      groupBy: groupBy === '' ? null : groupBy,
      display: draft.display,
    },
    problems,
  }
}
