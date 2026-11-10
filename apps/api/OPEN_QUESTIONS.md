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
