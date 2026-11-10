// Headless Univer 1.4.0 for the workbook room (spec §5.3 default (a), §11):
// the model only — core, sheets, the formula engine and the model half of
// every preset the editor loads (apps/web/src/editor/univer-host.ts) — with no
// render engine instance, no UI and no DOM. The room applies the editors'
// mutations to it, in order, and saves it as the workbook snapshot.
//
// Why the model plugins and not only core + sheets + formula: a plugin's
// resource (notes, data validation, conditional formats, filter, links) is
// saved only by a registered plugin. Without them, the room's first save
// would silently drop every note and validation rule of the workbook.
//
// The headless instance is a cache. The room's durable state is the last
// committed snapshot plus its own op log; this instance can always be rebuilt
// from them (see room/state.ts).

import {
  ICommandService,
  IResourceManagerService,
  LifecycleService,
  LifecycleStages,
  LocaleType,
  LogLevel,
  Univer,
  UniverInstanceType,
} from '@univerjs/core'
import type { IWorkbookData, Workbook } from '@univerjs/core'
import { UniverDataValidationPlugin } from '@univerjs/data-validation'
import { UniverDocsPlugin } from '@univerjs/docs'
import { GlobalComputingStatusService, UniverFormulaEnginePlugin } from '@univerjs/engine-formula'
import { UniverSheetsPlugin } from '@univerjs/sheets'
import { UniverSheetsConditionalFormattingPlugin } from '@univerjs/sheets-conditional-formatting'
import { UniverSheetsDataValidationPlugin } from '@univerjs/sheets-data-validation'
import { UniverSheetsFilterPlugin } from '@univerjs/sheets-filter'
import { UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula'
import { UniverSheetsHyperLinkPlugin } from '@univerjs/sheets-hyper-link'
import { UniverSheetsNotePlugin } from '@univerjs/sheets-note'
import { UniverSheetsNumfmtPlugin } from '@univerjs/sheets-numfmt'
import { UniverSheetsSortPlugin } from '@univerjs/sheets-sort'

/** The Univer release this module was verified against (CLAUDE.md §2: every @univerjs/* is pinned to it). */
export const ROOM_UNIVER_VERSION = '1.4.0'

/** CommandType.MUTATION in @univerjs/core 1.4.0. */
const MUTATION = 2

/** One Univer mutation as the editors send it: the command id and its JSON parameters. */
export interface WireMutation {
  id: string
  params: Record<string, unknown>
}

export interface HeadlessWorkbook {
  /** The Univer unit id: the snapshot's `id`. */
  readonly unitId: string
  /** True when `id` is a mutation registered in this instance. */
  isMutation(id: string): boolean
  /**
   * Applies the mutations in order, as a collaborator's (`fromCollab`).
   * Returns the index of the first mutation Univer refused or that threw,
   * or -1 when all applied. After a refusal the instance may be half-changed:
   * the caller must discard it and rebuild.
   */
  apply(mutations: readonly WireMutation[]): { failedAt: number; error?: unknown }
  /** Resolves once the formula engine is idle (or after `timeoutMs`). True when idle. */
  settle(timeoutMs?: number): Promise<boolean>
  /** The workbook as the browser saves it: `IWorkbookData` with plugin resources. */
  snapshot(): Record<string, unknown>
  dispose(): void
}

export type PluginSet = 'model' | 'minimal'

export interface LoadOptions {
  /**
   * 'model' (default): every model plugin the editor's presets load.
   * 'minimal': core, sheets and the formula engine only — for the spike's
   * size comparison; it drops plugin resources on save.
   */
  plugins?: PluginSet
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A Univer with the room's plugins registered and no unit yet. */
export function createModelUniver(plugins: PluginSet = 'model'): Univer {
  const univer = new Univer({ locale: LocaleType.EN_US, locales: { [LocaleType.EN_US]: {} }, logLevel: LogLevel.ERROR })
  univer.registerPlugin(UniverFormulaEnginePlugin)
  univer.registerPlugin(UniverSheetsPlugin)
  univer.registerPlugin(UniverSheetsFormulaPlugin)
  if (plugins === 'model') {
    univer.registerPlugin(UniverDocsPlugin)
    univer.registerPlugin(UniverSheetsNumfmtPlugin)
    univer.registerPlugin(UniverDataValidationPlugin)
    univer.registerPlugin(UniverSheetsDataValidationPlugin)
    univer.registerPlugin(UniverSheetsConditionalFormattingPlugin)
    univer.registerPlugin(UniverSheetsFilterPlugin)
    univer.registerPlugin(UniverSheetsSortPlugin)
    univer.registerPlugin(UniverSheetsHyperLinkPlugin)
    univer.registerPlugin(UniverSheetsNotePlugin)
  }
  return univer
}

/**
 * Without a render engine the lifecycle stops at Ready; controllers that
 * start at Rendered or Steady (the formula trigger outside Node among them)
 * would never run. Nothing is drawn, so move straight on.
 */
export function advanceHeadlessLifecycle(univer: Univer): void {
  const lifecycle = univer.__getInjector().get(LifecycleService)
  lifecycle.stage = LifecycleStages.Rendered
  lifecycle.stage = LifecycleStages.Steady
}

/**
 * Loads `data` into a new headless Univer. Univer may mutate what it loads,
 * so it is given a copy.
 */
export function loadHeadlessWorkbook(data: Record<string, unknown>, options: LoadOptions = {}): HeadlessWorkbook {
  const univer = createModelUniver(options.plugins ?? 'model')

  let workbook: Workbook
  try {
    workbook = univer.createUnit<IWorkbookData, Workbook>(UniverInstanceType.UNIVER_SHEET, structuredClone(data) as unknown as IWorkbookData)
  } catch (error) {
    univer.dispose()
    throw error
  }

  const injector = univer.__getInjector()
  const commands = injector.get(ICommandService)
  const resources = injector.get(IResourceManagerService)
  const computing = injector.get(GlobalComputingStatusService)
  advanceHeadlessLifecycle(univer)

  const unitId = workbook.getUnitId()
  let disposed = false

  return {
    unitId,
    isMutation: (id) => {
      if (!commands.hasCommand(id)) return false
      // Not in the public interface; CommandService keeps the type per id.
      const registry = (commands as unknown as { _commandRegistry?: { getCommandType(id: string): number | undefined } })._commandRegistry
      return registry?.getCommandType(id) === MUTATION
    },
    apply: (mutations) => {
      for (let i = 0; i < mutations.length; i++) {
        const m = mutations[i]!
        try {
          // Params are copied: Univer may keep or change what it is given.
          const ok = commands.syncExecuteCommand(m.id, structuredClone(m.params), { fromCollab: true })
          if (ok === false) return { failedAt: i }
        } catch (error) {
          return { failedAt: i, error }
        }
      }
      return { failedAt: -1 }
    },
    settle: async (timeoutMs = 5000) => {
      // The trigger debounces 10 ms before it starts a calculation.
      const start = Date.now()
      await sleep(25)
      while (!disposed) {
        if (computing.computingStatus) return true
        if (Date.now() - start > timeoutMs) return false
        await sleep(10)
      }
      return false
    },
    snapshot: () => ({
      ...(workbook.save() as unknown as Record<string, unknown>),
      resources: resources.getResources(unitId, UniverInstanceType.UNIVER_SHEET),
    }),
    dispose: () => {
      if (disposed) return
      disposed = true
      univer.dispose()
    },
  }
}
