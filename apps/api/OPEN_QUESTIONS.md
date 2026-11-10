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
   **Resolved 2026-11-10:** the contract has `PutWorkbookMembersResponse`
   (= `WorkbookMembersResponse`); the route answers with it.

5. **`GET /api/workbooks/:id/room`** (WebSocket upgrade to `WorkbookRoom`) is
   not in the contract. It exists only because the phase 6 stub must accept a
   WebSocket after an authorisation check; the contract should name it when the
   realtime protocol is designed.
   **Resolved 2026-11-10:** `packages/shared/src/api.ts` documents the route
   (101 / 404 `not_found` / 426 `websocket_required`); the message protocol is
   still phase 6. The same change documented `POST /api/workbooks` → 201 and
   typed `ApiError.error` as `ApiErrorCode`, the codes in `src/errors.ts`.

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

## Google import

`src/google-import/` (spec §7.2, §12.1 item 7, §14). Referenced from the code
as `OPEN_QUESTIONS.md "Google import" Gn`. Google endpoints and parameters were
checked on 2026-11-10 against the official OAuth 2.0 web-server guide and the
Sheets API v4 reference (spreadsheets.get, field masks, usage limits). Phase 2
acceptance still needs the real multi-sheet NAF file (CLAUDE.md §1); every test
here runs on the synthetic fixture of `@naf-sheets/gsheets-import`.

G1. **(owner)** **Picker / `drive.file` not implemented.** Only the paste-a-link path
    exists, with the single scope `spreadsheets.readonly`. Picker needs a
    browser API key and the Cloud project number, which do not exist yet.
    Google's Sheets scopes page (checked 2026-11-10) lists
    `spreadsheets.readonly` as **Sensitive** ("requires you to go through
    additional app verification" for a public app) and `drive.file` as
    **Recommended, non-sensitive**. Is the OAuth client public ("External") or
    limited to NAF's Workspace ("Internal")? That decides whether verification
    is needed before phase 2 acceptance, and whether Picker is worth adding.

G2. **(owner)** **Redirect URI = request origin + `/auth/google/callback`**, computed
    the same way at start and at callback. The Google console must list
    `https://<platform origin>/auth/google/callback` (and the dev origin for
    `wrangler dev`). Depends on spec §17-4. `/auth/google/start` and
    `/auth/google/callback` are **not** public paths: both need the naf-auth
    session (the state is bound to the signed-in user).

G3. **Online access only.** No refresh token is requested or stored (one that
    arrives is dropped unread). The access token (≈ 1 hour) is kept AES-GCM
    encrypted in KV `SETTINGS` with a TTL ending 60 s before it expires; aad
    is `google:<userId>`. A user importing more than an hour after linking
    goes through consent again. A non-secret marker (`google-link:<userId>`,
    30 days) makes `GET /api/google/link` answer `expired` instead of
    `unlinked`. Confirm, or decide on offline access with a stored refresh token.

G4. **No automatic retry.** A 429 from Google answers 429 `google_rate_limited`
    with `Retry-After` (Google's value bounded to 1–600 s, else 60); a 5xx or a
    network failure answers 503 `google_unavailable`. The user retries. Quota:
    60 read requests per minute per user; one import makes at most
    1 + ⌈declared cells / 50,000⌉ requests (11 at the cap).

G5. **Size limits** (`DEFAULT_LIMITS` in `src/google-import/config.ts`), to
    calibrate against the real file and the phase 7 load test (7 sheets × 500
    rows): declared grid ≤ 500,000 cells (checked from metadata before any
    cell is fetched); ≤ 50,000 declared cells per grid request (Google
    recommends a 2 MB payload); ≤ 20 MiB of decoded Google responses per
    import (Worker memory is 128 MB); 60 s per request. Above a limit:
    413 `google_file_too_large`, nothing stored. A report over 1,000,000 bytes
    is kept in R2 (`workbooks/{id}/import-reports/{reportId}.json`) with a
    pointer in `import_reports.summary_json`, because D1 caps a value at 2 MB.

G6. **Accepted sources:** `https://docs.google.com/spreadsheets/[u/N/]d/<id>/…`
    (also without `https://`) or a bare id of 20–200 characters
    `[A-Za-z0-9_-]` (Google documents no length; ids are 44 today). Refused:
    Drive links (may point at an uploaded .xlsx), plain http, "published to
    the web" links (`/d/e/…`). The web app's own check (25–128) is stricter,
    so it never sends what the API refuses.

G7. **Comments are not read.** `commentsViewMode` is left at its default
    (OMITTED): `INCLUDED` answers 403 to a user who may not view comments, and
    would bring comment text into the report. So the import report lists no
    comments, although the converter can report them. Alternative:
    `COMMENTS_VIEW_MODE_DEFAULT_FOR_CURRENT_ACCESS`. Decide.

G8. **Decided 2026-11-10: added to `ApiErrorCode`, with `ApiError.link`.** Original question: **(contract)** **New error codes** not yet in `ApiErrorCode`
    (`packages/shared/src/api.ts`), which this module may not edit:
    `google_not_configured` (503), `google_not_linked` (409),
    `google_link_expired` (409), `google_state_invalid` (400),
    `invalid_source` (400), `google_file_forbidden` (403),
    `google_file_not_found` (404), `google_file_too_large` (413),
    `google_no_sheets` (422), `google_rate_limited` (429),
    `google_unavailable` (503), `google_bad_response` (502). Not linked /
    expired bodies also carry `link: "/auth/google/start"`; the web app
    appends `?next=`, as with naf-auth's `login`. `ApiError` needs the field.

G9. A `DATA_SOURCE` sheet without `gridProperties` is imported without cells
    (the converter still reports it as a data-source sheet).

G10. Google's 403 is answered as "the file is not shared with your Google
    account". A 403 can also mean the Sheets API is not enabled on the Cloud
    project — an operator error, not distinguished.

G11. **(contract)** **Callback failures.** Unknown, expired, replayed or foreign state:
    400 JSON `google_state_invalid` (there is no trusted `next` to return to).
    With a valid state: 302 to `next` with `google_error=denied` (consent
    refused), `scope` (read-only scope unchecked on Google's granular consent
    screen) or `failed` (code exchange failed). The web app does not read
    `google_error` yet; the contract should name it.

G12. A sheet whose Google title is blank (Google normally refuses that) gets
    its Univer sheet id as the `sheets.title`, so the CHECK holds.

G13. **Titles.** A Google title over 200 characters is cut to 200. A `title`
    sent in the request follows `POST /api/workbooks` (1–200 after trimming):
    an empty string is `invalid_title`, not "use the Google title"; send no
    `title` (or `null`) for that.

G14. **`GoogleLinkResponse.email` is always `null`.** Reading the address needs
    the `email` scope (or `openid email`), wider than §14 allows. Add it?

G15. Viewers get 403 on `/auth/google/start` (they cannot import, so there is
    nothing to link for). `GET /api/google/link` answers everyone signed in.

G16. **No unlink route.** The contract has none; Google's
    `https://oauth2.googleapis.com/revoke` exists. When Google answers 401
    (token revoked), the stored token is deleted from KV and the link reads
    `expired`. That and the single-use OAuth state are the only deletes.

G17. `POST /api/import/gsheets` answers **201** (like `POST /api/workbooks`;
    the contract does not say). Imported sheets are `local`, header row 1,
    until the linking wizard (§7.3) runs. `GET …/import-report` returns the
    latest report of the workbook (404 with its own message for a workbook
    that was not imported). Two audit entries per import:
    `workbook.create` and `workbook.import.gsheets` (counts, no cell content);
    each Google link is audited as `google.link` (scope and expiry, no token).

## Basecamp link

`src/basecamp-link/` (spec §3, §7.3, §9.5, §14; Appendix A-2, A-7) and
`migrations/0002_basecamp_link.sql`. Referenced from the code as
`OPEN_QUESTIONS.md "Basecamp link"`, items `B1`–`B19`. The Launchpad flow was
checked on 2026-11-10 against `basecamp/api` `sections/authentication.md`, the
`basecamp/bc-api` README and the official `basecamp/basecamp-sdk`
TypeScript OAuth client (`typescript/src/oauth/{authorize,exchange}.ts`). Every
test runs on a fake Launchpad/Basecamp; nothing here is accepted against the
real services until the phase 0 live test (CLAUDE.md §1).

B1. **(owner)** **`BASECAMP_ACCOUNT_ID`** (a `[vars]` value) names NAF's
    Basecamp account. A link is refused (`account_missing`) unless Launchpad's
    `authorization.json` lists that id with `product: "bc3"`; the platform
    never picks "the first account". The value is needed before any link works.

B2. **(owner)** **Redirect URI = request origin + `/auth/basecamp/callback`**,
    computed at `/start`, kept with the state and repeated exactly at the code
    exchange. The Launchpad integration must be registered with
    `https://<platform origin>/auth/basecamp/callback` (spec §17-4). Both
    `/auth/basecamp/*` paths stay behind the naf-auth session (the state is
    bound to the signed-in user); they are **not** public paths.

B3. **Live test: `state`.** The guide documents `type`, `client_id` and
    `redirect_uri` for `authorization/new`; `state` is OAuth draft 5 (which
    Launchpad says it implements) and the official SDK sends it. If Launchpad
    did not echo it, every link would be refused (the safe failure).

B4. **Live test: token request as a form body.** The guide shows the
    parameters in the POST URL's query string; the SDK sends them as an
    `application/x-www-form-urlencoded` body. The body is used so the client
    secret and the code never appear in a URL. Confirm Launchpad accepts it.

B5. **Live test: a refused refresh.** Launchpad's answer for a revoked or
    expired refresh token is undocumented. A refresh marks the link `expired`
    (tokens discarded, audited `basecamp.link.expire`) only on a 401 or an
    OAuth `error` of `invalid_grant` / `access_denied` / `unauthorized_client`.
    `invalid_client` (the platform's own credentials) answers 503
    `not_configured` and never expires anyone's link; any other failure
    (network, 5xx, 429, an unrecognised 4xx) answers 503 and changes nothing.
    A 401 from Basecamp itself triggers one forced refresh and one retry; a
    second 401 expires the link. Refresh starts 5 minutes before `expires_at`
    (`REFRESH_MARGIN_MS`, not in the spec). Writes are compare-and-set on the
    ciphertext read, so two concurrent refreshes never expire a link wrongly.

B6. **`encrypted_tokens = ''` means "no token held".** The column is NOT NULL
    in 0001, and SQLite cannot drop NOT NULL without rebuilding the table
    (avoided: a forward-only migration that copies and drops a table). A
    revoked or expired row keeps its
    identity columns and holds `''`. A later migration could rebuild the table
    with a nullable column if preferred.

B7. **No Launchpad revocation endpoint is documented.** `POST
    /api/basecamp/link/revoke` discards the platform's copy (row kept, status
    `revoked`, audited); the token itself stays valid at Basecamp until it
    expires (≤ 2 weeks). Revoking with no link answers 403 `not_linked`.

B8. **Decided 2026-11-10:** the proposed codes below are in `ApiErrorCode` and sent by the module; refusals outside the list (`admin_only`, `service_admin_only`, `launchpad_refused`, `not_a_user`, `service_not_admin`, `member_not_found`, `person_not_found`) keep their general code. Not linked / expired / revoked carry `link: "/auth/basecamp/start"` and the service account's not-linked `link: "/auth/basecamp/start?service=1"`. Original question: **(contract)** **Error codes.** `ApiErrorCode` is closed and this module
    may not edit `packages/shared`, so each failure uses the nearest existing
    code and the precise reason is in the Arabic `message` (`LINK_MESSAGES` in
    `src/basecamp-link/errors.ts`). Proposed codes:
    `basecamp_not_configured` (503), `basecamp_not_linked`,
    `basecamp_link_expired`, `basecamp_link_revoked` (403 — the web app needs
    these to show the re-link banner of §3 without parsing text),
    `basecamp_state_invalid` (403), `basecamp_authorization_denied` (403),
    `basecamp_account_missing` (403), `basecamp_person_taken` (409),
    `basecamp_service_not_linked` (409), `basecamp_unavailable` (503),
    `basecamp_project_not_found` / `basecamp_todoset_disabled` (404),
    `invalid_request` (400), `person_already_matched` (409).

B9. **Callback failures are JSON.** `/auth/basecamp/callback` is a page
    navigation, but a failure answers an `ApiError` body (Arabic message), as
    every other error does. Alternative: redirect to `next` with a reason the
    web app reads. Decide with the web app.

B10. **A link to another person than the email/admin match is allowed** (the
    user proved control of that Basecamp account) and recorded in the audit
    details (`matchConflict`). Should it be refused, or should the link update
    the match? The match itself grants nothing (no token, no permission).

B11. **Matching by email** uses the service token's `GET /people.json`
    (full emails need an account admin/owner, so a service account that is
    neither is refused at connection: `service_not_admin`). A member is
    matched automatically only when they have no match row yet, their email
    is unique among active members, and exactly one `User` person (team or
    client) not matched to anyone else has it (case-insensitive). Redacted
    addresses (`j••••@…`) are stored as NULL. Launchpad warns that it does not
    verify emails; matches therefore never grant access. A stale automatic
    match (email changed, person removed) is kept until an admin changes it.

B12. **Manual `null`** stores a manual row with no person, so the automatic
    match never overrides the admin. `PUT` answers the member's match entry
    (the contract has no response type). Only non-removed `User` people from
    the account cache can be chosen, and a person matched to another member
    is refused (409); the admin clears that match first.

B13. **Who sees project members' emails.** `GET
    /api/basecamp/projects/:id/people` returns emails to platform admins only
    (null for everyone else), because the cache is shared and may hold
    addresses an admin's refresh fetched. A non-admin refresh never erases a
    known address (redacted → NULL is not written over a stored one).

B14. **The project people cache is served only to a caller listed in it**;
    anyone else triggers a refresh with their own token, so the cache never
    reveals a project's members to someone whose Basecamp account cannot see
    the project. People absent from a refresh are marked `removed_at`, never
    deleted. A refresh by a member who sees fewer people than an admin (if
    Basecamp hides some) could mark people removed until the next refresh.

B15. **`GET /api/admin/people-matches` writes on a GET**: it refreshes the
    account cache when older than 10 minutes and runs the automatic match
    (each match audited `basecamp.people_match.auto`, actor NULL). Without a
    usable service token it answers 409 `service_not_linked` rather than
    serving a stale list.

B16. **A non-`User` Basecamp identity cannot link** (`personable_type`
    Agent/Integration/…, Appendix A-2); a missing `personable_type` is
    accepted. `/my/profile.json` is the identity; Launchpad's `identity` block
    is never used (unverified email).

B17. **A wrong or rotated `TOKEN_ENCRYPTION_KEY`** makes stored tokens
    undecryptable: the request answers 500 and the link is *not* expired, so
    a configuration mistake cannot silently unlink everyone. Key rotation
    (re-encrypting rows) is not implemented.

B18. **`BcPerson.personableType` is a `string`** in the contract; a cached
    person without the field (older rows, or a minimal person object) is
    reported as `''`. Make it `string | null`?

B19. **Live test: account and profile fields.** A Basecamp 5 account is
    expected as `product: "bc3"` in `authorization.json` (the SDK README says
    so); `/my/profile.json` is expected to carry `admin` / `owner` (people.md's
    person example), which decides whether a service account may connect.

## Sync (wave 3)

`src/sync/` (spec §7.3, §8, §9; contracts `packages/shared/src/api-sync.ts` and
the link wizard of `api-integrations.ts`) and `migrations/0003_sync.sql`.
Referenced from the code as `(Sn)`. Each is implemented with the safe
default: nothing in Basecamp or in the sheet is deleted or overwritten
without a person's action or a logged, restorable conflict. Every test runs
on a fake Basecamp (`test/sync/fake-basecamp.ts`); nothing here is accepted
against the real service until the phase 0 live test (CLAUDE.md §1).

S1. **Rows without a uid.** sheet-model OPEN #1 puts protection of the system
    columns in the editor. A synced row the browser saves without a `__uid`
    (`untracked_row`) is not synced and has no row state to report (no uid).
    The API does not write uids after a browser save: a server write would
    make the editor's next save fail with 409 until the room carries server
    edits (phase 6). Decide: the editor assigns uids to new rows (proposed),
    or the API does it through the room.

S2. **Attribution per row, not per field.** A queue message names a task;
    the consumer sends the row's full state. When two people edit the same
    row before it syncs, both changes go out under the token of the message
    being processed. (Different rows are always attributed to their own
    editors, §16 scenario 11.)

S3. **`match_by_title` at link time.** The plan cannot carry the pairs the
    person reviewed (`SheetPlan` has no field for them), so the commit applies
    the same deterministic matching the preview showed (unique titles on both
    sides only). For a matched row Basecamp's values win where they differ
    (the row has no local change time), and every difference is stored as a
    conflict the person can restore from the conflicts routes. Confirm the
    direction, and whether the plan should carry the accepted pairs.

S4. **Interrupted link commit.** Linking creates things in Basecamp before
    the snapshot and D1 are written, and nothing in Basecamp is ever deleted.
    `workbooks.link_state = 'linking'` keeps the project and the lists already
    created; the next commit reuses them. While `linking`, the workbook already
    has `bc_project_id` and reads as linked in the workbook list.

S5. **Positions of completed to-dos.** Reconciliation reads the pending and
    the completed lists separately. Whether they share one position sequence
    (and how it relates to the sheet's order, where completed rows are
    interleaved) is unknown until the live test; completed to-dos' positions
    are therefore not compared (no reorder from them).

S6. **Resuming after `Reason: Account Inactive`.** The whole account's sync
    stops (`sync_accounts`), rows stay `pending`, every workbook shows the
    notice, an audit row is written. There is no dedicated route: a platform
    admin's «مزامنة الآن» resumes the account. Decide the resume path.

S7. **Subtasks deleted in Basecamp and the automatic union (§8.1).** Their
    rows stay (struck through, §9.3.10) but their assignees leave the to-do's
    union.

S8. **«محذوفة في Basecamp» style.** §9.3.10 asks for strikethrough and grey.
    The snapshot needs a literal colour (Univer styles cannot read the theme)
    and the platform theme (CLAUDE.md §0) is undecided: only the
    strikethrough is written. Which grey, and from which theme file?

S9. **A Basecamp value the sheet cannot take** (a formula in the mapped cell,
    a checkbox driven by a formula, an assignee the name caches do not know):
    the row goes to `error` (`inbound:<code>`, the sheet-model message) and its
    base is *not* moved, so the next outbound push cannot revert Basecamp. The
    row waits until the cell is fixed or the caches learn the name (refreshed
    once per inbound run when an unknown id appears).

S10. **`PUBLIC_API_ORIGIN`** (a `[vars]` placeholder) is the HTTPS origin in
    the webhook `payload_url` (spec §17-4, not decided). Until it is set, no
    webhook is registered, the workbook shows the «webhook pending» notice and
    reconciliation carries the inbound sync alone.

S11. **Assignee candidates in the link preview.** An assignee text is
    confident when exactly one project person (or external contact) has that
    name after normalisation; otherwise up to 5 candidates with a similarity
    ≥ 0.5 (Levenshtein on the wizard's folded labels, at least 0.8 when one
    name contains the other). Threshold and count are not in the spec.

S12. **A uid owned by another workbook** (a row copied across workbooks) is
    not tracked in this one (`tasks.task_uid` is global); it is logged.

S13. **`TaskSyncInfo.bcUrl`** is built from the documented app URL pattern
    `https://3.basecamp.com/{account}/buckets/{project}/todos/{id}`; a subtask
    links to its to-do (no documented subtask URL). Confirm at the live test,
    or store `app_url` from the records.

S14. **A sheet the platform creates for a new list** (§9.3.9, default
    `create_sheet`) gets the default columns of §7.1 and «منجز» as the value
    that means completed in «الحالة». Confirm.

S15. **Assignee options without the caller's own link.** The project people
    are then served from the cache as it is (no refresh), so a viewer who never
    linked Basecamp still sees the names the sheet already shows. Emails go to
    platform admins only (as basecamp-link B13).

S16. **Out of scope in this wave, data untouched:** comments
    (`comment_created` is logged as ignored), attachments and uploads,
    *(phase 5, 2026-11-10: comments and attachments are now handled — see
    "Phase 5: attachments and comments" P1–P21; `Upload` events stay ignored, P8)*
    Basecamp invitations (§8.2 case 2) and external-contact e-mail (§17-7).
    Descriptions round-trip byte for byte, so `bc-attachment` tags survive.

S17. **Decided 2026-11-10: spec §3.** An editor whose Basecamp link is
    missing, expired or revoked keeps their edits `pending`, with the Arabic
    re-link message in `TaskSyncInfo.message` (`last_error_code`
    `actor_not_linked` / `actor_link_expired` / `actor_link_revoked`); nothing
    is ever sent under another account (the §8.1 automatic union alone may go
    with the service token, logged «قاعدة تلقائية»). Linking again is enough:
    GET …/sync (which the editor polls) and every reconciliation queue that
    person's held rows again with their own identity, whatever their age; rows
    whose author is still unlinked are not re-queued. GET …/sync therefore
    writes (it clears the message of the rows it queues). The contract's
    comment on `TaskSyncInfo.message` ("`error` and `conflict` only") should
    add this `pending` case (S23). Original question: the brief asked for
    `error`; the spec says `pending` with a re-link alert.

S18. **404 with a person's token** may mean "no access" (§3), not "deleted".
    The outbound consumer then holds the row (`not_found`, never retried) and
    never marks it deleted; only a service-token read (webhook,
    reconciliation) marks a row deleted in Basecamp.

S19. **§8.1's automatic update and reconciliation.** When reconciliation
    finds a subtask change on a to-do in automatic mode, it writes the union
    with the service token (the documented exception, logged «قاعدة تلقائية»,
    `notify: false`), although §9.4 calls reconciliation read-only. A to-do
    with a person's change still pending is left to that person's message.

S20. **A linked list that answers 404** to the service account during
    reconciliation is treated as deleted: every row of its sheet is marked,
    none removed; a later successful read restores them.

S21. **Retry numbers.** 5 attempts per message are the spec's (§9.2.8). The
    backoff (10 s doubling, capped at 300 s), the 5 s delay when another step
    holds the task, the 2-minute task lease and the 10-minute "stale pending"
    re-queue are this module's. The consumer gives a message up itself (DLQ
    producer `BC_OUTBOUND_DLQ` + `sync_dead_letters` + row error); the queue's
    own `max_retries`/`dead_letter_queue` remain as the backstop.

S22. **bc-inbound give-up.** After 5 attempts a webhook or «مزامنة الآن»
    message is recorded in `sync_dead_letters` (queue `bc-inbound`) and
    acknowledged, not sent to `bc-inbound-dlq`: reconciliation reads the same
    records within 15 minutes.

S23. **Contract proposals for `api-sync.ts`** (not changed, the web app is
    built against it):
    - `TaskSyncInfo` could carry the machine code of `message`
      (`row_missing`, `actor_not_linked`, …) so the editor can act (e.g.
      show the link button) without parsing text.
    - `SyncHealthResponse` has no account-level state: an inactive account
      (S6) and a missing service account show only as workbook notices.
    - Restoring a conflict whose value the sheet cannot take answers 409
      `sheet_write_refused` (a code added under `// Sync`).
    - `ConflictRecord` for `assignees`: `localValue` is the row's
      `Assignee[]`, `remoteValue` Basecamp's ids (as sync-engine reports it).

S24. **§8.2 case 1 refused by Basecamp (403).** The route answers the spec's
    Arabic sentence. The «أرسل طلباً» path (an `access_requests` row, an admin
    notice, the row «بانتظار إضافة عضو») has no route in the contract and is
    not built.

S25. **A new row from Basecamp that cannot be placed** (sheet-model
    `no_free_row`: the row under the table holds something) is logged and
    tried again by every reconciliation until there is room.

S26. **Order changes are one call per row.** Inserting a row in the middle
    of a sheet moves every later row's 1-based position; each sends its own
    `PUT …/position.json`.

S27. **Deleting only a to-do's row while its subtask rows stay** trashes the
    to-do in Basecamp (its subtasks go with it), and the subtask rows are left
    in the sheet as they are (sheet-model then reports them as misplaced).

## Realtime room (phase 6)

Decisions the realtime room (`src/room.ts`, `src/room/`, protocol in
`packages/shared/src/room-protocol.ts`, client in `apps/web/src/lib/room-client.ts`
and `apps/web/src/collab/`) needed. Marked `OPEN:` in the code with these
numbers.

R1. **(owner)** **Spec §17-2 is still open; the room is built on default (a).**
    The phase 6 spike (2026-11-10, local workerd) found headless Univer 1.4.0
    (core, sheets, formula engine and the model plugins of the editor's
    presets) runs inside the Durable Object: a 3-sheet × 300-row workbook loads
    in ~65 ms, computes in ~135–200 ms, applies a mutation in ~0.1 ms and holds
    ~8 MB of heap. The API Worker bundle grows from 362 KiB (87 KiB gzip) to
    12.7 MB (2.37 MB gzip); see R15. Confirm (a), or decide on Univer Pro.

R2. **Mutations the room accepts** are an allow-list (`ROOM_MUTATIONS`). Not
    accepted yet, because their effect on concurrent edits is not settled:
    sheet and range protection (`*-protection`, permission points), range
    themes, `set-workbook-calculation-settings`, `sheet.mutation.empty`, and
    the lazy path of copying a large sheet (`copy-worksheet-end`, sent
    `syncOnly`). Such an edit is refused and the editor reloads the room's
    state with an Arabic message. Which of them should be shared?

R3. **Commit cadence.** The room commits 2 s after the last edit (spec §9.2.2's
    outbound debounce) and at most every 10 s while edits continue (the
    editor's autosave), and when the last editor leaves. Every commit is a new
    R2 version and none is ever deleted (CLAUDE.md §3), as with autosave today.
    Between commits, edits are durable in the room's own log.

R4. **WebSocket message size.** Messages over 256 Ki characters (≤ 768 KiB
    UTF-8) are split into `chunk` frames, assuming a 1 MiB limit per message.
    The production limit was not re-checked (no network access during the work).

R5. **Largest workbook opened live: 4,000,000 characters of snapshot JSON**
    (`MAX_LIVE_SNAPSHOT_CHARS`). Measured: ~3 MB (10,000 task rows) took 66.7 MB
    of heap after GC but peaked at ~113 MB before GC, and 2.8–4.1 s to load and
    compute. A larger workbook is refused (close 4413, Arabic message); what
    should the editor do then — open read-only, or fall back to whole-snapshot
    autosave?

R6. **The room's op log is never pruned** (Durable Object SQLite, one row per
    applied op, and `room_events`). Pruning rows already committed would delete
    data, which needs the owner's approval (CLAUDE.md §3).

R7. **A browser save while a session is live.** PUT /snapshot is unchanged: a
    tab outside the room that saves before the room's next commit wins version
    N+1; the room then commits its state on top (N+2) and records the
    superseded version in `room_events`. Nothing is overwritten (versions are
    create-only), but that tab's edits are no longer current.
    **Implemented 2026-11-10:** PUT …/snapshot answers 409 `room_active` (Arabic
    message) while `roomSessionActive(env, id)` is true, and the editor saves
    with PUT only when it could not join the room (apps/web OPEN_QUESTIONS #50).
    A save that passed the check just before a session started can still be
    superseded as above.

R8. **The soft lock is enforced.** Spec §11 says a cell being edited "appears
    locked to others"; the room also refuses (`locked`) an op that touches a
    cell another connection holds, so a paste over that cell is undone. Locks
    end on `unlock` or when the connection drops; there is no idle timeout.

R9. **Presence colours.** Each connection gets an index 0–5
    (`apps/web/src/collab/presence.ts`). **2026-11-10:** the six colours are
    defined in `apps/web/src/styles/theme.css` (`--presence-1…6`), provisional
    like the rest of the theme (CLAUDE.md §0: what replaces `naf-ui` is open).

R10. **Undo after remote edits.** Undo history is cleared when another
    editor's op moves rows, columns or sheets. After a remote *cell* edit it is
    kept: undoing your own earlier edit of that same cell overwrites the other
    person's value without a conflict.

R11. **A server change that is not cell-only** (inbound sync inserting a row,
    a new sheet, notes or validation changing, the link wizard adding system
    columns) reloads every open editor from the committed snapshot; an editor's
    edits still in flight at that moment are dropped with an Arabic notice.
    Cell-only changes reach editors as ordinary ops.

R12. **Access is fixed per connection.** The Worker checks access at connect
    (spec §14); a role changed while a person is connected applies from their
    next connection.

R13. **Author of a room commit.** R2's `savedBy` on a room commit is the author
    of the last op it includes (several people's edits may be in one version).
    Per-edit authors are passed to outbound detection (R14).

R14. **Outbound seam.** After each commit the room calls the detection
    installed with `setOutboundDetection` (`src/room/outbound-seam.ts`, marked
    `WAVE3-SEAM: outbound detection`) with every edit the commit includes: seq,
    author, footprint and confirmed deletions, plus the committed snapshot.
    **Implemented 2026-11-10:** `src/index.ts` installs `detectAfterRoomCommit`
    (`src/sync/room-commit.ts`): each changed row is queued with the token of
    the last person whose edit touched it (§3), confirmed deletions with the
    person who confirmed them; server edits are never credited to a person and
    a commit with only server edits runs no detection. See R17–R19.

R15. **Cloudflare limits to confirm on the real plan** (from documentation
    known before this work, not re-checked): Worker size 3 MB gzip (Free) /
    10 MB (Paid) — the API is now 2.37 MB gzip; startup — 6–10 ms of CPU with
    the engine imported lazily (67–274 ms when it was imported eagerly); 128 MB of memory
    per isolate, which several Durable Objects of one class may share on one
    machine. Moving `WorkbookRoom` to its own Worker script would keep Univer
    out of the API Worker; that needs a `wrangler.toml` change (not made).

R16. **The contract comment** for GET /api/workbooks/:id/room in
    `packages/shared/src/api.ts` said the message protocol was not defined.
    **Resolved 2026-11-10:** it points to `room-protocol.ts` and documents 409
    `room_active`.

R17. **Who a row is credited to when no edit of the commit can be matched to
    it.** Edits are matched to rows by position, valid only after the last
    structural edit. A row behind a person's structural edit (rows inserted,
    removed, moved or sorted), or changed without an edit on its cells (a
    formula result, a note), is credited to the commit's last author. A row
    behind a server reload is credited to nobody and left for the next commit.
    A finer rule would need positions translated through structural edits.

R18. **Detection inside a server-change commit runs before the caller's own
    D1 writes** (inbound sync records `local_hash` and new task rows after
    `updateLatestSnapshot` returns). Rows only the server touched are therefore
    skipped by detection (never queued, never credited), so a row created by
    inbound sync can never be created again in Basecamp by detection.

R19. **Confirmed deletions travel on the next op after the dialog.** The
    editor confirms, then lets the row removal run; the client attaches the
    confirmed uids to the next op it sends (the removal). If that op is
    refused, the removal is undone by the resync and the confirmation goes
    with it. A confirmation logged in an earlier commit than the removal is not
    used: the row is held as missing (`row_missing`) and Basecamp is untouched.

## Phase 5: attachments and comments

`src/phase5/` (spec §5.2, §8 table, §8.2, §10, §12.1 item 5, §9.3.5; contract
`packages/shared/src/api-phase5.ts`), the hooks in `src/sync/task-sync.ts` and
`src/sync/inbound/consumer.ts`, and `migrations/0004_phase5_attachments_comments.sql`.
Marked `OPEN (Pn)` in the code. Every test runs on the fake Basecamp
(`test/sync/fake-basecamp.ts`, extended); **nothing here has been tried
against real Basecamp** (P18). Items marked **(owner)** need the owner.

P1. **Where an uploaded file goes in the description: the end of the
    person's part**, right before the managed block — not inside the block.
    Spec §8.2 keeps "what precedes the block verbatim, *attachments included*",
    so files are expected there; the block is rewritten whole and compared by
    its visible text (a file has none), so a file inside it would be dropped
    or invisible to the comparison; and it is where Basecamp shows a file a
    person attached. Only `<bc-attachment sgid="…"></bc-attachment>` is
    written (the attribute rich_text.md documents). Confirm.

P2. **Found and fixed while building phase 5: a sheet without a notes
    column wiped the description.** The engine read "no notes" as a local edit
    and the next outbound update sent an empty description — the text a person
    wrote in Basecamp and its files were lost (contradicts §8.2 and §16
    scenario 8). Now the person's part *follows Basecamp* when the sheet's
    mapping has no notes column (`diffLocal` in `src/sync/state.ts`, at the
    three diff call sites; fingerprints unchanged). Test:
    `test/phase5/probe-notes.test.ts`. Confirm the rule.

P3. **(owner)** **Subtask files** (§8 table, §17-5): kept in the platform
    with a notice (`state: 'local_only'`), the default. The spec's alternative
    — attach to the parent to-do with a reference to the subtask, as a
    setting — is not built; `AttachmentSettings.subtaskMode` has the one value
    `'local'`.

P4. **(owner)** **The 30-day archive (§10).** A removed chip keeps its D1 row
    (`removed_at`, `removed_by`) and its R2 object where it is; `purge_after`
    records removed_at + 30 days. Nothing purges it: deleting data needs the
    owner's decision (CLAUDE.md §3). Decide the mechanism (a cron that deletes
    objects past `purge_after`, or an R2 lifecycle rule on a prefix — which
    would mean moving objects), and whether a removed file can be restored
    within the 30 days (no route for it yet).

P5. **Removing a chip of a to-do deleted or archived in Basecamp**, or of a
    subtask / local row: only the platform's chip goes; Basecamp is not called.

P6. **(owner)** **Size limit.** Default 100 MB = 100 × 1024 × 1024 bytes; an
    admin can lower it (`PUT /api/admin/attachment-settings`, KV `SETTINGS`),
    not raise it above 100 MB: the Worker cannot take a larger request body on
    the Free / Pro plans (Cloudflare's published limit, not re-checked here).
    A larger limit needs another upload path (direct to R2 with a signed URL).
    The limit is checked on `Content-Length` before a byte is read; the body is
    streamed to R2 through `FixedLengthStream` (never buffered whole), and from
    R2 to Basecamp the same way (re-opened for each retried attempt).

P7. **Downloads of files that came from Basecamp** (no platform copy) are
    read from Basecamp with the caller's own token (§3, §10 «بصلاحيات
    المستخدم»). A viewer who never linked Basecamp gets 403
    `basecamp_not_linked`. Alternatives: copy such files into R2 when they are
    first seen (with the service token), or allow the service token for this
    read. Files uploaded from the platform are served from R2 to anyone who may
    open the workbook.

P8. **Uploads (docs & files) are not tied to tasks.** §10 says "the project's
    uploads tied to the task"; the documented API ties an `Upload` to a vault,
    not to a to-do. `Upload` webhook events are logged as ignored
    (`upload_not_linked_to_task`); files are read from the description only.

P9. **The upload runs in the request, not in the `bc-outbound` queue**: R2,
    then Basecamp's `POST /attachments.json` and the description `PUT`, with
    the caller's token, so the person sees the outcome at once. A Basecamp
    failure keeps the file as `failed` with the Arabic reason and a retry route;
    the response is still 201. How long a 100 MB upload to Basecamp may take
    inside one request was not measured.

P10. **The description write takes the task's sync lease** (the one the
    queue consumers take), waiting up to 6 × 500 ms; then 409 `task_busy` (for
    an upload: the file is kept, `failed`, retry). The to-do is read fresh with
    the caller's token right before the `PUT`, which carries every field
    (§9.2.4) with `notify: false`; then the ordinary sync step runs read-only on
    Basecamp's answer, so the notes cell and the 3-way base learn the new
    description and no later diff takes the file out. A notes edit still
    pending in the sheet at that moment is resolved by the engine afterwards
    (a logged, restorable conflict, last writer wins).

P11. **Notes cells keep files.** sheet-model now keeps the description's
    `<bc-attachment>` elements when a person edits or clears the notes text
    (sheet-model OPEN #8), so only the attachment editor removes a file. Before
    this, editing the notes cell dropped every file from Basecamp.

P12. **Inbound extraction.** Files are keyed by `sgid` (`uq_attachments_task_sgid`).
    Name, type, size and `download_url` come from `description_attachments`
    when Basecamp sends it; otherwise from the element's `filename` attribute
    (not documented), else «مرفق», size 0. A file that left the description in
    Basecamp loses its chip (`removed_by` NULL); a platform copy, if any, is
    kept 30 days. A file still `uploading` or `failed` is left alone.

P13. **The attachments cell is display-only**: the server writes the names
    (joined with «، », sheet-model `writeAttachmentNames`) after every change; a
    person's paste into it is replaced at the next change (apps/web OPEN #58).

P14. **Comments are read live** from Basecamp with the caller's token; the
    platform keeps no copy, only the counter (`tasks.bc_comments_count`, from
    `comments_count`). Webhook `Comment` events (any kind) read the comment,
    then its to-do, with the service token; reconciliation also re-reads a
    to-do whose counter changed (a new comment may not move `updated_at`).
    After a comment is added from the platform the counter goes up by one until
    the next read. Comments are shown as plain text (markup removed); a
    comment's own files are shown by name only.

P15. **A viewer reading comments needs their own Basecamp link** (403
    `basecamp_not_linked` with `link`). Alternative: the service token for this
    read-only call (§3 reserves it for background work).

P16. **Comment markup sent**: `<div>` with the escaped text and `<br>` per line
    (tags rich_text.md allows); not verified live.

P17. **Contract additions** besides `api-phase5.ts`: optional
    `TaskSyncInfo.commentsCount` / `attachmentsCount` in `api-sync.ts` (the
    editor's per-row counter, polled with GET …/sync); `RemoteTodo.commentsCount`
    / `descriptionAttachments` and `RemoteAttachment` in `domain.ts`;
    `update_row.fields.attachments` (written by the API only, never by the
    engine). The upload is a raw body with `?name=`, not multipart.

P18. **(owner)** **Phase 5 acceptance needs real Basecamp** (spec §15): the
    binary `POST /attachments.json`, a `<bc-attachment>` surviving Basecamp's
    sanitiser in the description, the shape of `description_attachments`, how
    `download_url` authenticates (packages/basecamp OPEN #14), the comments
    endpoints, the `comment_created` payload. None of it ran against Basecamp;
    the live kit in `spike/basecamp/` does not cover it yet.

P19. **`attachable_sgid` = the description's `sgid`** is assumed
    (packages/basecamp OPEN #15).

P20. **Download headers.** Files are served from the API origin with
    `Content-Disposition: attachment` (UTF-8 name), `X-Content-Type-Options:
    nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`, so an
    uploaded HTML file never runs as a page of the platform. A separate download
    origin would be stronger.

P21. **Accepted files.** Any media type is accepted (no allow-list); the type
    is sanitised (`application/octet-stream` when unusable). Names lose control
    characters and bidi overrides, `/` and `\` become `_`, at most 255
    characters. Should some types be refused?

## Phase 7: templates, internal API, backups, load test

Code: `src/phase7/`, `migrations/0005_phase7.sql`, contract `packages/shared/src/api-phase7.ts`.
Tests: `test/phase7/` (15). Load test: `test/load/api-load.load.ts` (docs/load-test.md).

T1. **A template is a frozen copy** of the source workbook's latest saved
    snapshot (R2 `templates/{id}/snapshot.json`, create-only), not a live link
    to the workbook. Spec §7.1 says «أي ملف يُحوَّل إلى قالب»; whether a later
    edit of the source should update the template (or offer «تحديث القالب»)
    is not said. Safe default: frozen; the source workbook is only read.

T2. **A workbook open in the room** may hold edits newer than its saved
    snapshot (the room persists 2 s after the last edit, R3). The template
    copies the latest *saved* version and records it (`templates.source_version`).

T3. **What a template drops**: the system columns `__uid / __parent_uid /
    __level` (values and hidden flags), the platform's marks (restored to the
    person's style), `custom.nafSheets`, and the platform's «لا يُزامَن مع
    Basecamp» notes. Everything else is kept, including the free and mapped
    columns' header text. A sheet whose system columns are incomplete is kept as
    it is (its copy is local, so no uid is read from it); logged, not refused.
    Column mappings are not copied: a workbook made from a template is linked
    with the wizard (§7.3), whose suggestions come from the header text.

T4. **Who manages templates**: platform `admin` only (§7.1 «يحفظها admin»);
    listing them is open to everyone signed in; creating a workbook from one
    needs the right to create workbooks (admin, editor). Archive only — no
    delete, no unarchive route (an admin can ask for one).

T5. **No built-in NAF template ships.** The spec mentions «قوالب ناف» but
    gives none; until an admin saves one, «من قالب ناف» lists nothing and says
    how to add one. Should a default template (e.g. the §7.1 default columns in
    a campaign layout) be seeded?

I1. **Service tokens (§13 «محمية برموز خدمة»)**: how they are issued, scoped
    and rotated is not specified. Safe default: an admin issues a named token
    (`POST /api/admin/api-tokens`, shown once, only its SHA-256 stored),
    read-only over every workbook, revocable, never deleted, `last_used_at`
    kept. No per-system scopes, no expiry. Decide with §17-3.

I2. **The optional outbound webhook** («Webhook صادر اختياري لأحداث: مهمة
    أُنجزت، مهمة تأخرت») is **not built**: no receiving system, URL, signing or
    "became overdue" trigger is specified (§17-3 open). Nothing is sent anywhere.

I3. **Which other NAF systems connect (§17-3)** is open; the API serves
    whoever holds a token.

I4. **"Today" for `overdue`** is the date in Asia/Riyadh; a task due today is
    `open`, due yesterday and not completed `overdue`. Status words are
    `done | open | overdue` (the spec names «منجزة/متأخرة» only).

I5. **What counts as a task in /api/v1**: rows of synced sheets (local sheets
    have no task identity, §2), to-dos and subtasks alike (`level`), read from
    the latest saved snapshot exactly as the sync engine reads them. Rows
    deleted/archived/trashed in Basecamp are left out. `assignee=` matches a
    Basecamp person id or an external contact id; a follower counts as that
    person in `/stats`.

I6. **/api/v1/stats reads every snapshot on each call** (measured in
    docs/load-test.md). A cache (KV, invalidated on commit) if it grows.

B1. **Official D1 backup mechanism**: Cloudflare offers D1 Time Travel and
    `wrangler d1 export` (REST, needs a Cloudflare API token). Built here: a
    daily in-Worker export of every table to the BACKUPS bucket (NDJSON,
    create-only, never deletes) and a copy of each live workbook's latest
    snapshot. Restore is a documented manual procedure (docs/backups.md), no
    script. Which mechanism is authoritative is a product decision.

B2. **Retention**: nothing is ever deleted, so the bucket grows daily. A
    lifecycle rule on R2 (or a pruning job) needs the owner's approval.

B3. **Where backups live**: same Cloudflare account, bucket
    `naf-sheets-backups`. Another account/region is a product decision.

B4. **Not backed up**: the ATTACHMENTS bucket and KV (sessions, settings).
    §14 names R2 snapshots and D1 only.

B5. **Snapshots copied**: the latest version of each live workbook and each
    live template, daily; older versions stay in SNAPSHOTS (never deleted) and
    are listed in the run's inventory.

L1. **Load test scope** (docs/load-test.md): local Miniflare and an
    in-process fake Basecamp; not Cloudflare, not Basecamp. Timings inside
    workerd come from `Date.now()`, which advances at I/O only. The spec gives
    no target numbers for phase 7, so nothing is judged pass/fail on speed;
    the assertions are correctness (every task created once, all `synced`).

L2. **Each outbound message loads the whole workbook** (snapshot from R2 +
    every row read) to build one task: measured 115 ms per task locally for a
    3,500-row workbook against 34 ms for a 100-row one (docs/load-test.md
    §2.3). Not changed here (no tuning toward the numbers). Batch a
    workbook's messages in one step? The real ceiling stays Basecamp's
    4 requests/second: about 17.5 min for a first link of 3,500 tasks.

L3. **The first reconciliation after linking ten large workbooks** read 7,701
    times (no stored ETag yet): about 32 min at 4 requests/second, longer than
    the 15-minute cron. Is an overlap guard (or spreading lists over runs)
    wanted? A quiet run read 721 times (70/70 lists answered 304).
