# API — open questions

Decisions the API needed that the spec (`docs/spec.md`), `CLAUDE.md` or the
contract (`packages/shared/src/api.ts`) do not settle. Each one is implemented
with the narrowest safe behaviour and marked `OPEN:` in the code. Numbers are
referenced from the code (`OPEN_QUESTIONS.md #n`).

Items marked **(owner)** need a decision from the owner; the others record
behaviour chosen in the absence of a rule and need only a confirmation.

1. **(owner)** **`members` replaces the spec's `users` table** (proposed, not confirmed).
   Identity has one source: naf-auth's `members` table, keyed by the naf-id
   `sub`; every person column references `members(user_id)`. Written at the top
   of `migrations/0001_initial.sql`. If rejected, a follow-up migration adds
   `users` and re-points the foreign keys.

2. **(owner)** **`PLATFORM_ID`** is `REPLACE_WITH_PLATFORM_ID` in `wrangler.toml`. It is
   case-sensitive and must equal the platform row in the naf-id admin panel;
   until then every sign-in fails at naf-id. The other `REPLACE_WITH_*` values
   (D1, two KV namespaces) are resource ids created at deploy time.

3. **(owner)** **`/denied` and who serves the platform origin.** naf-auth sends a refused
   page navigation to `/denied?r=…`. The public paths given for this Worker are
   `/auth/callback`, `/auth/logout`, `/auth/backchannel-logout`, `/health` and
   `/webhooks/basecamp/*` — `/denied` is not among them and the Worker does not
   serve it. If the Worker answers for the whole origin, a refused navigation
   would loop; if Pages serves `/denied` on the same origin, nothing is needed.
   Tied to spec §17-4 (subdomain).

4. **`PUT /api/workbooks/:id/members` has no response type.** It answers with
   `WorkbookMembersResponse` (the list after the change), like `GET`.

5. **`GET /api/workbooks/:id/room`** (WebSocket upgrade to `WorkbookRoom`) is
   not in the contract. It exists only because the phase 6 stub must accept a
   WebSocket after an authorisation check; the contract should name it when the
   realtime protocol is designed.

6. **Completion** counts to-dos (level 0) of synced sheets that are active in
   Basecamp and not trashed — like Basecamp's own list progress. Should
   subtasks count? It needs `tasks.completed`, a column added to the spec's
   table and kept in step by the sync engine.

7. **Workbook `syncState`**: `unlinked` without a project; otherwise the worst
   task state wins (error > conflict > pending > synced); a linked workbook with
   no synced task reads `synced`.

8. **Archived workbooks** are hidden from the list and answer 404 — for admins
   too. There is no archive route yet; spec §17-6 (what deleting a workbook
   does) is still open.

9. **Workbook seats vs platform role.** A platform viewer can be given an
   `editor` seat; it is stored but `resolveAccess` caps them at read-only.
   Should `PUT …/members` refuse it instead? Inactive members can also be
   listed (they cannot sign in anyway).

10. **Title length**: 1–200 characters after trimming (API and a CHECK). The
    spec sets no limit; Basecamp's project-name limit has not been checked.

11. **Search (`q`)** is a plain substring match on the title (LIKE with `%`
    and `_` escaped). No Arabic normalisation (أ/إ/آ/ا, ة/ه, ى/ي) and no
    pagination — both are product decisions.

12. **Snapshot size**: no cap beyond the Workers request-body limit. Phase 7's
    load target (7 sheets × 500 rows) should set one.

13. **Snapshot concurrency.** A save writes `{version+1}.json` with a
    create-only R2 put (`onlyIf: { etagDoesNotMatch: '*' }`), then moves D1 with
    a conditional `UPDATE`. A committed version is never overwritten. An object
    left by a save that died between R2 and D1 is replaced after 5 minutes.
    Known edge: a save stalled more than 5 minutes between those two steps
    could commit content another save replaced. Create-only puts behave as
    expected in Miniflare; confirm on real R2 at the first deploy.

14. **Status vocabularies** not given by the spec: `access_requests.status` is
    constrained to `pending | approved | rejected` (proposed);
    `email_notifications.status` (depends on the email provider, §17-7) and
    `sync_log.status` (to fix with the sync engine) are left unconstrained.

15. **Webhook secrets** are stored in clear in `bc_webhooks.secret`, as the
    spec names the column. Storing only a hash would need Basecamp's
    `PUT /webhooks/{id}.json` to re-enable a webhook without resending
    `payload_url` — unverified.

16. **`bc-inbound` queue.** Spec §9.3.3 asks for "an internal queue" without
    naming it: `bc-inbound` with 5 retries and DLQ `bc-inbound-dlq`, mirroring
    `bc-outbound`. Until phases 3/4 both consumers acknowledge and drop their
    messages (reconciliation recovers state); no webhook is registered before
    then.

17. **(owner)** **First admin.** naf-auth creates every member as `viewer`; nothing in the
    platform can promote the first admin. Proposed: a one-off
    `wrangler d1 execute naf-sheets --remote --command "UPDATE members SET role = 'admin' WHERE email = '…'"`
    after that person's first sign-in.

18. **Uniqueness assumptions**: one live (non-archived) workbook per Basecamp
    project and one sheet per to-do list (partial unique indexes), because
    webhooks and reconciliation resolve the workbook/sheet from those ids.

19. **Append-only `audit_log`** is enforced by two triggers that abort UPDATE
    and DELETE. Verified on Miniflare's D1; confirm when the migration is
    first applied to real D1.

20. **Sheet positions are 1-based**, like task positions in
    `packages/shared/src/domain.ts` and Basecamp. Univer's `sheetOrder` is
    0-based; the web app maps between them.
