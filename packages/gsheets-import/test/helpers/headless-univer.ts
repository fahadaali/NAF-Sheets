// A headless Univer 1.4.0 (no UI, no DOM) with the plugins whose resources the
// converter writes. Used only by tests: it proves that a converted snapshot
// loads into the real engine, that formulas compute, and that every resource
// is accepted as written.

import { IResourceManagerService, LocaleType, Univer, UniverInstanceType, type IWorkbookData, type Workbook } from '@univerjs/core'
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula'
import { UniverSheetsPlugin } from '@univerjs/sheets'
import { UniverSheetsConditionalFormattingPlugin } from '@univerjs/sheets-conditional-formatting'
import { UniverSheetsDataValidationPlugin } from '@univerjs/sheets-data-validation'
import { UniverSheetsFilterPlugin } from '@univerjs/sheets-filter'
import { CalculationMode, UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula'
import { UniverSheetsHyperLinkPlugin } from '@univerjs/sheets-hyper-link'
import { UniverSheetsNotePlugin } from '@univerjs/sheets-note'
import { UniverSheetsNumfmtPlugin } from '@univerjs/sheets-numfmt'

export interface HeadlessUniver {
  univer: Univer
  workbook: Workbook
  get<T>(token: unknown): T
  resources(): Record<string, unknown>
  dispose(): void
}

export function loadHeadless(data: IWorkbookData, mode: 'forced' | 'when_empty' = 'forced'): HeadlessUniver {
  const univer = new Univer({ locale: LocaleType.EN_US, locales: { [LocaleType.EN_US]: {} } })
  univer.registerPlugin(UniverFormulaEnginePlugin)
  univer.registerPlugin(UniverSheetsPlugin)
  univer.registerPlugin(UniverSheetsFormulaPlugin, {
    initialFormulaComputing: mode === 'forced' ? CalculationMode.FORCED : CalculationMode.WHEN_EMPTY,
  })
  // The web app's sheets-core preset includes number formats; date validation reads the formatted text.
  univer.registerPlugin(UniverSheetsNumfmtPlugin)
  univer.registerPlugin(UniverSheetsConditionalFormattingPlugin)
  univer.registerPlugin(UniverSheetsDataValidationPlugin)
  univer.registerPlugin(UniverSheetsFilterPlugin)
  univer.registerPlugin(UniverSheetsNotePlugin)
  univer.registerPlugin(UniverSheetsHyperLinkPlugin)
  // Univer may mutate what it loads; give it a copy so tests can compare.
  const workbook = univer.createUnit<IWorkbookData, Workbook>(UniverInstanceType.UNIVER_SHEET, structuredClone(data))
  const injector = univer.__getInjector()
  return {
    univer,
    workbook,
    get: <T,>(token: unknown) => injector.get(token as never) as T,
    resources: () => {
      const rm = injector.get(IResourceManagerService)
      const out: Record<string, unknown> = {}
      for (const r of rm.getResourcesByType(workbook.getUnitId(), UniverInstanceType.UNIVER_SHEET)) {
        out[r.name] = r.data ? JSON.parse(r.data) : null
      }
      return out
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
