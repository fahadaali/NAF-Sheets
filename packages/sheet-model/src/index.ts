// @naf-sheets/sheet-model — the pure bridge between a Univer workbook snapshot
// (`IWorkbookData`) and task rows (spec §6.1, §8, §9.3).
//
// No IO, no clock, no randomness: uids come from the caller's `uidFactory`,
// style values (deleted rows, unsynced cells, indentation) from the caller's
// theme. Nothing here imports Univer at runtime.
//
// Contract for the API:
// 0. Ids: every `sheetId` parameter, `CellRef.sheetId` and `SheetIssue.sheetId`
//    is the Univer sheet id (`SheetMeta.univerSheetId`, the key in
//    `workbook.sheets`); `SheetPlan.sheetId` and `LocalTask.sheetId` are the
//    platform's (`SheetMeta.id`, D1 `sheets.id`).
// 1. Link a sheet: `ensureSystemColumns` once (pass the wizard's hierarchy
//    detection as `levels` when the plan is not flat), store the returned sheet,
//    then `decorateTaskRows` when the theme values are at hand.
// 2. Outbound: `readTasks`. Every row with an issue is held back (not diffed or
//    sent) until its issue is resolved; `tasks` lists only rows with a sound
//    identity. Pass D1's row state (`rowState`) for bcId, assign mode,
//    timestamps, attachments and stored assignees.
// 3. Inbound: `applyInbound` with the engine's actions for one sheet; store the
//    returned workbook. A `refused` outcome left the workbook as it was for
//    that action: keep the record pending and retry after reconciliation.
//    `createdSheets` must be stored (D1 `sheets` + column mappings).
// 4. Tab / Shift+Tab from the editor: `indentTaskRow` / `outdentTaskRow`.

export { UNIVER_VERSION } from './univer'
export { columnIndex, columnLetters } from './a1'
export type { WorkbookSnapshot, SheetSnapshot } from './cells'
export {
  ERROR_MESSAGES,
  ISSUE_MESSAGES,
  type Result,
  type SheetError,
  type SheetErrorCode,
  type SheetIssue,
  type SheetIssueCode,
} from './errors'
export { serialToIso, isoToSerial, readDateValue, latinDigits, ISO_DATE_PATTERN, type DateRead } from './dates'
export { offsetFormula } from './formula-refs'
export {
  SYSTEM_HEADERS,
  ensureSystemColumns,
  findSystemColumns,
  type EnsureSystemColumnsOptions,
  type EnsuredSystemColumns,
  type InitialLevel,
  type SystemColumns,
} from './system-columns'
export { normalizeName, splitAssigneeText, type AssigneeDirectory } from './fields'
export { readTasks, imageOnlyFields, type ImageOnlyField, type ReadTasksOptions, type ReadTasksResult, type RowState } from './read'
export { cellImages, hasCellImages, IMAGE_PLACEHOLDER, type CellImage } from './cell-images'
export { cellText } from './cells'
export { UNSYNCED_NOTE, UNSYNCED_SUBTASK_FIELDS, type DecorationOptions } from './decorate'
export {
  applyInbound,
  UNCLASSIFIED_SHEET_NAME,
  type ActionOutcome,
  type ActionStatus,
  type ApplyInboundOptions,
  type ApplyInboundResult,
} from './inbound'
export { indentTaskRow, outdentTaskRow, decorateTaskRows, type SheetEditResult } from './hierarchy'
export type { CellRef } from './changes'
export { toTemplateWorkbook, instantiateTemplate, type TemplateOptions, type TemplateResult } from './template'
