// @naf-sheets/station-sheet — the pure bridge between a linked Google Sheets
// tab (fixed columns) and task rows (docs/station-plan.md §3, §4, §11).
//
// No IO. The API reads the tab with the Sheets API (values + row metadata),
// calls `readTab`, diffs `tasks` with @naf-sheets/sync-engine, and turns the
// engine's inbound actions into cell writes with `inboundEdits`.

export { cellText, latinDigits, readDate, serialToIso, isoToSerial, type CellValue, type DateRead } from './cells'
export { FIXED_HEADERS, findColumns, type ColumnsResult, type FixedColumn, type TabColumns } from './columns'
export { readRoles, assigneesForRole, splitNames, type AssigneeLookup, type PeopleMap, type RoleNames, type RolesIssue } from './people'
export { STATUS, isDone, statusAfterRemoteCompletion } from './status'
export {
  readTab,
  deletedTasks,
  type CellEdit,
  type ReadTabInput,
  type ReadTabResult,
  type RowIdentity,
  type TabIssue,
  type TabIssueCode,
  type TabRow,
} from './read'
export { inboundEdits, type InboundEditsResult, type TabAlert } from './inbound'
export {
  ALERT_SENDER,
  BATCH_WINDOW_MS,
  alertKey,
  composeAlertEmail,
  dueForEmail,
  resendRequest,
  type AlertEmail,
  type AlertRecord,
  type ComposeOptions,
  type StationAlert,
} from './alert-email'
