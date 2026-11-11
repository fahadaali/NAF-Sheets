// What the editor refuses on the dashboard tab «اللوحة» (a real Univer sheet,
// first in the tab bar: @naf-sheets/shared dashboard-sheet.ts).
//
// Pure decisions over a command's id and params, the same shape as the synced
// sheet guard (src/sync/guard.ts). The editor runs them from Univer's public
// `BeforeCommandExecute` event (src/dashboard/sheet-tab.ts): a refused command
// is cancelled and its Arabic reason shown; a command that must run
// differently is cancelled and run again with a COPY of its params — the
// original params object is never changed (shortcut params are shared between
// key presses, CLAUDE.md).
//
// Commands: deleting, renaming, hiding, copying, protecting or moving the
// dashboard, putting a sheet before it, and the last-content-sheet rules Univer can no
// longer apply by itself (it counts the dashboard as a sheet). Writes into the
// dashboard's cells, properties or plugin data are caught at the mutation
// level (`guardDashboardMutation`), whatever command made them; row heights
// and column widths pass (nothing is visible, and Univer computes some itself).
// The room refuses the same mutations (apps/api/src/room/footprint.ts).

import { dashboardMutationProblem, isDashboardSheet, roomMutationClass } from '@naf-sheets/shared'
import type { DashboardMutationProblem } from '@naf-sheets/shared'
import { t } from '../strings'

export type DashboardGuardDecision =
  | { kind: 'allow' }
  | { kind: 'refuse'; message: string }
  /** Cancel, then run the same command with these params (a copy). */
  | { kind: 'replace'; params: Record<string, unknown> }

export interface DashboardGuardContext {
  /** The dashboard sheet's Univer id. */
  dashboardSheetId: string
  /** The sheet shown now (what a command without `subUnitId` acts on). */
  activeSheetId: string | null
  /** Content sheets (every sheet but the dashboard) that are not hidden. */
  visibleContentSheetIds: readonly string[]
}

type Params = Record<string, unknown> | undefined

const ALLOW: DashboardGuardDecision = { kind: 'allow' }
const refuse = (message: string): DashboardGuardDecision => ({ kind: 'refuse', message })
const ts = t.dashboard.sheet

/** The sheet a sheet command acts on: its `subUnitId`, else the active sheet (Univer's `getSheetCommandTarget`). */
function targetOf(params: Params, ctx: DashboardGuardContext): string | null {
  return typeof params?.subUnitId === 'string' ? params.subUnitId : ctx.activeSheetId
}

/** Decision for a command (CommandType.COMMAND or OPERATION) on this workbook. */
export function guardDashboardCommand(id: string, params: Params, ctx: DashboardGuardContext): DashboardGuardDecision {
  const target = targetOf(params, ctx)
  const onDashboard = target !== null && target === ctx.dashboardSheetId
  switch (id) {
    case 'sheet.command.remove-sheet':
    case 'sheet.command.remove-sheet-confirm':
      if (onDashboard) return refuse(ts.cannotDelete)
      // Univer keeps the last sheet; with the dashboard there it would let the last content sheet go.
      if (target !== null && ctx.visibleContentSheetIds.length <= 1 && ctx.visibleContentSheetIds.includes(target)) return refuse(ts.lastSheet)
      return ALLOW
    case 'sheet.command.set-worksheet-name':
    case 'sheet.operation.rename-sheet':
      return onDashboard ? refuse(ts.cannotRename) : ALLOW
    case 'sheet.command.set-worksheet-hidden':
      if (onDashboard) return refuse(ts.cannotHide)
      if (target !== null && ctx.visibleContentSheetIds.length <= 1 && ctx.visibleContentSheetIds.includes(target)) return refuse(ts.lastVisible)
      return ALLOW
    case 'sheet.command.copy-sheet':
      return onDashboard ? refuse(ts.cannotCopy) : ALLOW
    case 'sheet.command.set-tab-color':
      return onDashboard ? refuse(ts.readOnly) : ALLOW
    case 'sheet.command.set-worksheet-order':
      if (onDashboard) return refuse(ts.cannotMove)
      return params?.order === 0 ? refuse(ts.staysFirst) : ALLOW
    case 'sheet.command.insert-sheet':
      if (isDashboardSheet(params?.sheet)) return refuse(ts.cannotCopy)
      // A new sheet goes right after the dashboard instead of before it.
      return params?.index === 0 ? { kind: 'replace', params: { ...(params ?? {}), index: 1 } } : ALLOW
    default:
      // Worksheet and range protection on it (the sheet bar's «حماية ورقة العمل» and friends).
      if (onDashboard && id.includes('protection')) return refuse(ts.readOnly)
      // Pictures: refused before anything is uploaded (their mutations are refused too, as plugin data).
      if (onDashboard && (id === 'sheet.command.insert-float-image' || id === 'sheet.command.insert-cell-image')) return refuse(ts.readOnly)
      return ALLOW
  }
}

const MUTATION_MESSAGES: Record<DashboardMutationProblem, string> = {
  remove: ts.cannotDelete,
  move: ts.cannotMove,
  insert_before: ts.staysFirst,
  second_dashboard: ts.cannotCopy,
  edit: ts.readOnly,
}

/**
 * Backstop for mutations (CommandType.MUTATION) that reached the model without
 * a command rule refusing them: anything that would change the dashboard
 * sheet other than row heights and column widths. The caller skips
 * collaboration, local-only mutations and undo / redo.
 */
export function guardDashboardMutation(id: string, params: Params, ctx: Pick<DashboardGuardContext, 'dashboardSheetId'>): DashboardGuardDecision {
  const problem = dashboardMutationProblem(id, params, ctx.dashboardSheetId, roomMutationClass)
  return problem === null ? ALLOW : refuse(MUTATION_MESSAGES[problem])
}
