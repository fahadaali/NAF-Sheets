// The dashboard tab «اللوحة» inside Univer 1.4.0 (@naf-sheets/shared
// dashboard-sheet.ts): a real worksheet, first in Univer's own sheet bar, so it
// looks and behaves like every other tab.
//
// Univer's sheets-ui has an extension point for tabs that are not a grid (the
// "embed tab anchor", src/embed-tab-anchor.ts and SheetContainer.tsx): a
// worksheet whose `custom.UNIVER_EMBED_SHEETS_TAB` holds `{ version: 1,
// embedId, hostAnchorId }` is shown with an empty host element over its grid
// (`[data-embed-sheets-sheet-tab-host]`, absolute, inset 0), no cell editor,
// and no statistics or zoom in the footer. When such a tab becomes active,
// Univer asks the `ISheetEmbedRuntimeService` (an exported DI identifier with
// no implementation in the open-source packages) to mount it, and disposes the
// mount when another tab is chosen. This module provides that service: it
// reports the host element, and the editor draws the dashboard over it.
//
// The dashboard is drawn outside Univer's DOM, positioned over the host
// (src/editor/EditorScreen.tsx): inside it, Univer's global shortcuts would
// take keys typed in the dashboard's own fields (ShortcutService checks only
// whether the event target is inside a Univer container).
//
// Contract: the custom key and the host attribute are checked against the
// installed sources by test/unit/dashboard-sheet.test.ts; a Univer
// bump that changes them fails there. At runtime, a host that does not appear
// is reported (`onHostMissing`) instead of guessed at.

import { CommandType } from '@univerjs/core'
import type { IDisposable, Injector, IPermissionService } from '@univerjs/core'
import { WorkbookDeleteSheetPermission, WorkbookHideSheetPermission, WorkbookMoveSheetPermission, WorkbookRenameSheetPermission } from '@univerjs/sheets'
import { ISheetEmbedRuntimeService } from '@univerjs/sheets-ui'
import type { ISheetEmbedTabMountParams } from '@univerjs/sheets-ui'
import type { FUniver } from '@univerjs/presets'
import { DASHBOARD_EMBED_ANCHOR } from '@naf-sheets/shared'
import { guardDashboardCommand, guardDashboardMutation } from './sheet-guard'
import type { DashboardGuardDecision } from './sheet-guard'

/** The host element Univer renders for the dashboard tab (sheets-ui `RenderSheetEmbedTabHost`). */
export const DASHBOARD_HOST_SELECTOR = `[data-embed-sheets-sheet-tab-host="${DASHBOARD_EMBED_ANCHOR.hostAnchorId}"]`

/** How long to wait for the host element after Univer asked to mount the tab. */
const HOST_WAIT_FRAMES = 30

/**
 * Provides Univer's embed-tab runtime for the dashboard tab. Call after
 * `createUniver` and before the workbook is created. `onHost` receives the
 * host element while the dashboard tab is shown, then null.
 */
export function provideDashboardTabHost(
  injector: Injector,
  container: HTMLElement,
  handlers: { onHost(element: HTMLElement | null): void; onHostMissing(): void },
): void {
  let current = 0
  const service = {
    mountSheetTab(params: ISheetEmbedTabMountParams): IDisposable | undefined {
      if (params.hostAnchorId !== DASHBOARD_EMBED_ANCHOR.hostAnchorId) return undefined
      const mount = ++current
      let frames = 0
      let frame = 0
      const find = () => {
        frame = 0
        if (mount !== current) return
        const element = container.querySelector<HTMLElement>(DASHBOARD_HOST_SELECTOR)
        if (element) return handlers.onHost(element)
        if (++frames >= HOST_WAIT_FRAMES) return handlers.onHostMissing()
        frame = requestAnimationFrame(find)
      }
      find()
      return {
        dispose: () => {
          if (frame) cancelAnimationFrame(frame)
          if (mount !== current) return
          current++
          handlers.onHost(null)
        },
      }
    },
    clearTab(): void {
      // Called whenever an ordinary sheet is shown; the mount's own dispose already ran.
    },
  }
  injector.add([ISheetEmbedRuntimeService, { useValue: service }])
}

type CommandEvent = { id: string; type?: number; params?: unknown; options?: Record<string, unknown>; cancel?: boolean }

export interface DashboardGuardOptions {
  unitId: string
  dashboardSheetId: string
  /** Univer's permission service (what `FWorkbook.setEditable` updates). */
  permissions: IPermissionService
  onRefused(message: string): void
}

/** The sheet-bar actions switched off while the dashboard tab is shown. */
const TAB_POINTS = [WorkbookRenameSheetPermission, WorkbookDeleteSheetPermission, WorkbookHideSheetPermission, WorkbookMoveSheetPermission] as const

/**
 * Refuses what would break the dashboard tab (src/dashboard/sheet-guard.ts),
 * through the public Facade event `BeforeCommandExecute`. Returns its disposer.
 */
export function installDashboardGuard(univerAPI: FUniver, options: DashboardGuardOptions): () => void {
  const { unitId, dashboardSheetId } = options
  // Commands this guard re-runs with corrected params pass once, untouched.
  const approved = new WeakSet<object>()
  let disposed = false

  const workbook = () => univerAPI.getWorkbook(unitId)
  const context = () => {
    const wb = workbook()
    const sheets = wb ? wb.getSheets() : []
    return {
      dashboardSheetId,
      activeSheetId: wb ? wb.getActiveSheet().getSheetId() : null,
      visibleContentSheetIds: sheets
        .filter((s) => s.getSheetId() !== dashboardSheetId && !s.isSheetHidden())
        .map((s) => s.getSheetId()),
    }
  }

  const apply = (event: CommandEvent, decision: DashboardGuardDecision) => {
    if (decision.kind === 'allow') return
    event.cancel = true
    if (decision.kind === 'refuse') {
      options.onRefused(decision.message)
      return
    }
    const params = decision.params
    approved.add(params)
    setTimeout(() => {
      if (!disposed) void univerAPI.executeCommand(event.id, params)
    }, 0)
  }

  // While the dashboard tab is shown, Univer's own sheet-bar actions on the shown tab
  // (rename by double-click or menu, delete, hide, drag) are switched off through
  // Univer's permission points, so they are greyed out instead of failing; the rules
  // below stay as the backstop (a tab can be acted on without being shown). Univer
  // sets the points itself once the workbook is loaded (SheetPermissionInitController,
  // asynchronously), so every update of these points is followed and corrected.
  const pointIds = TAB_POINTS.map((Point) => new Point(unitId).id)
  const allowedNow = () => {
    const wb = workbook()
    return !wb || wb.getActiveSheet().getSheetId() !== dashboardSheetId
  }
  const applyPoints = () => {
    if (disposed) return
    const allowed = allowedNow()
    TAB_POINTS.forEach((Point, i) => {
      const id = pointIds[i] as string
      if (!options.permissions.getPermissionPoint(id)) options.permissions.addPermissionPoint(new Point(unitId))
      if (options.permissions.getPermissionPoint(id)?.value !== allowed) options.permissions.updatePermissionPoint(id, allowed)
    })
  }
  applyPoints()
  const pointSubscription = options.permissions.permissionPointUpdate$.subscribe((point) => {
    if (!disposed && pointIds.includes(point.id) && point.value !== allowedNow()) queueMicrotask(applyPoints)
  })
  const activeSubscription = univerAPI.addEvent(univerAPI.Event.ActiveSheetChanged, (event) => {
    if (event.workbook.getId() === unitId) applyPoints()
  })

  const subscription = univerAPI.addEvent(univerAPI.Event.BeforeCommandExecute, (raw) => {
    const event = raw as unknown as CommandEvent
    if (disposed) return
    const opts = event.options ?? {}
    if (opts.fromCollab || opts.onlyLocal || opts.syncOnly) return
    const params = event.params as Record<string, unknown> | undefined
    if (params && approved.has(params)) return
    if (typeof params?.unitId === 'string' && params.unitId !== unitId) return
    if (event.type === CommandType.MUTATION) return apply(event, guardDashboardMutation(event.id, params, { dashboardSheetId }))
    apply(event, guardDashboardCommand(event.id, params, context()))
  })
  return () => {
    disposed = true
    subscription.dispose()
    activeSubscription.dispose()
    pointSubscription.unsubscribe()
  }
}
