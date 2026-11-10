// The one place this package reaches into @naf-sheets/sync-engine.
//
// The hierarchy rules (Tab / Shift+Tab, one level of subtasks, positions among
// siblings) and the HTML helpers are the engine's; this package applies them to
// a snapshot and never re-implements them.
//
// NEEDED DEPENDENCY: `"@naf-sheets/sync-engine": "0.0.0"` in this package's
// `dependencies` (the import resolves today only through the npm-workspaces
// link). Not added here: the lockfile must be updated by `npm install` in the
// same change.

export {
  attachmentElementsOf,
  ERROR_MESSAGES as ENGINE_ERROR_MESSAGES,
  htmlToComparableText,
  escapeHtml,
  indentRow as engineIndentRow,
  isValidHierarchy,
  moveRow as engineMoveRow,
  outdentRow as engineOutdentRow,
  renumber,
  type EngineErrorCode,
  withoutAttachments,
} from '@naf-sheets/sync-engine'
