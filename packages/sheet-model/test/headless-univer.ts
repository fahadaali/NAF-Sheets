// A headless Univer 1.4.0 (no UI, no DOM) to load snapshots written by this
// package. Same approach as packages/gsheets-import/test/helpers/headless-univer.ts.
//
// Formulas are computed by the engine itself (`SetFormulaCalculationStartMutation`
// with `forceCalculation`), so cached values in the snapshot cannot make a check pass.

import { ICommandService, IResourceManagerService, LocaleType, Univer, UniverInstanceType, type IWorkbookData, type Workbook } from '@univerjs/core'
import { SetFormulaCalculationStartMutation, UniverFormulaEnginePlugin } from '@univerjs/engine-formula'
import { UniverSheetsPlugin } from '@univerjs/sheets'
import { UniverSheetsDataValidationPlugin } from '@univerjs/sheets-data-validation'
import { UniverSheetsNotePlugin } from '@univerjs/sheets-note'
import type { WorkbookSnapshot } from '../src'

export interface HeadlessUniver {
  workbook: Workbook
  get<T>(token: unknown): T
  resources(): Record<string, unknown>
  calculate(): Promise<void>
  dispose(): void
}

export function loadHeadless(data: WorkbookSnapshot): HeadlessUniver {
  const univer = new Univer({ locale: LocaleType.EN_US, locales: { [LocaleType.EN_US]: {} } })
  univer.registerPlugin(UniverFormulaEnginePlugin)
  univer.registerPlugin(UniverSheetsPlugin)
  univer.registerPlugin(UniverSheetsNotePlugin)
  univer.registerPlugin(UniverSheetsDataValidationPlugin)
  // Univer may mutate what it loads; give it a copy so tests can compare.
  const workbook = univer.createUnit<IWorkbookData, Workbook>(UniverInstanceType.UNIVER_SHEET, structuredClone(data) as IWorkbookData)
  const injector = univer.__getInjector()
  const get = <T,>(token: unknown): T => injector.get(token as never) as T
  return {
    workbook,
    get,
    resources: () => {
      const rm = get<IResourceManagerService>(IResourceManagerService)
      const out: Record<string, unknown> = {}
      for (const r of rm.getResourcesByType(workbook.getUnitId(), UniverInstanceType.UNIVER_SHEET)) out[r.name] = r.data ? JSON.parse(r.data) : null
      return out
    },
    calculate: async () => {
      await get<ICommandService>(ICommandService).executeCommand(SetFormulaCalculationStartMutation.id, { commands: [], forceCalculation: true }, { onlyLocal: true })
    },
    dispose: () => univer.dispose(),
  }
}

export async function waitFor<T>(read: () => T | undefined | null | false, timeoutMs = 8000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = read()
    if (value !== undefined && value !== null && value !== false) return value
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** Overwrites every cached formula value, so only the engine can make a check pass. */
export function poison(data: WorkbookSnapshot): WorkbookSnapshot {
  const out = structuredClone(data)
  for (const sheet of Object.values(out.sheets)) {
    for (const row of Object.values(sheet?.cellData ?? {})) {
      for (const cell of Object.values(row ?? {}) as Array<{ f?: string; si?: string; v?: unknown } | undefined>) if (cell?.f || cell?.si) cell.v = -1
    }
  }
  return out
}
