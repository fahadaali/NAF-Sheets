// The editor's behaviour on synced sheets (spec §5.2, §8, §9), on top of a
// mounted Univer workbook. Everything goes through the public Facade
// (events, commands, sheet extensions); decisions are the pure functions in
// src/sync/, which are unit-tested.
//
// Commands are intercepted with `BeforeCommandExecute`. A refused command is
// cancelled and its Arabic reason reported; a command that must run
// differently is cancelled and run again with a COPY of its params (shortcut
// params are shared between key presses and are never changed, CLAUDE.md).
// The editor's own writes to the system columns run synchronously inside
// `bypass`, so the guard lets them through.

import { CommandType, RedoCommandId, UndoCommandId } from '@univerjs/core'
import type { IRange } from '@univerjs/core'
import type { FUniver } from '@univerjs/presets'
import type { ConflictRecord, SheetMeta, TaskUid, WorkbookSyncResponse } from '@naf-sheets/shared'
import type { WorkbookSnapshot } from '@naf-sheets/sheet-model'
import { t } from '../strings'
import { cellText, type CellReader } from '../sync/cells'
import { conflictCells, conflictFieldLabel } from '../sync/conflicts'
import { guardCommand, guardMutation, type GuardContext, type GuardDecision } from '../sync/guard'
import { planHierarchyEdit, writesAsMatrix } from '../sync/hierarchy-edit'
import { needsIdentity, randomUid, titleWriteWithIdentity } from '../sync/identity'
import { sheetLayout, systemColumnSet, type SheetLayout } from '../sync/layout'
import { familyRows, newRowIdentity, planRemoval, planRowMove, progressByTodo, readTaskRows, systemCells, type RemovalPlan, type TaskRow } from '../sync/rows'
import { rowIndicators, type RowIndicator } from '../sync/sync-state'
import type { FWorkbook, FWorksheet } from './univer-host'
import { CellMarksExtension, loadStateIcons, RowStateExtension, type GridTheme, type MarksBySheet, type SheetMarks } from './sync-render'

const KEY_TAB = 9
const DIRECTION_LEFT = 3
const RANGE_ROW = 1
const ALERT_INFO = 0
const ALERT_WARNING = 1

/** Commands this layer looks at; every other command passes untouched. */
const COMMANDS = new Set([
  'sheet.command.set-range-values',
  'sheet.command.clear-selection-content',
  'sheet.command.clear-selection-all',
  'sheet.command.clear-selection-format',
  'sheet.command.auto-fill',
  'sheet.command.paste-by-short-key',
  'sheet.command.delete-range-move-left',
  'sheet.command.insert-range-move-right',
  'sheet.command.delete-range-move-up',
  'sheet.command.insert-range-move-down',
  'sheet.command.insert-col',
  'sheet.command.insert-col-by-range',
  'sheet.command.remove-col',
  'sheet.command.remove-col-by-range',
  'sheet.command.move-cols',
  'sheet.command.move-range',
  'sheet.command.set-col-visible-on-cols',
  'sheet.command.set-selected-cols-visible',
  'sheet.command.sort-range',
  'sheet.command.copy-down',
  'sheet.command.copy-right',
  'sheet.command.refill',
  'sheet.command.auto-clear-content',
  'sheet.command.split-text-to-columns',
  'sheet.command.text-to-number',
  'sheet.command.paste',
  'sheet.command.optional-paste',
  'sheet.command.paste-value',
  'sheet.command.paste-format',
  'sheet.command.paste-besides-border',
  'sheet.command.paste-col-width',
  'sheet.command.move-selection-enter-tab',
  'sheet.command.move-rows',
  'sheet.command.remove-row',
  'sheet.command.remove-row-by-range',
])
const MUTATIONS = new Set([
  'sheet.mutation.set-range-values',
  'sheet.mutation.move-range',
  'sheet.mutation.remove-col',
  'sheet.mutation.insert-col',
  'sheet.mutation.move-columns',
  'sheet.mutation.set-col-visible',
])
/** Mutations after which the marks drawn in the grid are recomputed. */
const LAYOUT_MUTATIONS = new Set([
  ...MUTATIONS,
  'sheet.mutation.move-rows',
  'sheet.mutation.insert-row',
  'sheet.mutation.remove-rows',
  'sheet.mutation.reorder-range',
  'sheet.mutation.set-row-hidden',
  'sheet.mutation.set-row-visible',
])

export interface AssigneeTarget {
  sheetId: string
  row: number
  column: number
  uid: TaskUid | null
  level: 0 | 1 | null
  title: string
  text: string
  /** Level-0 row whose assignees are computed from its subtasks (§8.1). */
  auto: boolean
  /** The cell has a multiple-choice list (Univer's JSON list format). */
  multipleList: boolean
}

export interface RowHover {
  x: number
  y: number
  sheetId: string
  row: number
  title: string
  indicator: RowIndicator | null
  progress: { done: number; total: number } | null
}

export interface RemovalRequest {
  plan: RemovalPlan
  titles: ReadonlyMap<TaskUid, string>
  /** Rows already deleted in Basecamp: only their row leaves. */
  alreadyDeleted: ReadonlySet<TaskUid>
}

export interface ActiveTask {
  sheetId: string
  row: number
  column: number
  layout: SheetLayout
  task: TaskRow | null
  title: string
  progress: { done: number; total: number } | null
  /** Subtask rows of the task's to-do, and whether they are hidden now. */
  family: { rows: number[]; collapsed: boolean }
}

export interface SyncLayerOptions {
  metas: readonly SheetMeta[]
  theme: GridTheme
  /** The grid takes edits now (role, conflict lock, Basecamp link lock). */
  canWrite(): boolean
  onRefused(message: string): void
  confirmRemoval(request: RemovalRequest): Promise<boolean>
  onDeletionsConfirmed(uids: readonly TaskUid[]): void
  openAssignees(target: AssigneeTarget): void
  onRowHover(hover: RowHover | null): void
  /** The selection or the sheet's tasks changed: toolbar state is stale. */
  onActiveChange(): void
}

type Params = Record<string, unknown> | undefined
type CommandEvent = { id: string; type?: number; params?: unknown; options?: Record<string, unknown>; cancel?: boolean }

export class SyncLayer {
  private bypass = 0
  private removing = 0
  private readonly approved = new WeakSet<object>()
  private readonly disposers: Array<() => void> = []
  private info: WorkbookSyncResponse | null = null
  private conflicts: ConflictRecord[] = []
  private marks: MarksBySheet = new Map()
  private indicators = new Map<string, Map<number, RowIndicator>>()
  private icons: Awaited<ReturnType<typeof loadStateIcons>> | null = null
  private queue: Promise<void> = Promise.resolve()
  private pointer = { x: 0, y: 0 }
  private alert: { key: string; dispose: () => void } | null = null
  private recomputeTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private readonly unitId: string

  constructor(
    private readonly univerAPI: FUniver,
    private readonly workbook: FWorkbook,
    private readonly host: HTMLElement,
    private readonly options: SyncLayerOptions,
  ) {
    this.unitId = workbook.getId()
    this.install()
  }

  // -------------------------------------------------------------------------
  // Reading the live workbook
  // -------------------------------------------------------------------------

  private sheet(sheetId: string): FWorksheet | null {
    try {
      return this.workbook.getSheetBySheetId(sheetId) ?? null
    } catch {
      return null
    }
  }

  reader(sheetId: string): CellReader | null {
    const sheet = this.sheet(sheetId)?.getSheet()
    if (!sheet) return null
    return {
      cell: (row, column) => sheet.getCellRaw(row, column) ?? undefined,
      lastRow: () => sheet.getLastRowWithContent(),
      lastColumn: () => sheet.getLastColumnWithContent(),
    }
  }

  private meta(sheetId: string): SheetMeta | undefined {
    return this.options.metas.find((m) => m.univerSheetId === sheetId && m.syncMode === 'synced')
  }

  layout(sheetId: string): SheetLayout | null {
    const meta = this.meta(sheetId)
    const reader = meta ? this.reader(sheetId) : null
    return meta && reader ? sheetLayout(reader, meta) : null
  }

  rows(sheetId: string, layout = this.layout(sheetId)): TaskRow[] {
    const reader = this.reader(sheetId)
    return layout && reader ? readTaskRows(reader, layout) : []
  }

  private activeSheetId(): string | null {
    try {
      return this.workbook.getActiveSheet().getSheetId()
    } catch {
      return null
    }
  }

  private selections(sheetId: string): IRange[] {
    if (this.activeSheetId() !== sheetId) return []
    try {
      return this.workbook.getActiveSheet().getSelection()?.getActiveRangeList().map((r: { getRange(): IRange }) => r.getRange()) ?? []
    } catch {
      return []
    }
  }

  private currentCell(): { sheetId: string; row: number; column: number } | null {
    const sheetId = this.activeSheetId()
    if (sheetId === null) return null
    try {
      const cell = this.workbook.getActiveSheet().getSelection()?.getCurrentCell()
      if (!cell) return null
      return { sheetId, row: cell.actualRow, column: cell.actualColumn }
    } catch {
      return null
    }
  }

  // -------------------------------------------------------------------------
  // Running commands
  // -------------------------------------------------------------------------

  /** After the command being intercepted has been cancelled, in order. */
  private later(fn: () => void | Promise<void>): Promise<void> {
    this.queue = this.queue.then(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            if (this.disposed) return resolve()
            Promise.resolve()
              .then(fn)
              .catch((error: unknown) => console.error('[sync-layer]', error))
              .finally(resolve)
          }, 0)
        }),
    )
    return this.queue
  }

  /** The editor's own write: synchronous, past the guard. */
  private own<T>(fn: () => T): T {
    this.bypass += 1
    try {
      return fn()
    } finally {
      this.bypass -= 1
    }
  }

  private runApproved(id: string, params: Record<string, unknown>): Promise<boolean> {
    this.approved.add(params)
    return this.univerAPI.executeCommand(id, params)
  }

  // -------------------------------------------------------------------------
  // Installation
  // -------------------------------------------------------------------------

  private install(): void {
    const api = this.univerAPI
    const on = <T>(event: string, handler: (e: T) => void) => {
      const d = (api.addEvent as unknown as (e: string, h: (e: T) => void) => { dispose(): void })(event, handler)
      this.disposers.push(() => d.dispose())
    }
    on<CommandEvent>(api.Event.BeforeCommandExecute, (e) => this.beforeCommand(e))
    on<CommandEvent>(api.Event.CommandExecuted, (e) => this.afterCommand(e))
    const events = api.Event as unknown as Record<string, string>
    on<{ workbook: FWorkbook; worksheet: FWorksheet; row: number; column: number; cancel?: boolean }>(events.BeforeSheetEditStart as string, (e) => this.beforeEdit(e))
    on<{ workbook: FWorkbook; worksheet: FWorksheet; row: number }>(events.RowHeaderHover as string, (e) => this.rowHover(e))
    on<{ workbook: FWorkbook; worksheet: FWorksheet; row: number; column: number }>(events.CellHover as string, (e) => this.cellHover(e))
    on<unknown>(events.SelectionChanged as string, () => this.options.onActiveChange())
    on<unknown>(events.ActiveSheetChanged as string, () => {
      this.closeAlert()
      this.options.onRowHover(null)
      this.options.onActiveChange()
    })

    const onPointer = (e: PointerEvent) => {
      this.pointer = { x: e.clientX, y: e.clientY }
    }
    this.host.addEventListener('pointermove', onPointer, { capture: true })
    this.disposers.push(() => this.host.removeEventListener('pointermove', onPointer, { capture: true }))

    const extended = api as unknown as {
      registerSheetRowHeaderExtension?: (unitId: string, ...ext: unknown[]) => { dispose(): void }
      registerSheetMainExtension?: (unitId: string, ...ext: unknown[]) => { dispose(): void }
    }
    try {
      const header = extended.registerSheetRowHeaderExtension?.(this.unitId, new RowStateExtension(() => this.marks, () => this.icons, this.options.theme))
      const main = extended.registerSheetMainExtension?.(this.unitId, new CellMarksExtension(() => this.marks, this.options.theme, t.rowSync.states.deleted))
      if (header) this.disposers.push(() => header.dispose())
      if (main) this.disposers.push(() => main.dispose())
    } catch (error) {
      console.error('[sync-layer] could not register the grid extensions', error)
    }
    void loadStateIcons(this.options.theme).then((icons) => {
      if (this.disposed) return
      this.icons = icons
      this.refresh()
    })
    this.recompute()
  }

  dispose(): void {
    this.disposed = true
    this.closeAlert()
    if (this.recomputeTimer) clearTimeout(this.recomputeTimer)
    for (const d of this.disposers.reverse()) {
      try {
        d()
      } catch (error) {
        console.error('[sync-layer] dispose failed', error)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Interception
  // -------------------------------------------------------------------------

  private beforeCommand(event: CommandEvent): void {
    if (this.bypass > 0 || this.disposed) return
    const { id } = event
    const isMutation = event.type === CommandType.MUTATION
    if (isMutation ? !MUTATIONS.has(id) : !COMMANDS.has(id)) return
    const options = event.options ?? {}
    if (options.fromCollab || options.onlyLocal || options.syncOnly) return
    const params = event.params as Params
    if (params && this.approved.has(params)) return
    if (typeof params?.unitId === 'string' && params.unitId !== this.unitId) return
    const sheetId = typeof params?.subUnitId === 'string' ? params.subUnitId : this.activeSheetId()
    if (sheetId === null) return
    const layout = this.layout(sheetId)
    if (!layout?.system) return
    // A reader's edits are refused by Univer itself; nothing of this layer runs for them.
    if (!this.options.canWrite()) return
    const reader = this.reader(sheetId)
    if (!reader) return
    const ctx: GuardContext = { layout: layout as GuardContext['layout'], reader, selections: this.selections(sheetId) }

    if (isMutation) {
      const trigger = params?.trigger
      if (trigger === UndoCommandId || trigger === RedoCommandId) return
      this.apply(event, id, guardMutation(id, params, ctx))
      return
    }

    switch (id) {
      case 'sheet.command.move-selection-enter-tab':
        if (params?.keycode === KEY_TAB) this.tab(event, params, sheetId, layout, reader)
        return
      case 'sheet.command.move-rows':
        this.moveRows(event, params, sheetId, layout)
        return
      case 'sheet.command.remove-row':
      case 'sheet.command.remove-row-by-range':
        if (this.removing === 0) this.removeRows(event, params, sheetId, layout)
        return
      case 'sheet.command.set-range-values': {
        const decision = guardCommand(id, params, ctx)
        if (decision.kind !== 'allow') return this.apply(event, id, decision)
        const copy = titleWriteWithIdentity(params, layout, reader, this.rows(sheetId, layout), randomUid)
        if (!copy) return
        event.cancel = true
        void this.later(() => this.own(() => this.univerAPI.syncExecuteCommand(id, copy)))
        return
      }
      default:
        this.apply(event, id, guardCommand(id, params, ctx))
    }
  }

  private apply(event: CommandEvent, id: string, decision: GuardDecision): void {
    if (decision.kind === 'allow') return
    event.cancel = true
    if (decision.kind === 'refuse') {
      this.options.onRefused(decision.message)
      return
    }
    const params = decision.params
    void this.later(() => this.runApproved(id, params).then(() => undefined))
  }

  private afterCommand(event: CommandEvent): void {
    if (this.disposed) return
    if (event.type === CommandType.MUTATION && LAYOUT_MUTATIONS.has(event.id)) {
      const params = event.params as Params
      if (typeof params?.unitId === 'string' && params.unitId !== this.unitId) return
      this.scheduleRecompute()
      // Titles that arrived without a typed edit (paste, fill): give their rows an identity.
      const options = event.options ?? {}
      const trigger = params?.trigger
      if (event.id === 'sheet.mutation.set-range-values' && this.bypass === 0 && !options.fromCollab && !options.onlyLocal && trigger !== UndoCommandId && trigger !== RedoCommandId) {
        const sheetId = typeof params?.subUnitId === 'string' ? params.subUnitId : null
        if (sheetId) {
          const rows = Object.keys((params?.cellValue as Record<string, unknown>) ?? {}).map(Number)
          if (rows.length > 0) void this.later(() => this.assignIdentities(sheetId, rows))
        }
      }
    }
  }

  private assignIdentities(sheetId: string, candidates: number[]): void {
    if (!this.options.canWrite()) return
    const layout = this.layout(sheetId)
    const reader = this.reader(sheetId)
    if (!layout?.system || !reader) return
    const rows = this.rows(sheetId, layout)
    const value: Record<number, Record<number, unknown>> = {}
    for (const row of [...new Set(candidates)].sort((a, b) => a - b)) {
      if (!needsIdentity(reader, layout, row)) continue
      const identity = newRowIdentity(rows, row, randomUid())
      value[row] = systemCells(layout.system, identity)
      rows.push({ row, ...identity })
      rows.sort((a, b) => a.row - b.row)
    }
    if (Object.keys(value).length === 0) return
    this.own(() => this.univerAPI.syncExecuteCommand('sheet.command.set-range-values', { unitId: this.unitId, subUnitId: sheetId, value }))
  }

  // --- Tab / Shift+Tab -------------------------------------------------------

  private tab(event: CommandEvent, params: Params, sheetId: string, layout: SheetLayout, reader: CellReader): void {
    const cell = this.currentCell()
    if (!cell || cell.sheetId !== sheetId || cell.column !== layout.fields.title || cell.row <= layout.header) return
    const hasUid = layout.system ? cellText(reader.cell(cell.row, layout.system.uid)).trim() !== '' : false
    // OPEN: Tab indents only on a task row's title in a synced sheet; elsewhere it moves (OPEN_QUESTIONS.md #34).
    if (!hasUid && cellText(reader.cell(cell.row, layout.fields.title as number)).trim() === '') return
    event.cancel = true
    const op = params?.direction === DIRECTION_LEFT ? 'outdent' : 'indent'
    const original = { ...(params ?? {}) }
    void this.later(() => {
      const task = this.rows(sheetId).find((r) => r.row === cell.row)
      // The title was cleared meanwhile: Tab moves as usual.
      if (!task) return this.runApproved('sheet.command.move-selection-enter-tab', original).then(() => undefined)
      const message = this.hierarchy(sheetId, task.uid, op)
      if (message) this.options.onRefused(message)
    })
  }

  /** Indent or outdent the task `uid`; returns an Arabic refusal, or null. */
  private hierarchy(sheetId: string, uid: TaskUid, op: 'indent' | 'outdent'): string | null {
    const layout = this.layout(sheetId)
    if (!layout?.system || !layout.plan) return t.hierarchy.notReady
    const snapshot = this.workbook.save() as unknown as WorkbookSnapshot
    const edit = planHierarchyEdit(snapshot, layout, uid, op, { subtaskIndent: this.options.theme.subtaskIndent })
    if (!edit.ok) return edit.message || t.hierarchy.notReady
    if (edit.writes.length === 0) return null
    const sheet = this.sheet(sheetId)
    this.own(() => {
      this.univerAPI.syncExecuteCommand('sheet.command.set-range-values', { unitId: this.unitId, subUnitId: sheetId, value: writesAsMatrix(edit.writes) })
      for (const change of edit.notes) {
        const range = sheet?.getRange(change.row, change.column) as unknown as { deleteNote?: () => void; createOrUpdateNote?: (n: unknown) => void } | undefined
        if (change.note === null) range?.deleteNote?.()
        else range?.createOrUpdateNote?.(change.note)
      }
    })
    // Keep the selection on the task, wherever it went.
    const moved = this.rows(sheetId, layout).find((r) => r.uid === uid)
    if (moved && layout.fields.title !== undefined && this.activeSheetId() === sheetId) {
      try {
        sheet?.getRange(moved.row, layout.fields.title).activate()
      } catch {
        // selection is a convenience
      }
    }
    this.scheduleRecompute()
    return null
  }

  // --- Moving rows -------------------------------------------------------------

  private moveRows(event: CommandEvent, params: Params, sheetId: string, layout: SheetLayout): void {
    const from = params?.fromRange as IRange | undefined
    const to = params?.toRange as IRange | undefined
    if (!from || !to) return
    const given = params?.range as IRange | undefined
    const range = given ?? this.selections(sheetId).find((s) => s.rangeType === RANGE_ROW && s.startRow <= from.startRow && from.startRow <= s.endRow)
    if (!range) return
    const plan = planRowMove(this.rows(sheetId, layout), range.startRow, range.endRow, to.startRow)
    if (plan.kind === 'allow' || plan.kind === 'ignore') return
    event.cancel = true
    if (plan.kind === 'refuse') {
      this.options.onRefused(plan.message)
      return
    }
    const copy = { ...(params ?? {}), range: { ...range, startRow: plan.start, endRow: plan.end, rangeType: RANGE_ROW } }
    void this.later(() => this.runApproved('sheet.command.move-rows', copy).then(() => undefined))
  }

  // --- Removing rows (§9.2.7) --------------------------------------------------

  /** OPEN: subtasks go with their to-do, all uids are confirmed; one command per block (OPEN_QUESTIONS.md #43). */
  private removeRows(event: CommandEvent, params: Params, sheetId: string, layout: SheetLayout): void {
    const range = (params?.range as IRange | undefined) ?? this.selections(sheetId).at(-1)
    if (!range) return
    const rows = this.rows(sheetId, layout)
    const plan = planRemoval(rows, [{ start: range.startRow, end: range.endRow }])
    if (!plan) return
    event.cancel = true
    const reader = this.reader(sheetId)
    const titles = new Map<TaskUid, string>()
    const title = layout.fields.title
    for (const r of rows) if (title !== undefined && reader) titles.set(r.uid, cellText(reader.cell(r.row, title)).trim())
    const states = this.indicators.get(sheetId)
    const alreadyDeleted = new Set(rows.filter((r) => states?.get(r.row)?.state === 'deleted').map((r) => r.uid))
    void this.options.confirmRemoval({ plan, titles, alreadyDeleted }).then(async (confirmed) => {
      if (!confirmed || this.disposed) return
      this.options.onDeletionsConfirmed(plan.uids)
      this.removing += 1
      try {
        // Bottom first, so the spans above keep their rows.
        for (const span of [...plan.spans].reverse()) {
          await this.runApproved('sheet.command.remove-row', {
            unitId: this.unitId,
            subUnitId: sheetId,
            range: { startRow: span.start, endRow: span.end, startColumn: 0, endColumn: 0, rangeType: RANGE_ROW },
          })
        }
      } finally {
        this.removing -= 1
      }
    })
  }

  /** Starts the removal of one row (as the row header's «حذف الصف» would), with its dialog. */
  removeRow(sheetId: string, row: number): void {
    const sheet = this.sheet(sheetId)
    if (!sheet) return
    this.workbook.setActiveSheet(sheet)
    void this.univerAPI.executeCommand('sheet.command.remove-row', { unitId: this.unitId, subUnitId: sheetId, range: { startRow: row, endRow: row, startColumn: 0, endColumn: 0, rangeType: RANGE_ROW } })
  }

  // --- Assignee cell (§5.2, §8.2) ---------------------------------------------

  private beforeEdit(e: { workbook: FWorkbook; worksheet: FWorksheet; row: number; column: number; cancel?: boolean }): void {
    if (this.disposed || e.workbook.getId() !== this.unitId) return
    const sheetId = e.worksheet.getSheetId()
    const layout = this.layout(sheetId)
    if (!layout || layout.fields.assignees !== e.column || e.row <= layout.header) return
    if (!this.options.canWrite()) return
    e.cancel = true
    const target = this.assigneeTarget(sheetId, e.row)
    if (target) this.options.openAssignees(target)
  }

  assigneeTarget(sheetId: string, row: number): AssigneeTarget | null {
    const layout = this.layout(sheetId)
    const reader = this.reader(sheetId)
    const column = layout?.fields.assignees
    if (!layout || !reader || column === undefined) return null
    const task = this.rows(sheetId, layout).find((r) => r.row === row) ?? null
    const indicator = this.indicators.get(sheetId)?.get(row)
    let multipleList = false
    try {
      const rule = (this.sheet(sheetId)?.getRange(row, column) as unknown as { getDataValidation?: () => { getCriteriaType?: () => string } | null })?.getDataValidation?.()
      multipleList = rule?.getCriteriaType?.() === 'listMultiple'
    } catch {
      multipleList = false
    }
    return {
      sheetId,
      row,
      column,
      uid: task?.uid ?? null,
      level: task?.level ?? null,
      title: layout.fields.title !== undefined ? cellText(reader.cell(row, layout.fields.title)).trim() : '',
      text: cellText(reader.cell(row, column)),
      auto: task?.level === 0 && indicator?.assignMode === 'auto',
      multipleList,
    }
  }

  /** Writes the assignee cell of the task (found again by uid if rows moved meanwhile). */
  writeAssignees(target: AssigneeTarget, text: string): boolean {
    if (!this.options.canWrite()) return false
    let row = target.row
    if (target.uid) {
      const now = this.rows(target.sheetId).find((r) => r.uid === target.uid)
      if (!now) return false
      row = now.row
    }
    const value = text === '' ? { v: null, p: null } : { v: text, t: 1, p: null }
    return this.own(() =>
      Boolean(this.univerAPI.syncExecuteCommand('sheet.command.set-range-values', { unitId: this.unitId, subUnitId: target.sheetId, value: { [row]: { [target.column]: value } } })),
    )
  }

  // --- Active task, collapse, navigation ------------------------------------

  activeTask(): ActiveTask | null {
    const cell = this.currentCell()
    if (!cell) return null
    const layout = this.layout(cell.sheetId)
    const reader = this.reader(cell.sheetId)
    if (!layout || !reader) return null
    const rows = this.rows(cell.sheetId, layout)
    const task = rows.find((r) => r.row === cell.row) ?? null
    const head = task ? (task.level === 0 ? task.uid : task.parentUid) : null
    const subtasks = head ? familyRows(rows, head).slice(1).map((r) => r.row) : []
    const core = this.sheet(cell.sheetId)?.getSheet()
    const collapsed = subtasks.length > 0 && subtasks.every((r) => core?.getRowVisible(r) === false)
    const progress = head ? (this.progress(cell.sheetId, layout, rows).get(head) ?? null) : null
    return {
      sheetId: cell.sheetId,
      row: cell.row,
      column: cell.column,
      layout,
      task,
      title: layout.fields.title !== undefined ? cellText(reader.cell(cell.row, layout.fields.title)).trim() : '',
      progress,
      family: { rows: subtasks, collapsed },
    }
  }

  private progress(sheetId: string, layout: SheetLayout, rows: TaskRow[]) {
    const reader = this.reader(sheetId)
    const status = layout.fields.completed
    return progressByTodo(rows, (row) => {
      if (!reader || status === undefined) return false
      const text = cellText(reader.cell(row, status)).trim().toUpperCase()
      return text === 'TRUE' || text === '1'
    })
  }

  /** Tab / Shift+Tab from the toolbar, on the selected task. */
  indentActive(op: 'indent' | 'outdent'): Promise<void> {
    return this.later(() => {
      const active = this.activeTask()
      if (!active?.layout.system) return this.options.onRefused(t.hierarchy.notReady)
      if (!active.task) return this.options.onRefused(t.hierarchy.notTaskRow)
      const message = this.hierarchy(active.sheetId, active.task.uid, op)
      if (message) this.options.onRefused(message)
    })
  }

  /**
   * Hides or shows the subtask rows of the selected task's to-do (Univer OSS has no row groups).
   * OPEN: hidden rows are saved with the snapshot (OPEN_QUESTIONS.md #44).
   */
  toggleCollapse(): void {
    const active = this.activeTask()
    const sheet = active ? this.sheet(active.sheetId) : null
    if (!active || !sheet || active.family.rows.length === 0) return
    const first = active.family.rows[0] as number
    const count = active.family.rows.length
    if (active.family.collapsed) sheet.showRows(first, count)
    else sheet.hideRows(first, count)
    this.options.onActiveChange()
  }

  goTo(sheetId: string, row: number, column: number): void {
    const sheet = this.sheet(sheetId)
    if (!sheet) return
    try {
      this.workbook.setActiveSheet(sheet)
      const active = this.workbook.getActiveSheet()
      active.getRange(row, column).activate()
      active.scrollToCell(Math.max(0, row - 2), Math.max(0, column - 1))
    } catch (error) {
      console.error('[sync-layer] could not go to the cell', error)
    }
  }

  // -------------------------------------------------------------------------
  // Sync state, conflicts and what the grid draws
  // -------------------------------------------------------------------------

  setSyncInfo(info: WorkbookSyncResponse | null): void {
    this.info = info
    this.recompute()
  }

  setConflicts(conflicts: ConflictRecord[]): void {
    this.conflicts = conflicts
    this.recompute()
  }

  /** Row of a task by uid in its sheet, for the panel's «الانتقال إلى الصف». */
  locate(uid: TaskUid): { sheetId: string; row: number; layout: SheetLayout } | null {
    for (const meta of this.options.metas) {
      if (meta.syncMode !== 'synced') continue
      const layout = this.layout(meta.univerSheetId)
      const row = this.rows(meta.univerSheetId, layout).find((r) => r.uid === uid)
      if (layout && row) return { sheetId: meta.univerSheetId, row: row.row, layout }
    }
    return null
  }

  /** What the grid draws now, by sheet (also exposed to the e2e tests). */
  marksSnapshot(): Record<string, { states: Record<number, string>; unsyncedRows: number[]; unsyncedColumns: number[]; conflicts: string[]; deleted: number[] }> {
    const out: ReturnType<SyncLayer['marksSnapshot']> = {}
    for (const [sheetId, m] of this.marks) {
      out[sheetId] = {
        states: Object.fromEntries(m.states),
        unsyncedRows: [...m.unsynced.rows].sort((a, b) => a - b),
        unsyncedColumns: [...m.unsynced.columns],
        conflicts: [...m.conflicts].sort(),
        deleted: [...m.deleted.rows].sort((a, b) => a - b),
      }
    }
    return out
  }

  private scheduleRecompute(): void {
    if (this.recomputeTimer) return
    this.recomputeTimer = setTimeout(() => {
      this.recomputeTimer = null
      if (!this.disposed) this.recompute()
    }, 30)
  }

  private recompute(): void {
    const marks: MarksBySheet = new Map()
    const indicators = new Map<string, Map<number, RowIndicator>>()
    for (const meta of this.options.metas) {
      if (meta.syncMode !== 'synced') continue
      const layout = this.layout(meta.univerSheetId)
      if (!layout?.system) continue
      const rows = this.rows(meta.univerSheetId, layout)
      const byRow = rowIndicators(this.info, rows)
      indicators.set(meta.univerSheetId, byRow)
      const unsyncedColumns = (['starts_on', 'notes', 'attachments'] as const).map((f) => layout.fields[f]).filter((c): c is number => c !== undefined)
      const sheetMarks: SheetMarks = {
        states: new Map([...byRow].map(([row, ind]) => [row, ind.state])),
        unsynced: { rows: new Set(rows.filter((r) => r.level === 1).map((r) => r.row)), columns: unsyncedColumns },
        conflicts: new Set(conflictCells(this.conflicts, rows, layout).map((c) => `${c.row}:${c.column}`)),
        deleted: {
          rows: new Set([...byRow.values()].filter((i) => i.state === 'deleted').map((i) => i.row)),
          column: Math.max(...systemColumnSet(layout.system)) + 1,
        },
      }
      marks.set(meta.univerSheetId, sheetMarks)
    }
    this.marks = marks
    this.indicators = indicators
    this.host.dataset.syncMarks = JSON.stringify(this.marksSnapshot())
    this.refresh()
    this.options.onActiveChange()
  }

  private refresh(): void {
    try {
      this.workbook.getActiveSheet().refreshCanvas()
    } catch {
      // nothing drawn yet
    }
  }

  // --- Hover: row tooltip, cell alerts ----------------------------------------

  private rowHover(e: { workbook: FWorkbook; worksheet: FWorksheet; row: number }): void {
    if (e.workbook.getId() !== this.unitId) return
    this.closeAlert()
    const sheetId = e.worksheet.getSheetId()
    const indicator = this.indicators.get(sheetId)?.get(e.row) ?? null
    if (!indicator) {
      this.options.onRowHover(null)
      return
    }
    const layout = this.layout(sheetId)
    const reader = this.reader(sheetId)
    const rows = this.rows(sheetId, layout)
    const task = rows.find((r) => r.row === e.row)
    const progress = layout && task?.level === 0 ? (this.progress(sheetId, layout, rows).get(task.uid) ?? null) : null
    this.options.onRowHover({
      x: this.pointer.x,
      y: this.pointer.y,
      sheetId,
      row: e.row,
      title: layout?.fields.title !== undefined && reader ? cellText(reader.cell(e.row, layout.fields.title)).trim() : '',
      indicator,
      progress,
    })
  }

  private closeAlert(): void {
    this.alert?.dispose()
    this.alert = null
    delete this.host.dataset.cellAlert
  }

  private cellHover(e: { workbook: FWorkbook; worksheet: FWorksheet; row: number; column: number }): void {
    if (e.workbook.getId() !== this.unitId) return
    this.options.onRowHover(null)
    const sheetId = e.worksheet.getSheetId()
    const key = `${sheetId}:${e.row}:${e.column}`
    if (this.alert?.key === key) return
    this.closeAlert()
    const marks = this.marks.get(sheetId)
    if (!marks) return
    const range = e.worksheet.getRange(e.row, e.column) as unknown as {
      attachAlertPopup?: (alert: Record<string, unknown>) => { dispose(): void }
      getNote?: () => unknown
    }
    let alert: Record<string, unknown> | null = null
    if (marks.conflicts.has(`${e.row}:${e.column}`)) {
      const conflict = conflictCells(this.conflicts, this.rows(sheetId), this.layout(sheetId) as SheetLayout).find((c) => c.row === e.row && c.column === e.column)
      alert = {
        type: ALERT_WARNING,
        title: t.conflicts.alertTitle,
        message: t.conflicts.alertBody(conflict ? conflictFieldLabel(conflict.conflict.field) : ''),
        width: 280,
        height: 110,
        key: `naf-conflict-${key}`,
      }
    } else if (marks.unsynced.rows.has(e.row) && marks.unsynced.columns.includes(e.column)) {
      // The server's own note on the cell already says it (sheet-model UNSYNCED_NOTE).
      if (range.getNote?.()) return
      alert = { type: ALERT_INFO, title: t.unsynced.title, message: t.unsynced.tooltip, width: 220, height: 70, key: `naf-unsynced-${key}` }
    }
    if (!alert || !range.attachAlertPopup) return
    try {
      const disposable = range.attachAlertPopup(alert)
      this.alert = { key, dispose: () => disposable.dispose() }
      this.host.dataset.cellAlert = String(alert.key)
    } catch (error) {
      console.error('[sync-layer] could not show the cell alert', error)
    }
  }
}
