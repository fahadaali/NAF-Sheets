// Mounts Univer 1.4.0 for one workbook: the same presets as the phase 0 spike
// (spike/univer/src/main.ts) minus drawing and find-replace, which the spec's
// phase 1 does not ask for; locale ar-SA, UI direction rtl, Univer's own
// toolbar and formula bar. The grid is then mirrored by @naf-sheets/univer-rtl.
//
// This module and its CSS are only reached through the lazily loaded editor
// screen, so the files screen never downloads Univer (~2 MB gzip).

import { CalculationMode, UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import SheetsCoreArSA from '@univerjs/preset-sheets-core/locales/ar-SA'
import { UniverSheetsConditionalFormattingPreset } from '@univerjs/preset-sheets-conditional-formatting'
import SheetsCfArSA from '@univerjs/preset-sheets-conditional-formatting/locales/ar-SA'
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter'
import SheetsFilterArSA from '@univerjs/preset-sheets-filter/locales/ar-SA'
import { UniverSheetsSortPreset } from '@univerjs/preset-sheets-sort'
import SheetsSortArSA from '@univerjs/preset-sheets-sort/locales/ar-SA'
import { UniverSheetsDataValidationPreset } from '@univerjs/preset-sheets-data-validation'
import SheetsDvArSA from '@univerjs/preset-sheets-data-validation/locales/ar-SA'
import { UniverSheetsHyperLinkPreset } from '@univerjs/preset-sheets-hyper-link'
import SheetsLinkArSA from '@univerjs/preset-sheets-hyper-link/locales/ar-SA'
import { UniverSheetsNotePreset } from '@univerjs/preset-sheets-note'
import SheetsNoteArSA from '@univerjs/preset-sheets-note/locales/ar-SA'
import SheetsDrawingArSA from '@univerjs/preset-sheets-drawing/locales/ar-SA'
import { installImageGuard, nafDrawingPreset } from '../images/univer-images'
import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets'
import type { FUniver, IWorkbookData } from '@univerjs/presets'
import { CommandType, ICommandService, IPermissionService, IUndoRedoService } from '@univerjs/core'
import type { CollabCommandService } from '../collab/univer-adapter'
import { enableFormulaColours, enableRtlGrid } from '@naf-sheets/univer-rtl'
import { formulaPalette } from './formula-palette'
import { enableValidationPrompts } from './validation-prompt'
import type { EditorTarget } from '../lib/cell-target'
import { rangeToA1 } from '../lib/cell-target'
import { GRID_FONT, isPersistentChange } from './workbook-data'
import { installDashboardGuard, provideDashboardTabHost } from '../dashboard/sheet-tab'

import '@univerjs/preset-sheets-core/lib/index.css'
import '@univerjs/preset-sheets-conditional-formatting/lib/index.css'
import '@univerjs/preset-sheets-filter/lib/index.css'
import '@univerjs/preset-sheets-sort/lib/index.css'
import '@univerjs/preset-sheets-data-validation/lib/index.css'
import '@univerjs/preset-sheets-hyper-link/lib/index.css'
import '@univerjs/preset-sheets-note/lib/index.css'
import '@univerjs/preset-sheets-drawing/lib/index.css'

/** The Facade workbook and worksheet types, as `createWorkbook` returns them. */
export type FWorkbook = ReturnType<FUniver['createWorkbook']>
export type FWorksheet = ReturnType<FWorkbook['getActiveSheet']>

/** What the editor shows about the right-to-left grid layer. */
export interface RtlState {
  mirrored: boolean
  /** English, for an administrator; set when the layer is not applied or was withdrawn. */
  reason?: string
}

export interface MountedWorkbook {
  readonly unitId: string
  /** The public Facade of this workbook, for the synced-sheet layer (src/editor/sync-layer.ts). */
  readonly facade: { univerAPI: FUniver; workbook: FWorkbook }
  /** Univer's command and undo services, for the room adapter (src/collab/univer-adapter.ts). */
  readonly collab: { commands: CollabCommandService; clearUndo(): void }
  /** Current `IWorkbookData` (a copy). */
  snapshot(): unknown
  setEditable(editable: boolean): void
  /** Called after every change to the stored model (see `isPersistentChange`). */
  onChange(listener: () => void): void
  /** The Univer id of the sheet shown now. */
  activeSheetId(): string | null
  /** Called with the new sheet id whenever another sheet is shown. */
  onActiveSheetChange(listener: (sheetId: string) => void): void
  /**
   * Show `target`'s sheet, select its range and scroll it into view. Returns
   * the selection as `<sheet id>!<A1>` read back from the grid, or null when
   * the sheet is not in the workbook (or cannot be shown).
   */
  select(target: EditorTarget): string | null
  dispose(): void
}

export interface MountOptions {
  onRtlStatus(state: RtlState): void
  /** The platform's workbook id: where inserted pictures are uploaded (POST /api/workbooks/:id/images). */
  workbookId?: string
  /** A picture could not be inserted (type, size, rights, network): the Arabic reason. */
  onImageRefused?(message: string): void
  /** Polled between the asynchronous steps; when true, everything is torn down. */
  isCancelled(): boolean
  /** The sheet shown first, before the RTL layer starts (Univer would show the first tab). */
  initialSheetId?: string | null
  /**
   * The dashboard tab «اللوحة» (src/dashboard/sheet-tab.ts): its sheet id,
   * Univer's host element for it while it is shown, and what is refused on it.
   */
  dashboard?: {
    sheetId: string
    onHost(element: HTMLElement | null): void
    onHostMissing(): void
    onRefused(message: string): void
  } | null
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The canvas lays text out with the face it has when it first draws: wait for it, briefly. */
async function waitForFont(timeoutMs: number): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return
  await Promise.race([document.fonts.load(`16px "${GRID_FONT}"`, 'ثمانية').catch(() => undefined), sleep(timeoutMs)])
}

const RTL_TIMEOUT_MS = 10_000

export async function mountWorkbook(host: HTMLElement, data: Partial<IWorkbookData>, options: MountOptions): Promise<MountedWorkbook | null> {
  await waitForFont(3000)
  if (options.isCancelled()) return null

  const { univer, univerAPI } = createUniver({
    locale: LocaleType.AR_SA,
    direction: 'rtl',
    locales: {
      [LocaleType.AR_SA]: mergeLocales(SheetsCoreArSA, SheetsCfArSA, SheetsFilterArSA, SheetsSortArSA, SheetsDvArSA, SheetsLinkArSA, SheetsNoteArSA, SheetsDrawingArSA),
    },
    presets: [
      UniverSheetsCorePreset({
        container: host,
        header: true,
        toolbar: true,
        formulaBar: true,
        // Every formula is computed when the workbook opens, not only those
        // without a cached value: a server write (inbound sync, sheet-model
        // OPEN_QUESTIONS #16) leaves stale cached values in formulas that
        // depend on the cells it changed. The results are local-only
        // mutations, so opening still saves nothing (apps/web/OPEN_QUESTIONS.md #38).
        formula: { initialFormulaComputing: CalculationMode.FORCED },
      }),
      UniverSheetsConditionalFormattingPreset(),
      UniverSheetsFilterPreset(),
      UniverSheetsSortPreset(),
      UniverSheetsDataValidationPreset(),
      UniverSheetsHyperLinkPreset(),
      UniverSheetsNotePreset(),
      // Pictures over and in cells, uploaded to the platform (src/images/univer-images.ts).
      nafDrawingPreset({ workbookId: options.workbookId ?? String(data.id ?? ''), onRefused: (message) => options.onImageRefused?.(message) }),
    ],
  })

  // Before the workbook exists: Univer asks this service to mount the dashboard tab.
  if (options.dashboard) provideDashboardTabHost(univer.__getInjector(), host, options.dashboard)

  const cleanups: Array<() => void> = []
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup()
      } catch (error) {
        console.error('[editor] cleanup failed', error)
      }
    }
    univer.dispose()
  }

  try {
    const workbook = univerAPI.createWorkbook(data)
    const unitId = workbook.getId()
    cleanups.push(installImageGuard(univerAPI, (message) => options.onImageRefused?.(message)))
    // Formula colours while editing: Excel's reference colours and outlines,
    // plus the theme's calm colours for the other tokens (OPEN_QUESTIONS.md F1–F4).
    // A contract problem leaves Univer's own colouring and is logged by the layer.
    const palette = formulaPalette()
    if (palette) cleanups.push(enableFormulaColours(univerAPI, palette).dispose)
    else console.error('[editor] formula colours left stock: the --formula-* tokens of theme.css are missing')
    // The help text of a validation rule, which Univer stores but never shows (validation-prompt.ts).
    cleanups.push(enableValidationPrompts(univerAPI, univer.__getInjector(), unitId))
    if (options.dashboard) {
      cleanups.push(
        installDashboardGuard(univerAPI, {
          unitId,
          dashboardSheetId: options.dashboard.sheetId,
          permissions: univer.__getInjector().get(IPermissionService),
          onRefused: options.dashboard.onRefused,
        }),
      )
    }
    if (options.initialSheetId) {
      const first = workbook.getSheetBySheetId(options.initialSheetId)
      if (first && !first.isSheetHidden() && workbook.getActiveSheet().getSheetId() !== options.initialSheetId) workbook.setActiveSheet(first)
    }

    // Listen from the start, so no edit can slip through before the editor
    // reports ready. While loading, Univer runs no mutation on the workbook
    // unit itself (only on its cell-editor document, and local-only formula
    // mutations); its lazy row-height pass is filtered by `isPersistentChange`.
    // The app never writes to the model itself, so the "wait for Steady before
    // mutating" rule (CLAUDE.md) does not apply here; waiting would hide the
    // grid for Univer's fixed 3 s settle time.
    const listeners: Array<() => void> = []
    let changedEarly = false
    const subscription = univerAPI.addEvent(univerAPI.Event.CommandExecuted, (event) => {
      if (!isPersistentChange(event, unitId, CommandType.MUTATION)) return
      if (listeners.length === 0) changedEarly = true
      for (const listener of listeners) listener()
    })
    cleanups.push(() => subscription.dispose())

    // The layer never throws for a contract problem (it reports mirrored:false),
    // but it can time out waiting for the canvas; that is reported the same way.
    let rtlDispose: (() => void) | null = null
    cleanups.push(() => rtlDispose?.())
    let rtlReported = false
    const reportRtl = (state: RtlState) => {
      rtlReported = true
      if (!disposed) options.onRtlStatus(state)
    }
    // The layer's heartbeat withdraws the mirror unless text is drawn through
    // it within 3 s of enabling. A sheet that has already painted and then sits
    // idle draws nothing, so each time the mirror goes on, ask for one redraw
    // (public Facade API). `onStatus` runs after the heartbeat took its baseline.
    // OPEN: the layer could do this itself (OPEN_QUESTIONS.md #14).
    const redraw = () => {
      try {
        if (!disposed) workbook.getActiveSheet().refreshCanvas()
      } catch (error) {
        console.error('[editor] could not redraw the sheet after enabling the RTL grid', error)
      }
    }
    const rtl = enableRtlGrid(univerAPI, unitId, {
      onStatus: (status) => {
        rtlDispose = status.dispose
        if (status.mirrored) redraw()
        reportRtl({ mirrored: status.mirrored, reason: status.reason })
      },
    }).then(
      () => false,
      (error: unknown) => {
        reportRtl({ mirrored: false, reason: error instanceof Error ? error.message : String(error) })
        return false
      },
    )
    const timedOut = await Promise.race([rtl, sleep(RTL_TIMEOUT_MS).then(() => true)])
    // Still waiting: say so now; a later status from the layer replaces this one.
    if (timedOut && !rtlReported) reportRtl({ mirrored: false, reason: `the RTL grid layer did not report within ${RTL_TIMEOUT_MS} ms` })
    if (options.isCancelled()) {
      dispose()
      return null
    }

    const sheetListeners: Array<(sheetId: string) => void> = []
    const sheetSubscription = univerAPI.addEvent(univerAPI.Event.ActiveSheetChanged, (event) => {
      if (event.workbook.getId() !== unitId) return
      const sheetId = event.activeSheet.getSheetId()
      for (const listener of sheetListeners) listener(sheetId)
    })
    cleanups.push(() => sheetSubscription.dispose())

    const activeSheetId = (): string | null => {
      try {
        return workbook.getActiveSheet().getSheetId()
      } catch {
        return null
      }
    }

    const select = (target: EditorTarget): string | null => {
      if (disposed) return null
      try {
        const sheet = workbook.getSheetBySheetId(target.sheet)
        if (!sheet || sheet.isSheetHidden()) return null
        workbook.setActiveSheet(sheet)
        const active = workbook.getActiveSheet()
        if (target.range) {
          const { startRow, startColumn, endRow, endColumn } = target.range
          active.getRange(startRow, startColumn, endRow - startRow + 1, endColumn - startColumn + 1).activate()
          // Leave a little context above and before the target instead of pinning it to the corner.
          active.scrollToCell(Math.max(0, startRow - 2), Math.max(0, startColumn - 1))
        }
        const range = active.getActiveRange()
        return `${active.getSheetId()}!${range ? range.getA1Notation() : target.range ? rangeToA1(target.range) : ''}`
      } catch (error) {
        console.error('[editor] could not select the requested place', error)
        return null
      }
    }

    return {
      unitId,
      facade: { univerAPI, workbook },
      collab: {
        commands: univer.__getInjector().get(ICommandService) as unknown as CollabCommandService,
        clearUndo: () => {
          if (!disposed) univer.__getInjector().get(IUndoRedoService).clearUndoRedo(unitId)
        },
      },
      snapshot: () => workbook.save(),
      setEditable: (editable) => {
        if (!disposed) workbook.setEditable(editable)
      },
      onChange: (listener) => {
        listeners.push(listener)
        if (changedEarly) {
          changedEarly = false
          listener()
        }
      },
      activeSheetId,
      onActiveSheetChange: (listener) => {
        sheetListeners.push(listener)
      },
      select,
      dispose,
    }
  } catch (error) {
    dispose()
    throw error
  }
}
