// Pure helpers between the API's workbook payload and Univer. No Univer
// runtime import here (types only), so they are unit-tested in Node.

import { DEFAULT_COLUMNS, withDashboardSheet } from '@naf-sheets/shared'
import type { SheetMeta, WorkbookResponse } from '@naf-sheets/shared'
import type { IWorkbookData } from '@univerjs/presets'

/** The grid's text face (spec §4.1). Loaded by the app shell. */
export const GRID_FONT = 'Thmanyah Sans'

type WorkbookData = Partial<IWorkbookData>

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * A blank workbook (spec §7.1): the dashboard tab «اللوحة» first
 * (@naf-sheets/shared dashboard-sheet.ts), then one sheet per `SheetMeta`, the
 * default columns in the header row, nothing else.
 *
 * OPEN: the contract does not say who builds a new workbook's first snapshot.
 * The editor uses this only when GET /api/workbooks/:id returns
 * `snapshot: null`; the first autosave then stores it with the returned
 * version as `baseVersion`, so a snapshot written meanwhile is never
 * overwritten (409). See apps/web/OPEN_QUESTIONS.md.
 */
export function blankWorkbookData(workbookId: string, title: string, sheets: readonly SheetMeta[]): WorkbookData {
  const ordered = [...sheets].sort((a, b) => a.position - b.position)
  const header = Object.fromEntries(DEFAULT_COLUMNS.map((value, column) => [column, { v: value }]))
  return withDashboardSheet({
    id: workbookId,
    name: title,
    appVersion: '1.4.0',
    styles: {},
    sheetOrder: ordered.map((s) => s.univerSheetId),
    sheets: Object.fromEntries(
      ordered.map((s) => [
        s.univerSheetId,
        {
          id: s.univerSheetId,
          name: s.title,
          // Stored for the model and for exports; the grid itself is mirrored
          // by @naf-sheets/univer-rtl, which does not read it.
          rightToLeft: 1,
          defaultStyle: { ff: GRID_FONT },
          // `headerRow` is 1-based (spec §6.2 sheets.header_row DEFAULT 1).
          cellData: { [Math.max(0, s.headerRow - 1)]: header },
        },
      ]),
    ),
  }) as WorkbookData
}

export type ResolvedWorkbook = { ok: true; data: WorkbookData; source: 'snapshot' | 'blank' } | { ok: false }

/**
 * The data to open: the stored snapshot when it looks like a Univer
 * `IWorkbookData`, a blank workbook when there is no snapshot yet, otherwise
 * nothing (the editor refuses to open rather than guess). Either way with the
 * dashboard tab «اللوحة» first: the API and the room already add it to a
 * workbook that predates it, with the same deterministic function, so this is
 * a no-op for what they send.
 */
export function resolveWorkbookData(response: Pick<WorkbookResponse, 'workbook' | 'sheets' | 'snapshot'>): ResolvedWorkbook {
  const { snapshot } = response
  if (snapshot === null || snapshot === undefined) {
    if (response.sheets.length === 0) return { ok: false }
    return { ok: true, source: 'blank', data: blankWorkbookData(response.workbook.id, response.workbook.title, response.sheets) }
  }
  if (!isObject(snapshot) || !isObject(snapshot.sheets) || Object.keys(snapshot.sheets).length === 0) return { ok: false }
  if (snapshot.sheetOrder !== undefined && !Array.isArray(snapshot.sheetOrder)) return { ok: false }
  const data = withDashboardSheet({ ...snapshot }) as WorkbookData
  if (typeof data.id !== 'string' || data.id === '') data.id = response.workbook.id
  return { ok: true, source: 'snapshot', data }
}

/** What Univer's `CommandExecuted` event carries (facade `ICommandEvent`). */
export interface CommandEventLike {
  id: string
  type?: number
  params?: unknown
  options?: { onlyLocal?: boolean; fromCollab?: boolean } | undefined
}

/**
 * Mutations Univer runs by itself to keep derived layout in step with the
 * content. They change no content: on their own they must not trigger a
 * save, or merely opening a workbook would write a new version (and two
 * people opening it would conflict). A save for a real change still carries
 * their result in the snapshot.
 */
export const DERIVED_MUTATIONS: ReadonlySet<string> = new Set([
  // Lazy automatic row height, computed in idle callbacks after load.
  'sheet.mutation.set-worksheet-row-auto-height',
])

/**
 * True when `event` changed the stored model of workbook `unitId`: a mutation
 * (CommandType.MUTATION, passed in as `mutationType`) on that unit, not
 * local-only, not from a collaborator and not derived layout.
 */
export function isPersistentChange(event: CommandEventLike, unitId: string, mutationType: number): boolean {
  if (event.type !== mutationType) return false
  if (event.options?.onlyLocal || event.options?.fromCollab) return false
  if (DERIVED_MUTATIONS.has(event.id)) return false
  return isObject(event.params) && event.params.unitId === unitId
}
