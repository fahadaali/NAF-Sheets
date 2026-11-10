// @naf-sheets/sync-engine — the pure sync logic of NAF Sheets (spec §9.1).
//
// Executor contract (apps/api):
// 1. Pass the Basecamp record when it is at hand (webhooks always fetch it,
//    §9.3.2). Without it a to-do update is built from the base, keeping its
//    completion subscribers (§9.2.4); prefer the record, which is fresher.
// 2. Apply `inbound`, then store `baseFromRemote(record)` for the fetched
//    record (also when `inbound` is empty). Then execute `outbound` in order;
//    after each write store `baseAfterTodoWrite` / `baseAfterSubtaskWrite`
//    (or `baseWith` after a 204 completion/position call). Save the Basecamp
//    id in the row (`LocalTask.bcId`, `tasks.bc_recording_id`) right after a
//    create succeeds (idempotency, §9.1).
// 3. Basecamp's single-record GET has no position (`position: null`). Give
//    the base builders the last known position (the previous base's; the
//    row's when there is no base or the record changed list), and place a
//    `move_row` with `position: null` at the end of its sheet; for a new row
//    pass `NewRowPlacement.position`.
// 4. `rewrite_managed_block` is the log record of a block edited in Basecamp
//    (`editedBlockHtml` for sync_log); the rewrite itself is the `update_todo`
//    in the same result. Do not issue a second write for it.
// 5. `update_row.fields.assignMode` is part of the row like any other field.
// 6. After any subtask change, diff its to-do again with fresh `ctx.autoAssign`.
// 7. Execute `reposition` actions for siblings in ascending position order.
// 8. Undo of a deletion: for each deletion action that was executed, run
//    `undoDeletion` and execute its action like any outbound action (item 2)
//    before the restored row is diffed again. `untrash_todo` →
//    `todos.untrash`; the row keeps its id and base. A re-created subtask's
//    row first drops its old `bcId` and base, then gets the new ones.

export * from './errors'
export * from './sha256'
export * from './html'
export * from './managed-block'
export * from './attachments'
export * from './hash'
export * from './assignees'
export * from './auto-assign'
export * from './diff'
export * from './deletion'
export * from './hierarchy'
