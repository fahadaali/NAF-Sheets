// Custom widgets of a workbook's dashboard: validation and D1
// (migrations/0007_dashboard.sql). Nothing is deleted: a removed widget keeps
// its row with `removed_at`.

import type { DashboardAggregation, DashboardDisplay, DashboardWidget, DashboardWidgetConfig, WidgetSource } from '@naf-sheets/shared'
import { DASHBOARD_AGGREGATIONS, DASHBOARD_DISPLAYS, WIDGET_TITLE_MAX_LENGTH } from '@naf-sheets/shared'
import { isPlainObject } from '../request'
import { parseColumn, parseRange } from './compute'

const MAX_SHEET_ID_LENGTH = 128

/**
 * The configuration as stored, or null when any part is not valid. The sheet
 * is not checked against the snapshot here: a widget on a sheet removed
 * later shows its own message instead of failing the dashboard.
 */
export function parseWidgetConfig(body: unknown): DashboardWidgetConfig | null {
  if (!isPlainObject(body)) return null
  const { title, sheetId, source, aggregation, groupBy, display } = body
  if (typeof title !== 'string') return null
  const cleanTitle = title.replace(/\s+/g, ' ').trim()
  if (cleanTitle === '' || [...cleanTitle].length > WIDGET_TITLE_MAX_LENGTH) return null
  if (typeof sheetId !== 'string' || sheetId.trim() === '' || sheetId.length > MAX_SHEET_ID_LENGTH) return null
  if (typeof aggregation !== 'string' || !(DASHBOARD_AGGREGATIONS as readonly string[]).includes(aggregation)) return null
  if (typeof display !== 'string' || !(DASHBOARD_DISPLAYS as readonly string[]).includes(display)) return null

  let cleanSource: WidgetSource
  if (!isPlainObject(source)) return null
  if (source.kind === 'column' && typeof source.column === 'string' && parseColumn(source.column) !== null) {
    cleanSource = { kind: 'column', column: source.column.trim().toUpperCase() }
  } else if (source.kind === 'range' && typeof source.range === 'string' && parseRange(source.range) !== null) {
    cleanSource = { kind: 'range', range: source.range.trim().toUpperCase() }
  } else return null

  let cleanGroup: string | null = null
  if (groupBy !== null && groupBy !== undefined && groupBy !== '') {
    if (typeof groupBy !== 'string' || parseColumn(groupBy) === null) return null
    cleanGroup = groupBy.trim().toUpperCase()
  }
  // A grouped chart needs groups; a KPI shows one number.
  if (cleanGroup === null && display !== 'kpi' && display !== 'table') return null
  return {
    title: cleanTitle,
    sheetId,
    source: cleanSource,
    aggregation: aggregation as DashboardAggregation,
    groupBy: cleanGroup,
    display: display as DashboardDisplay,
  }
}

interface WidgetRow {
  id: string
  position: number
  config_json: string
  updated_at: string
}

function toWidget(row: WidgetRow): DashboardWidget | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(row.config_json)
  } catch {
    return null
  }
  const config = parseWidgetConfig(parsed)
  return config ? { id: row.id, position: row.position, updatedAt: row.updated_at, ...config } : null
}

/** Live widgets in order. A stored configuration that no longer validates is left out (and logged). */
export async function liveWidgets(db: D1Database, workbookId: string): Promise<DashboardWidget[]> {
  const { results } = await db
    .prepare(`SELECT id, position, config_json, updated_at FROM dashboard_widgets WHERE workbook_id = ?1 AND removed_at IS NULL ORDER BY position, created_at, id`)
    .bind(workbookId)
    .all<WidgetRow>()
  const out: DashboardWidget[] = []
  for (const row of results) {
    const widget = toWidget(row)
    if (widget) out.push(widget)
    else console.warn(`dashboard: widget ${row.id} has an unreadable configuration`)
  }
  // Positions as shown: 0..n-1, whatever gaps a removal left.
  return out.map((w, i) => ({ ...w, position: i }))
}

export async function widgetById(db: D1Database, workbookId: string, widgetId: string): Promise<DashboardWidget | null> {
  if (widgetId === '' || widgetId.length > 128) return null
  const row = await db
    .prepare(`SELECT id, position, config_json, updated_at FROM dashboard_widgets WHERE workbook_id = ?1 AND id = ?2 AND removed_at IS NULL`)
    .bind(workbookId, widgetId)
    .first<WidgetRow>()
  return row ? toWidget(row) : null
}
