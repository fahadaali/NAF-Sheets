// The workbook dashboard («اللوحة») and the platform's appearance («المظهر»):
// the routes of packages/shared/src/api-dashboard.ts. The dashboard only reads
// a workbook (its latest committed snapshot); widgets live in D1
// (migrations/0007_dashboard.sql), the palette in KV settings.

import type { Hono } from 'hono'
import type { AppEnv } from '../auth'
import { appearanceRoutes, dashboardWorkbookRoutes } from './routes'
import type { DashboardRouteOptions } from './routes'

export { computeAutomatic, evaluateWidget, readValue, weekOf, linkFor, parseRange } from './compute'
export { parseWidgetConfig } from './widgets'

const REGISTERED = Symbol.for('naf-sheets.dashboard.registered')

/** Registered in src/index.ts after createApp, like the other modules. */
export function registerDashboardRoutes(app: Hono<AppEnv>, options: DashboardRouteOptions = {}): void {
  const marked = app as unknown as Record<symbol, boolean>
  if (marked[REGISTERED]) throw new Error('dashboard routes are already registered on this app')
  marked[REGISTERED] = true
  app.route('/api/workbooks', dashboardWorkbookRoutes(options))
  const appearance = appearanceRoutes()
  app.route('/api/appearance', appearance.read)
  app.route('/api/admin/appearance', appearance.admin)
}
