# sync-engine — open questions

Places where `docs/spec.md` is silent, ambiguous or self-contradictory. Each
one is implemented with the narrowest safe behaviour and marked `// OPEN:` in
the code where it applies. Nothing here has been checked against a real
Basecamp account (the phase 0 live test is still blocked on inputs).

## Decisions needed

1. **Auto-derived externals in the parent's managed block (§8.1 vs §8.2).**
   §8.2 writes a to-do's external assignees into its managed block. §8.1's last
   bullet says externals from the subtasks are added to the parent "locally"
   (محلياً), followers "in Basecamp". Implemented literally: assignees with
   `source: 'auto'` are not written into the parent's block; followers from the
   union do go to `assignee_ids`. If externals should appear in the parent's
   block, it is a one-line filter change in `managedBlockContentForTask`.
   (`src/managed-block.ts`)

2. **A person empties a parent's assignees in Basecamp.** §8.1 says "assigning
   by hand from Basecamp → manual" and also "emptying the cell → auto and
   recompute". Implemented: a Basecamp change that differs from the union is a
   human edit → `manual`, even when it empties the list; nothing is written
   back. The alternative (→ `auto`, recompute, write the union back) would
   re-assign people a Basecamp user just removed. (`src/diff.ts`)

3. **Indent, outdent and re-parenting of rows that are already synced.**
   Basecamp has no documented way to turn a to-do into a subtask, a subtask into
   a to-do, or move a subtask to another to-do. The sheet operations are
   implemented (`src/hierarchy.ts`), but `diffTask` refuses to sync such a row
   (warning `hierarchy_change_unsupported`, no action). A real mapping would be
   "create the new record, then trash / permanently delete the old one" and
   needs the deletion confirmation of §9.2.7.

4. **Where an outdented middle subtask goes.** Implemented: right after its
   former to-do's remaining subtasks, so no other row changes parent. The
   outline-editor alternative (following siblings become its subtasks) silently
   re-parents other rows, which item 3 cannot sync. (`outdentRow`)

5. **Sorting with subtasks.** Implemented: to-dos are sorted, each keeps its
   subtasks directly under it, and the subtasks are sorted among themselves by
   the same column. (`sortRows`)

6. **Equal timestamps.** Last-writer-wins with `localChangedAt === updated_at`
   gives the field to Basecamp. A missing or unreadable local timestamp also
   loses. Note that both timestamps are per record/row, not per field: a field
   changed earlier on one side can lose to a later change of a different field
   on the other side. (`lastWriter`)

7. **`notify` on a to-do update.** Basecamp's `notify` is documented for
   create; §8.1 implies it also applies to PUT. Implemented: `true` only when a
   person (manual mode) adds Basecamp people who were not assigned before;
   automatic updates are always `false`. Unknown whether `notify: true` on PUT
   re-notifies people who were already assigned.

8. **E-mail for externals copied to a parent by the union.** Implemented as
   `notifyEmail: false` on the copies, by analogy with `notify: false` (they
   were e-mailed when assigned to the subtask). (`computeAutoAssignees`)

9. **Several followers.** The block line label is «المتابع الداخلي» (singular);
   several names are joined with «، ». Plural wording undecided.

10. **Moving a synced row to a local (unsynced) sheet.** Not covered by §9.2.6.
    With `ctx.listId` null, list changes are ignored; the row is not moved or
    trashed in Basecamp.

## Depends on the phase 0 live test

11. **What Basecamp's sanitiser does to the managed block and to descriptions.**
    Comparisons are built to survive markup rewrites: the human part is compared
    whitespace-insensitively (`normalizeHtml`), the block by its visible text
    (`htmlToComparableText`), and bases store what was sent, so a rewrite costs
    at most one inbound refresh, never a write loop. If `check-block` shows that
    Basecamp changes the block's *text* (entities, Unicode), the normaliser must
    learn that change, or every sync would rewrite the block.

12. **Bidi inside block lines.** Latin names or organisations inside an Arabic
    line may reorder in Basecamp. `bdi` is not an allowed tag; Unicode isolates
    (U+2068/U+2069) were not added because it is unknown whether Basecamp keeps
    them.

13. **Assignees Basecamp drops silently** (e.g. not a project member). On an
    `auto` parent the returned list would differ from the union and be read as
    a human edit → `manual`.

## Shared-type changes this package works around

**Resolved 2026-11-10** — the owner changed the shared contract
(`packages/shared/src/domain.ts`) and every workaround below was removed:

- `DiffResult.assignMode` → removed; `update_row.fields` carries `assignMode`.
- `order_conflict` warnings → removed; `FieldConflict.field` has `position`
  and `listId`, so order and list conflicts are reported as field conflicts.
- `ctx.baseListId` → removed; the list at the last sync is `SyncedBase.listId`.
  Without a base, a list difference is resolved last-writer-wins and reported
  (before: read as a move made in Basecamp).
- `ctx.bcId`, `ctx.deletedRemotely` → removed; read from `LocalTask.bcId` and
  `LocalTask.deletedRemotely`.
- A fetched record required for every to-do update → no longer; without it the
  full PUT is built from the base, which now keeps `completionSubscriberIds`
  (spec §9.2.4). `remote_required` remains only for a row that has a Basecamp
  id but neither a base nor a fetched record. See #15.

Original text: the workarounds were `DiffResult.assignMode` (update_row cannot
carry `assignMode`), `order_conflict` warnings (`FieldConflict.field` has no
`position`), `ctx.baseListId` (`SyncedBase` has no list id), `ctx.bcId` and
`ctx.deletedRemotely` (`LocalTask` has neither), and a fetched record required
for every to-do update (`SyncedBase` has no `completionSubscriberIds`).

## Added with the contract change of 2026-11-10

14. **Positions Basecamp does not send.** `RemoteTodo.position` /
    `RemoteSubtask.position` are `null` when the single-record GET omits them.
    Implemented: an unknown position is never compared — `isEcho` uses the
    base's, the diff sends only a local order change and reports no position
    conflict. A base built from such a record keeps the last known position
    (`baseFromRemote(…, lastKnownPosition)`, likewise `baseAfter*Write`); the
    builders throw rather than invent one. A Basecamp list move read without a
    position is `move_row` with `position: null` (append; reconciliation's list
    read corrects it), and `move_row.position` became `number | null` for it.
    A new row from such a record takes `NewRowPlacement.position`.
    `recreateSubtaskFromSnapshot` now takes the restored row and uses its
    position, which is also where the row's own diff would create it.
    (`src/hash.ts`, `src/diff.ts`, `src/deletion.ts`)

15. **A to-do update built from the base** (record not fetched). Spec §9.2.4
    allows "آخر حالة متزامنة". Every field the platform did not change is sent
    as it was at the last sync, so a Basecamp change made since then and not
    yet read (e.g. completion subscribers, or a field changed without a
    webhook) is overwritten. Webhook and reconciliation paths always fetch;
    the executor should pass the record whenever it has one. (`src/diff.ts`)

16. **Undo of a deletion** (§16 scenario 3). `undoDeletion` turns an executed
    `trash_todo` into `untrash_todo` (same record, never re-created) and a
    `delete_subtask` into a `create_subtask` from its snapshot. Two
    assumptions: `PUT /recordings/{id}/status/active.json` restores from the
    trash (basecamp OPEN_QUESTIONS.md #10, live test), and the executor runs
    the undo before diffing the restored row — a row whose record is still
    trashed would otherwise be marked deleted in Basecamp. (`src/deletion.ts`)

## Phase 5 (2026-11-10)

- **Files in the description** (`src/attachments.ts`): `<bc-attachment>`
  elements are found by a tolerant pattern (quoted attributes may hold `>`; an
  element ends at its first closing tag). The platform writes only
  `<bc-attachment sgid="…"></bc-attachment>` at the end of the person's part,
  never in the managed block (apps/api OPEN_QUESTIONS.md P1). The diff itself is
  unchanged: files travel inside `notesHtml` like any other markup.

