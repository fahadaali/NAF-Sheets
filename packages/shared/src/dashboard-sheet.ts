// The dashboard sheet («اللوحة»): the workbook's dashboard is the first tab of
// Univer's own sheet bar, so it is a real Univer worksheet, kept first in
// `sheetOrder`. It holds no cells and no tasks; everything that reads a
// workbook's sheets skips it.
//
// It is recognised by platform data in the worksheet's `custom` field
// (`custom.nafSheetRole === 'dashboard'`), never by its name or id: a person's
// own sheet called «اللوحة» (or a Google sheet of that name) stays an ordinary
// sheet.
//
// The same `custom` field carries Univer's embed-tab anchor (sheets-ui 1.4.0,
// src/embed-tab-anchor.ts: `custom.UNIVER_EMBED_SHEETS_TAB`). With it, Univer
// itself replaces the grid of that tab with an empty host element, unmounts
// the cell editor and hides the footer's statistics and zoom while it is
// shown; the editor draws the dashboard over that host
// (apps/web/src/dashboard/sheet-tab.ts). The anchor is a rendering hint only:
// detection never reads it.
//
// The sheet is added to a workbook when it is opened (GET /api/workbooks/:id
// and the room, both through `withDashboardSheet`, which is deterministic so
// they produce the same model) and when one is created. D1 `sheets` never
// lists it.
//
// Pure: inputs are never mutated.

/** The tab's name (spec §12.2: Arabic interface). Model data, like «ورقة 1». */
export const DASHBOARD_SHEET_TITLE = 'اللوحة'

/** Preferred Univer sheet id; another is chosen only if a sheet already holds it. */
export const DASHBOARD_SHEET_ID = 'naf-dashboard'

/** Key in `IWorksheetData.custom` naming the platform role of a sheet. */
export const SHEET_ROLE_KEY = 'nafSheetRole'
export const DASHBOARD_SHEET_ROLE = 'dashboard'

/** sheets-ui 1.4.0 `EMBED_SHEETS_TAB_CUSTOM_KEY` (not exported by Univer; checked by apps/web/test/unit/dashboard-sheet.test.ts). */
export const UNIVER_EMBED_TAB_KEY = 'UNIVER_EMBED_SHEETS_TAB'

/** The embed-tab anchor: `version` 1 is the only one sheets-ui 1.4.0 accepts. */
export const DASHBOARD_EMBED_ANCHOR = { version: 1, embedId: 'naf-dashboard', hostAnchorId: 'naf-dashboard' } as const

/** Size of the (empty) dashboard grid; Univer draws it under the dashboard. */
const DASHBOARD_ROWS = 100
const DASHBOARD_COLUMNS = 26

type Obj = Record<string, unknown>
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The structural part of a Univer `IWorkbookData` this module reads. */
export interface SheetsHolder {
  sheets?: unknown
  sheetOrder?: unknown
}

/** True when a worksheet snapshot (`IWorksheetData`) is the dashboard sheet. */
export function isDashboardSheet(sheet: unknown): boolean {
  if (!isObject(sheet)) return false
  const custom = sheet.custom
  return isObject(custom) && custom[SHEET_ROLE_KEY] === DASHBOARD_SHEET_ROLE
}

function sheetsOf(workbook: SheetsHolder): Obj {
  return isObject(workbook.sheets) ? workbook.sheets : {}
}

/** Every sheet id in tab order: `sheetOrder` (existing sheets only), then any sheet it leaves out. */
export function allSheetIds(workbook: SheetsHolder): string[] {
  const sheets = sheetsOf(workbook)
  const ids = Object.keys(sheets)
  const listed = Array.isArray(workbook.sheetOrder)
    ? workbook.sheetOrder.filter((id, i, all): id is string => typeof id === 'string' && Object.prototype.hasOwnProperty.call(sheets, id) && all.indexOf(id) === i)
    : []
  return [...listed, ...ids.filter((id) => !listed.includes(id))]
}

/** Ids of the dashboard sheets, in tab order (normally zero or one). */
export function dashboardSheetIds(workbook: SheetsHolder): string[] {
  const sheets = sheetsOf(workbook)
  return allSheetIds(workbook).filter((id) => isDashboardSheet(sheets[id]))
}

/** The dashboard sheet's id, or null when the workbook has none. */
export function findDashboardSheetId(workbook: SheetsHolder): string | null {
  return dashboardSheetIds(workbook)[0] ?? null
}

/** True when `sheetId` names a dashboard sheet of `workbook`. */
export function isDashboardSheetId(workbook: SheetsHolder, sheetId: string): boolean {
  return isDashboardSheet(sheetsOf(workbook)[sheetId])
}

/** The sheets that hold content (every sheet but the dashboard), in tab order. */
export function contentSheetIds(workbook: SheetsHolder): string[] {
  const sheets = sheetsOf(workbook)
  return allSheetIds(workbook).filter((id) => !isDashboardSheet(sheets[id]))
}

/** The `custom` field of a dashboard sheet: the role, plus Univer's embed-tab anchor. */
export function dashboardSheetCustom(existing?: unknown): Obj {
  return {
    ...(isObject(existing) ? existing : {}),
    [SHEET_ROLE_KEY]: DASHBOARD_SHEET_ROLE,
    [UNIVER_EMBED_TAB_KEY]: { ...DASHBOARD_EMBED_ANCHOR },
  }
}

/** A new, empty dashboard worksheet (`Partial<IWorksheetData>`). */
export function newDashboardSheet(id: string): Obj {
  return {
    id,
    name: DASHBOARD_SHEET_TITLE,
    hidden: 0,
    rowCount: DASHBOARD_ROWS,
    columnCount: DASHBOARD_COLUMNS,
    // Stored for the model, like every sheet (apps/web workbook-data.ts).
    rightToLeft: 1,
    // The platform's face (spec §4.1; apps/api snapshot.ts GRID_FONT_FAMILY), so the
    // toolbar shows it on this tab too instead of Univer's Arial.
    defaultStyle: { ff: 'Thmanyah Sans' },
    cellData: {},
    custom: dashboardSheetCustom(),
  }
}

function freeId(sheets: Obj): string {
  if (!Object.prototype.hasOwnProperty.call(sheets, DASHBOARD_SHEET_ID)) return DASHBOARD_SHEET_ID
  for (let n = 2; ; n++) {
    const id = `${DASHBOARD_SHEET_ID}-${n}`
    if (!Object.prototype.hasOwnProperty.call(sheets, id)) return id
  }
}

function anchorIsCurrent(custom: unknown): boolean {
  if (!isObject(custom)) return false
  const anchor = custom[UNIVER_EMBED_TAB_KEY]
  return (
    isObject(anchor) &&
    anchor.version === DASHBOARD_EMBED_ANCHOR.version &&
    anchor.embedId === DASHBOARD_EMBED_ANCHOR.embedId &&
    anchor.hostAnchorId === DASHBOARD_EMBED_ANCHOR.hostAnchorId &&
    anchor.childType === undefined
  )
}

export interface EnsureDashboardResult<T> {
  workbook: T
  /** The dashboard sheet's id. */
  sheetId: string
  /** False when the workbook already had it, first, named and anchored. */
  changed: boolean
}

/**
 * The workbook with its dashboard sheet: added when missing, otherwise moved
 * first, shown, and given back its name and anchor if they were lost. A
 * workbook without a `sheets` object is returned as it is (sheetId '').
 *
 * Deterministic (no clock, no randomness): the API and the room apply it to
 * the same snapshot and must obtain the same model, since Univer's sheet
 * mutations address sheets by position.
 *
 * A second dashboard sheet (it cannot be made in the editor: copying the
 * dashboard is refused) is left where it is; it is skipped like the first.
 */
export function ensureDashboardSheet<T extends SheetsHolder>(workbook: T): EnsureDashboardResult<T> {
  if (!isObject(workbook) || !isObject(workbook.sheets)) return { workbook, sheetId: '', changed: false }
  const sheets = workbook.sheets
  const order = allSheetIds(workbook)
  const existing = order.find((id) => isDashboardSheet(sheets[id]))

  if (existing === undefined) {
    const id = freeId(sheets)
    return {
      workbook: { ...workbook, sheets: { [id]: newDashboardSheet(id), ...sheets }, sheetOrder: [id, ...order] },
      sheetId: id,
      changed: true,
    }
  }

  const sheet = sheets[existing] as Obj
  const fixed: Obj = { ...sheet }
  let sheetChanged = false
  if (fixed.name !== DASHBOARD_SHEET_TITLE) {
    fixed.name = DASHBOARD_SHEET_TITLE
    sheetChanged = true
  }
  if (fixed.hidden !== undefined && fixed.hidden !== 0) {
    fixed.hidden = 0
    sheetChanged = true
  }
  if (fixed.id !== existing) {
    fixed.id = existing
    sheetChanged = true
  }
  if (!anchorIsCurrent(fixed.custom)) {
    fixed.custom = dashboardSheetCustom(fixed.custom)
    sheetChanged = true
  }
  const orderOk = Array.isArray(workbook.sheetOrder) && workbook.sheetOrder.length === order.length && workbook.sheetOrder.every((id, i) => id === order[i]) && order[0] === existing
  if (!sheetChanged && orderOk) return { workbook, sheetId: existing, changed: false }
  return {
    workbook: {
      ...workbook,
      sheets: sheetChanged ? { ...sheets, [existing]: fixed } : sheets,
      sheetOrder: [existing, ...order.filter((id) => id !== existing)],
    },
    sheetId: existing,
    changed: true,
  }
}

/** `ensureDashboardSheet(workbook).workbook`. */
export function withDashboardSheet<T extends SheetsHolder>(workbook: T): T {
  return ensureDashboardSheet(workbook).workbook
}

/**
 * The workbook without its dashboard sheet(s): removed from `sheets`,
 * `sheetOrder` and from plugin resources keyed by its id. Used where a
 * workbook's content leaves the platform's own view of it (templates).
 */
export function withoutDashboardSheet<T extends SheetsHolder & { resources?: unknown }>(workbook: T): T {
  if (!isObject(workbook) || !isObject(workbook.sheets)) return workbook
  const ids = new Set(dashboardSheetIds(workbook))
  if (ids.size === 0) return workbook
  const sheets: Obj = {}
  for (const [id, sheet] of Object.entries(workbook.sheets)) if (!ids.has(id)) sheets[id] = sheet
  const out: T = { ...workbook, sheets }
  if (Array.isArray(workbook.sheetOrder)) out.sheetOrder = workbook.sheetOrder.filter((id) => !(typeof id === 'string' && ids.has(id)))
  if (Array.isArray(workbook.resources)) {
    out.resources = workbook.resources.map((entry: unknown) => {
      if (!isObject(entry) || typeof entry.data !== 'string' || entry.data === '') return entry
      let data: unknown
      try {
        data = JSON.parse(entry.data)
      } catch {
        return entry
      }
      if (!isObject(data) || ![...ids].some((id) => Object.prototype.hasOwnProperty.call(data, id))) return entry
      const kept: Obj = {}
      for (const [key, value] of Object.entries(data)) if (!ids.has(key)) kept[key] = value
      return { ...entry, data: JSON.stringify(kept) }
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Mutations (the room's backstop and the editor's)
// ---------------------------------------------------------------------------

/** The sheet a Univer mutation addresses: `subUnitId`, or `sheetId` for notes. */
function mutationSheet(params: Obj): string | null {
  if (typeof params.subUnitId === 'string') return params.subUnitId
  if (typeof params.sheetId === 'string') return params.sheetId
  return null
}

/** What a refused mutation would have done to the dashboard sheet. */
export type DashboardMutationProblem = 'remove' | 'move' | 'insert_before' | 'second_dashboard' | 'edit'

/**
 * Why a mutation would break the dashboard sheet, or null when it leaves it
 * as it is. Refused: removing, renaming, hiding or moving it, putting another
 * sheet before it, inserting a second dashboard, and anything that writes its
 * cells, its own properties or plugin data on it. Row heights and column
 * widths are let through: they change nothing anyone sees (the dashboard
 * covers the grid), and Univer computes some of them by itself.
 *
 * `classOf` is `roomMutationClass` (room-protocol.ts), passed in to keep this
 * module free of the room's table.
 */
export function dashboardMutationProblem(
  id: string,
  params: unknown,
  dashboardSheetId: string,
  classOf: (id: string) => string | null,
): DashboardMutationProblem | null {
  if (!isObject(params) || dashboardSheetId === '') return null
  switch (id) {
    case 'sheet.mutation.insert-sheet':
      if (isDashboardSheet(params.sheet)) return 'second_dashboard'
      return params.index === 0 ? 'insert_before' : null
    case 'sheet.mutation.remove-sheet':
      return params.subUnitId === dashboardSheetId ? 'remove' : null
    case 'sheet.mutation.set-worksheet-order':
      if (params.subUnitId === dashboardSheetId) return 'move'
      return params.toOrder === 0 ? 'insert_before' : null
    default:
      break
  }
  if (mutationSheet(params) !== dashboardSheetId) return null
  const kind = classOf(id)
  return kind === 'cells' || kind === 'sheet' || kind === 'resource' || kind === 'structural' ? 'edit' : null
}
