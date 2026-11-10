// Mounts Univer 1.4.0 for one workbook: the same presets as the phase 0 spike
// (spike/univer/src/main.ts) minus drawing and find-replace, which the spec's
// phase 1 does not ask for; locale ar-SA, UI direction rtl, Univer's own
// toolbar and formula bar. The grid is then mirrored by @naf-sheets/univer-rtl.
//
// This module and its CSS are only reached through the lazily loaded editor
// screen, so the files screen never downloads Univer (~2 MB gzip).

import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
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
import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets'
import type { IWorkbookData } from '@univerjs/presets'
import { CommandType } from '@univerjs/core'
import { enableRtlGrid } from '@naf-sheets/univer-rtl'
import { GRID_FONT, isPersistentChange } from './workbook-data'

import '@univerjs/preset-sheets-core/lib/index.css'
import '@univerjs/preset-sheets-conditional-formatting/lib/index.css'
import '@univerjs/preset-sheets-filter/lib/index.css'
import '@univerjs/preset-sheets-sort/lib/index.css'
import '@univerjs/preset-sheets-data-validation/lib/index.css'
import '@univerjs/preset-sheets-hyper-link/lib/index.css'
import '@univerjs/preset-sheets-note/lib/index.css'

/** What the editor shows about the right-to-left grid layer. */
export interface RtlState {
  mirrored: boolean
  /** English, for an administrator; set when the layer is not applied or was withdrawn. */
  reason?: string
}

export interface MountedWorkbook {
  readonly unitId: string
  /** Current `IWorkbookData` (a copy). */
  snapshot(): unknown
  setEditable(editable: boolean): void
  /** Called after every change to the stored model (see `isPersistentChange`). */
  onChange(listener: () => void): void
  dispose(): void
}

export interface MountOptions {
  onRtlStatus(state: RtlState): void
  /** Polled between the asynchronous steps; when true, everything is torn down. */
  isCancelled(): boolean
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
      [LocaleType.AR_SA]: mergeLocales(SheetsCoreArSA, SheetsCfArSA, SheetsFilterArSA, SheetsSortArSA, SheetsDvArSA, SheetsLinkArSA, SheetsNoteArSA),
    },
    presets: [
      UniverSheetsCorePreset({ container: host, header: true, toolbar: true, formulaBar: true }),
      UniverSheetsConditionalFormattingPreset(),
      UniverSheetsFilterPreset(),
      UniverSheetsSortPreset(),
      UniverSheetsDataValidationPreset(),
      UniverSheetsHyperLinkPreset(),
      UniverSheetsNotePreset(),
    ],
  })

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

    return {
      unitId,
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
      dispose,
    }
  } catch (error) {
    dispose()
    throw error
  }
}
