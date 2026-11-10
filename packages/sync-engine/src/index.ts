// @naf-sheets/sync-engine — the pure sync logic of NAF Sheets (spec §9.1).
//
// Executor contract (apps/api):
// 1. Fetch the Basecamp record before diffing an update: a to-do update is a
//    full PUT and must preserve `completion_subscriber_ids` (§9.2.4).
// 2. Apply `inbound`, then store `baseFromRemote(record)` for the fetched
//    record (also when `inbound` is empty). Then execute `outbound` in order;
//    after each write store `baseAfterTodoWrite` / `baseAfterSubtaskWrite`
//    (or `baseWith` after a 204 completion/position call). Save the Basecamp
//    id right after a create succeeds and pass it as `ctx.bcId` until the
//    base exists (idempotency, §9.1).
// 3. `rewrite_managed_block` is the log record of a block edited in Basecamp;
//    the rewrite itself is the `update_todo` in the same result. Do not issue
//    a second write for it.
// 4. Apply `assignMode` from the result when it is not `null`.
// 5. After any subtask change, diff its to-do again with fresh `ctx.autoAssign`.
// 6. Execute `reposition` actions for siblings in ascending position order.

export * from './errors'
export * from './sha256'
export * from './html'
export * from './managed-block'
export * from './hash'
export * from './assignees'
export * from './auto-assign'
export * from './diff'
export * from './deletion'
export * from './hierarchy'
