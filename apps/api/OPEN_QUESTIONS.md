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

2. **(owner)** **`PLATFORM_ID`** is a dashboard variable of the Worker (decided
   2026-11-11: no undecided value and no resource id in `wrangler.toml`;
   `keep_vars = true` keeps it across deploys; docs/cloudflare-setup.md §3). It is
   case-sensitive and must equal the platform row in the naf-id admin panel;
   until it is set every sign-in fails at naf-id. D1, KV, R2 and the queues are
   created by the first deploy (wrangler's automatic provisioning).

3. **(owner)** **`/denied` and who serves the platform origin.** naf-auth sends a refused
   page navigation to `/denied?r=…`. The public paths given for this Worker are
   `/auth/callback`, `/auth/logout`, `/auth/backchannel-logout`, `/health` and
   `/webhooks/basecamp/*` — `/denied` is not among them and the Worker does not
   serve it. If the Worker answers for the whole origin, a refused navigation
   would loop; if Pages serves `/denied` on the same origin, nothing is needed.
   Tied to spec §17-4 (subdomain). **Decided 2026-11-11:** one Worker serves
   `sheets.naflaw.sa`: `/api/*`, `/auth/*`, `/webhooks/*` and `/health` run its
   code (`run_worker_first`), every other path, `/denied` included, is the web
   app's `index.html` (static assets, `not_found_handling = "single-page-application"`).

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

17. **First admin, then the screen** (updated 2026-11-11). naf-auth creates every
    member as `viewer`. The **first** admin is still promoted once by SQL, after
    that person's first sign-in:
    `wrangler d1 execute naf-sheets --remote --command "UPDATE members SET role = 'admin' WHERE email = '…'"`.
    Every later change of role or active state goes through «أعضاء المنصة»
    (`/admin/members`; GET/PUT `/api/admin/members`, src/routes/platform-members.ts):
    audited, reported to naf-id, guarded (an admin cannot change themselves;
    the last active admin is never demoted or suspended). See "Platform members" below.

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

### Without OAuth: .xlsx upload and public links (owner decision 2026-11-11)

**Decided (owner, 2026-11-11):** there will be no Google OAuth secret
(`GOOGLE_CLIENT_SECRET` is never set). Importing works two ways instead, both
built here (`src/xlsx-import/`) on `@naf-sheets/xlsx-import`:

- **Upload an Excel file** — `POST /api/import/xlsx?name=&title=`, the file's
  bytes as the body.
- **Paste a Google Sheets link** — `POST /api/import/gsheets-link {source, title?}`:
  the platform downloads `https://docs.google.com/spreadsheets/d/<id>/export?format=xlsx`
  with no account. Only files shared "anyone with the link can view" can be read.

The OAuth routes (`/auth/google/*`, `GET /api/google/link`,
`POST /api/import/gsheets`) stay in place, unused by the web app; G1–G4, G7,
G10, G11, G14–G16 are moot while there is no secret. The report route
(`GET /api/workbooks/:id/import-report`) serves all three paths.

**Design.** The reader is a new package `packages/xlsx-import` (zip + XML
read by our own code; no third-party parser) that builds the **same
intermediate model** the Sheets API path uses (`google-types.ts`), normalised
by origin, and hands it to the one converter (`convertSpreadsheet`). The
writing to Univer, the report and every existing converter rule stay in one
place. A separate package, because the binary container, its security
guards and the per-origin normalisation are their own concern and the
converter keeps no knowledge of zip or XML. The converter gained four options
(`origin`, `sourceName`, `formulaBlockers`, `dateSystem`) and the report a
`source.origin` field; nothing else in it changed.

**Decided 2026-11-11 (owner): G18–G31 approved as built.** The third-party
sample fixtures stay in the repository (G20); restoring TRUE/FALSE columns
of a Google export as checkboxes stays, reported (G30/G31 as written). G19
(how Google answers a private file) is still to be seen live.

G18. **Origin detection, and what differs per origin.** Verified on 2026-11-11:

| What | Excel (and other writers) | Google export (platform download or File → Download) | Sheets API (old path) | Evidence |
|---|---|---|---|---|
| Detection | `docProps/app.xml` `<Application>Microsoft Excel</Application>` | no `docProps/` at all, `xmlns:mx`/`xmlns:mv` Mac namespaces on `<workbook>`, empty `xl/persons/person.xml`, theme named "Sheets", `__xludf.DUMMYFUNCTION` | — | real Google files (4); Excel from the spec (no Excel here); openpyxl writes "Microsoft Excel Compatible / Openpyxl 3.1.5" → `other`; LibreOffice "LibreOffice/24.2…" → `other` (real file) |
| Colours | theme index (0↔lt1, 1↔dk1 swapped) + `tint` (HLS), `indexed` palette, `rgb` | `rgb` **and** theme indexes (Google writes `theme="1"` text), no tint seen | RGB/theme in JSON | real Google files; tint values checked against Excel's 2023 palette names |
| Default font | Aptos Narrow 11 / Calibri 11 | Arial 10 | `userEnteredFormat` holds only what was set | real Google files |
| Column width | ECMA formula, max digit width 7 px (9.140625 → 64 px) | `(px + 1) / 8` (12.63 → 100 px) | `pixelSize` | **Google: 13 real columns against Google's htmlview pixel widths**; Excel: formula |
| Row height | points × 4/3 | points × 4/3 (15.75 pt = 21 px) | `pixelSize` | real Google files |
| Google-only functions | `_xludf.` = unknown to Excel → value only | `IFERROR(__xludf.DUMMYFUNCTION("<formula>"), <value>)`; spilled cells `…("""COMPUTED_VALUE""")…` → original formula restored, cells produced | formula as typed | real export (`QUERY`) |
| Shared / array formulas | both | **Google writes shared formulas too** | n/a | real export |
| Checkboxes | stay TRUE/FALSE (Excel 365 checkboxes reported) | written as plain booleans **without** a rule → restored as checkboxes, reported `checkbox` / converted | BOOLEAN rule | real exports (3 sheets) |
| Dropdowns | list rules | list rules (literal `"a,b"` and ranges), arrow shown | ONE_OF_LIST / RANGE | real export |
| "Is a valid date" rule | — | custom `OR(NOT(ISERROR(DATEVALUE(B2))), AND(ISNUMBER(B2), LEFT(CELL("format", B2))="D"))` → date rule | DATE_IS_VALID | real export (formula copied into the synthetic fixture; the 2.7 MB file is not committed) |
| Tables | built-in styles (`TableStyleMedium2`) carry no colours → reported | own `tableStyles` → static fills | `tables` reported | real export / synthesised |
| 1904 dates | `workbookPr date1904` → workbook `dateSystem: 'date1904'`, serials unchanged | never seen | n/a | Univer 1.4.0 core/engine-formula/numfmt read `dateSystem`; headless load test |
| Sheet names | as written | Google drops characters Excel forbids (`3. Show/Hide Data` became `3. ShowHide Data`); not detectable | as named | real export |

G19. **(verify live)** **Private files.** No private file was available, so how
Google answers one was not observed. Treated as "not shared by link"
(`gsheets_link_private`, 403): a redirect to `accounts.google.com` or a
`docs.google.com/ServiceLogin…` page, an HTML page (200), 401 and 403. 404 and
410 (observed for a missing and a deleted file) are `gsheets_link_not_found`.
A "not a spreadsheet" answer (a PDF, a Doc id) is `xlsx_not_xlsx`.

G20. **Fixtures: which are real.** Real (`packages/xlsx-import/test/fixtures/`):
`google-class-data.xlsx` (Google's own Sheets API sample, 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms),
`google-checkboxes.xlsx`, `google-dropdowns.xlsx`, `google-gantt.xlsx`
(public templates by benlcollins.com and a public Gantt sheet; ids in the
test file), and `libreoffice-from-google.xlsx` (one of them saved by
LibreOffice 24.2 here). **Synthesised:** `excel-fixture.ts` builds an Excel-
shaped file part by part (no Excel was available; openpyxl and LibreOffice
open it) and a small Google-shaped file for the API tests (workerd cannot
read files from disk). Phase 2 acceptance still needs the real NAF file.
Confirm the third-party sample files may stay in the repository.

G21. **`workbooks.source` stays `'gsheets'`** for both new paths: the D1 CHECK
allows only `blank | template | gsheets`, and changing it means rebuilding the
table. `source_ref` is the spreadsheet id (link) or `upload:<sha-256 of the
file>` (upload); `import_reports.gsheet_id` the same. The exact origin is in
the report (`source.origin`) and the audit (`workbook.import.xlsx` /
`workbook.import.gsheets_link`, with sha-256, sizes and detection evidence, no
cell content). Add `'xlsx'` with a table-rebuilding migration?

G22. **Limits** (to calibrate with the real file and the Worker's 128 MB):
file ≤ 15 MiB (`XLSX_MAX_FILE_BYTES`, shared with the web app; refused from
`Content-Length` before a byte is read, and again while reading); ≤ 2,000 zip
entries; one part ≤ 48 MiB and all parts read ≤ 96 MiB unpacked, **counted
while inflating** (a zip bomb stops at the limit whatever its headers say);
≤ 500,000 cells (as G5) and Σ rows × columns ≤ 1,000,000; download 30 s per
request, ≤ 3 redirects. Above a limit: 413, nothing stored.

G23. **Excel column widths use a maximum digit width of 7 px** (Calibri 11 and
Aptos Narrow 11 at 96 dpi). A workbook whose default font is much larger
gets narrower columns than in Excel. The default width without
`defaultColWidth` is 64 px.

G24. **Fonts.** The workbook's default font (Calibri/Aptos 11, Arial 10) is not
written on cells — size, family and colour equal to it are dropped, as the
Sheets API omits unset fields — so those cells use the grid's font (Thmanyah
via the web app) and Univer's default size. Every other font is kept as named
(gsheets-import OPEN §2 still open: map them to Thmanyah?). The default font
found is shown in the report.

G25. **Built-in number formats 14 and 22** ("system short date") are written as
`yyyy-mm-dd` / `yyyy-mm-dd h:mm` (spec §12.2). Locale-dependent built-ins
(5–8, 42, 44 currency; 27–36, 50–81 East Asian) carry no code in the file and
are reported as not transferred.

G26. **Fills.** Patterned fills become their foreground colour and gradients
their first stop; one workbook-level `cell_format` item says so. Diagonal
borders and indents are dropped (no Univer counterpart used yet); shrink-to-
fit is ignored.

G27. **Validation.** *(Superseded by G32 on 2026-11-11: whole numbers and text
length now have their own Univer rules.)* "Whole number" becomes Univer's decimal rule (the
whole-number restriction is lost); `time` and `textLength` rules are reported
as not transferred; `strict` = `showErrorMessage` with error style `stop`;
`showDropDown="1"` hides the arrow (§18.3.1.32 semantics).

G28. **Defined names.** A name local to one sheet becomes workbook-wide;
names whose value is a constant or a formula are reported; Excel's
`_xlnm._FilterDatabase` is skipped silently (bookkeeping); print areas and
titles are reported once.

G29. **Conditional formats.** Excel can apply several matching rules; the
converter gives every rule `stopIfTrue` (Google's first-match semantics), and
rules are ordered by Excel's `priority`. `cellIs` with a formula operand
becomes a custom formula on the range's first cell (`=D2<$D$7/10`). Data
bars, icon sets, top/bottom, above-average, duplicates and error rules, and
rules in the Excel 2010 `<extLst>`, are reported.

G30. **Filters.** The filter range is transferred; Excel's criteria are not
read (reported per column) and the rows they hid are shown again. Google's
export of filter criteria was not observed.

G31. **Other reported, never silent:** (pictures are imported since
2026-11-11, see "Images" I10–I14; only those that cannot be are reported) shapes, form controls and
charts in drawings; chart sheets; pivot tables (their values stay); Excel
tables (data and formats stay, formulas with structured references keep
their values); sparklines; sheet protection and protected ranges; outline
groups; macros (`vbaProject.bin`); links to other workbooks (formulas keep
their values); data connections; Excel 365 checkboxes; threaded comments (a
legacy note becomes a cell note). Smart chips in an export are plain text
(nothing marks them).

### Dropdowns and validation, complete (owner, 2026-11-11: «يجب دعم استيراد القائمة المنسدلة بشكل كامل»)

G32. **Every dropdown and validation feature, per origin.** Built 2026-11-11.
Sources read, not remembered: the Sheets API discovery document (revision
20261109: `DataValidationRule` = `condition`, `inputMessage`, `strict`,
`showCustomUi`, nothing else; tables have `columnProperties[].dataValidationRule`
for DROPDOWN columns); ECMA-376 §18.3.1.32–33 and MS-XLSX x14; Univer 1.4.0 in
`node_modules/@univerjs/{core,data-validation,sheets,sheets-data-validation,sheets-data-validation-ui,engine-render}`.
Univer behaviours the rules rely on are pinned by
`packages/gsheets-import/test/probe-dv.test.ts` (headless engine).
**Real** = a file Google wrote, exported 2026-11-11 from public sheets
(`packages/xlsx-import/test/fixtures/`: `google-dropdowns.xlsx`,
`google-dropdowns-advanced.xlsx` 1dUjG8hNj9BAT42xRucaXUmuJzbl6pxefz-8QQFcDdgU,
`google-colored-dropdowns.xlsx` 1lL8K942Vj67ESDgeqOKvCED3yo6IOqerSoP9fbG8JJc,
`google-table-dropdowns.xlsx` 1L6tJGLG2S1qrRY1n11RYgfnFnA0LLAox8PmfrBEBaD0, and
Google's rendering of them in `fixtures/htmlview/`); two more public exports
were inspected and not kept (Sheetrix task tracker, Spreadsheet Point
assignment tracker: plain lists plus authored conditional formats).
**Synth** = synthesised (`fixtures/excel-dropdowns.ts`; no Excel here).
**API** = hand-made `spreadsheets.get` responses (the OAuth path is unused).

| Feature | Excel .xlsx | Google export (.xlsx) | Sheets API | Univer 1.4.0 | Handling | Verified |
|---|---|---|---|---|---|---|
| Items typed in the rule | `type="list"`, `<formula1>"a,b"</formula1>`; the file always separates with `,` whatever the author's locale showed; `""` is a quote | the same | `ONE_OF_LIST` values | `list`, `formula1` = JSON array | exact; items trimmed | real (3 files) + synth |
| Range on the same sheet | `$K$2:$K$4` | `$I$6:$I20` (fixed for every cell) | `ONE_OF_RANGE` `=A2:A9` | `formula1` `=range`, evaluated | exact | real + synth + probe |
| Range on another sheet | `<extLst>` x14 rule, `<xm:f>` | plain rule, `'Sheet'!$A:$A` | `='Sheet'!A2:A` | evaluated, whole columns too | exact | real + synth + probe |
| Named range | `<formula1>Statuses</formula1>` + defined name | not seen | `=Name` | `=Name` evaluated (needs the defined name, G28) | exact | synth + probe |
| Dependent list (INDIRECT) | `INDIRECT($A2)`: relative, Excel moves it per cell | Google allows no formula in a range dropdown; its dependent lists read a FILTER-fed range (real) | — | INDIRECT evaluated, but **list formulas are not moved per cell** (`ListValidator.offsetFormulaByRange = false`, probe) | Excel-like files: one rule per cell with its own shifted formula, up to 2,000 cells per sheet (`DEPENDENT_LIST_CELL_LIMIT`), then the first formula + a report item; Google: one fixed rule (Google does not move it) | synth + probe; real (Google side) |
| Relative plain range (Excel) | `K2:K4` moves per cell | — | — | not moved | per cell, as INDIRECT | synth |
| Dynamic list (OFFSET) | `OFFSET(Lists!$A$1,0,0,COUNTA(Lists!$A:$A),1)` (x14) | — | — | evaluated | exact | synth + probe |
| Arrow shown or hidden | `showDropDown="1"` **hides** it (inverted name) | Google writes `showDropDown="1"` on its date-picker rule (real); on a "plain text" dropdown not observed | `showCustomUi` false | `renderMode` TEXT | hidden → TEXT (plain), else ARROW | synth; Google plain-text **(verify live)** |
| Display style chip / arrow / plain (Google) | — | **not in the file** (real) | **not in the API** | CUSTOM (chip) / ARROW / TEXT | public link: Google's own page `…/htmlview/sheet?gid=` draws every chip as a span → CHIP; without chips: ARROW. Upload: ARROW + one report item | real (pages + files) |
| Chip colour per item | — | **not in the file**: no conditional format, no dxf (real: green/amber/red chips of the Ablebits sample) | **not in the API** | `formula2` = colours aligned with the items by position; chip **text** colour is the cell's font colour | link: background read from the page (`#d4edbc` …; `#e8eaed` = none) → `formula2`; reported per rule: text colour not kept, and for range lists that colours follow position; items no cell shows have no known colour (reported by name); computed lists: not transferred, reported. Upload: one report item | real |
| Multiple selection (Google) | no such feature; a cell "a, b" stays invalid | plain list rule; the cell holds `Product B, Product D` (real); the page shows one grey chip | **no field**; same text in the values | `listMultiple` reads "a, b" (split on commas); a new pick is stored as JSON `["a","b"]` | Google origins: detected when a cell joins ≥ 2 items with commas and is not an item itself → `listMultiple`; values kept; reported (JSON form for new picks) | real + API + probe |
| Reject / warn (Google) | — | `showErrorMessage="1"` = reject; absent = warning (real) | `strict` | STOP rejects (dialog), WARNING accepts and marks the cell | exact | real + API |
| Error style stop / warning / information (Excel) | `errorStyle` | — | — | STOP / WARNING / INFO; INFO behaves as WARNING in the UI | stored as given; warning and information (Excel asks before accepting) reported | synth |
| No alert at all (Excel) | `showErrorMessage` absent | (means "warning" for Google) | — | invalid cells are marked | WARNING + reported | synth |
| Error title and message | `errorTitle`, `error` | not seen | — | shows `error` only (`errorTitle` stored, never shown) | `error` = "title: message", both stored | synth |
| Help text / input message | `prompt`, `promptTitle` (`showInputMessage`) | not seen in the real files **(verify live)** | `inputMessage` | stored, **never shown** (nothing reads `prompt`) | stored; **apps/web shows it** when the cell is selected (`src/editor/validation-prompt.ts`, Univer's cell alert) | synth + API + e2e |
| Blank allowed | `allowBlank` | always `1` (real) | always allowed | `allowBlank: false` marks every empty cell invalid | always `true`; Excel's "Ignore blank" off reported **(OPEN, below)** | synth |
| List from a Google table column | — | `<formula1>#REF!</formula1>` (real) | `tables[].columnProperties[].dataValidationRule` | — | not transferred, reported with the reason (values stay) | real |
| Whole number / text length / time (Excel) | `whole`, `textLength`, `time` | — | — | `whole`, `textLength` validators exist; no `time` validator | whole → `whole`, text length → `textLength` (G27's decimal fallback and its report are gone); time reported | synth + probe |
| Coloured dropdown column by conditional format | `cellIs` rules (authored) | `cellIs equal "Completed"` rules (real, Sheetrix) | `booleanRule` | conditional formatting | transferred as conditional formats (G29), independent of chips | real |

What Univer 1.4.0 cannot do, and what the import does instead: per-item chip
**text** colour (cell font colour); a colour tied to an item's **text** in a
range list (it is tied to its position); moving a list formula per cell
(per-cell rules); showing the input message or the error title (the app shows
the message; the title is folded into `error`); a TIME rule; asking "continue?"
on invalid input (Excel warning / information: accepted and marked); a
multiple pick in Google's `a, b` form (Univer writes JSON).

**In the RTL grid** (checked in Chromium on the apps/web e2e,
`test/e2e/dropdowns.test.ts`, and the univer-rtl interaction suite, sheet
«قوائم» of the harness): chips sit at the cell start (visual right) with the
arrow at the end; their Arabic text is painted per line through the layer's
`fillText` flip-back with the first-strong direction, glyph for glyph as in
the unmirrored grid; a multiple selection's chips read from the start; the
list opens under its cell aligned with its right edge, with the item colours;
a multiple list opens from its arrow (the 14 px at the cell's end, its visual
left) as in stock Univer; the help text opens beside the cell, towards the
next column. **Fixed in `packages/univer-rtl`:** Univer's "vertical" popup was
mirrored to "vertical-right", which Univer resolves by the roomier side, so a
list in the lower half of the screen opened above its cell although it fitted
below (seen at 375 px). Now "bottom-right" when the room below is at least
`MIRRORED_POPUP_ROOM` (320 px, the tallest cell popup), else "vertical-right"
(`mirroredVerticalDirection`). The choice is made when the popup opens; a
popup kept open while scrolling keeps it **(OPEN)**. Not RTL: in a narrow
column a multiple selection's chips wrap onto two lines and Univer does not
grow a row whose height the file fixed (Google's 21 px rows), so the second
line is clipped — as in the unmirrored grid.

**Sync columns** (task: leave them alone). Nothing in the link wizard or the
sync engine reads or writes validation rules; `ensureSystemColumns` adds the
hidden columns after the last used column and does not touch the workbook's
rules (`packages/sheet-model/test/imported-dropdowns.test.ts`). An imported
status list is read through `completedValues` as before; an assignee column
with Google's multiple selection reads both `a, b` and Univer's JSON
(`splitAssigneeText`); a rule wide enough to cover the system columns' cells
changes nothing (hidden columns; the server writes them as plain values).

**Decisions taken as the safest, open for the owner:**
- **(owner)** Excel "Ignore blank" off: blanks stay allowed (else Univer marks every empty cell of the range with a red triangle). Reported per rule. Keep, or honour it?
- **(owner)** A Google multiple-selection dropdown none of whose cells holds two items is not recognisable (no file, API or page marks it): it imports as a single list.
- **Decided (owner, 2026-11-11: «نعم»): accepted.** Univer stores a new multiple pick as `["a","b"]`, not Google's `a, b`; formulas that split such cells on ", " stop matching after an edit. Kept as Univer writes it (no hook); the import report still says so.
- **(verify live)** Google's htmlview page is not an API. It is read defensively (no table, no chip → nothing; any non-200 → a report item, the import goes on). If Google changes it, colours and the chip style silently fall back to arrow and grey **and the report says they could not be read** only when the page is unreadable, not when it reads but looks different. Re-check with the real NAF file.
- **(owner)** Fetching htmlview makes 1 + (sheets with dropdowns, ≤ 20) extra requests to docs.google.com per link import (audited as `renderingRequests`); pages ≤ 8 MiB each (`DEFAULT_RENDERING_LIMITS`).
- **Decided (owner, 2026-11-11: «نعم تبقى»):** the new real fixtures (three Google exports and seven htmlview pages of public third-party samples) stay in the repository, like G20's.
- An item colour chosen as Google's default grey (`#e8eaed`) is read as "no colour".

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

S10. **Decided 2026-11-11 (owner): `PUBLIC_API_ORIGIN = "https://sheets.naflaw.sa"`**
    (spec §17-4), the HTTPS origin in the webhook `payload_url`. The web app
    (Pages) and this Worker share the host; the Worker's routes are in
    wrangler.toml (docs/cloudflare-setup.md §6). Original note: until it is
    set, no webhook is registered and reconciliation carries the inbound sync alone.

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
    A change made in «أعضاء المنصة» closes the person's connections
    (`WorkbookRoom.disconnectUser`, close code 4403, not fatal), so the client
    reconnects at once under the new access (see P4). A change made directly in
    D1 still waits for the next connection.

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
    within the 30 days (no route for it yet). The picture clean-up of I9 does
    not touch these files (only `workbooks/{id}/images/…`).

P5. **Removing a chip of a to-do deleted or archived in Basecamp**, or of a
    subtask / local row: only the platform's chip goes; Basecamp is not called.
    (A notes picture removed from its cell of such a to-do changes nothing at
    all, its chip included: "Images" I7.)

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
Tests: `test/phase7/` (23). Load test: `test/load/api-load.load.ts` (docs/load-test.md).

T1. **Decided 2026-11-10 (owner): a template is a frozen copy taken at
    creation time** — the behaviour already built. Original note: **A template is a frozen copy** of the source workbook's latest saved
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
    kept. No per-system scopes, no expiry. (§17-3 is decided — I3 — so this
    stays as built.)

I2. **The optional outbound webhook** («Webhook صادر اختياري لأحداث: مهمة
    أُنجزت، مهمة تأخرت») is **not built**: no receiving system, URL, signing or
    "became overdue" trigger is specified, and §17-3 is decided with no system
    to receive it (I3). Nothing is sent anywhere.

I3. **Which other NAF systems connect (§17-3)** — **decided by the owner,
    2026-11-10: none need to connect.** The internal API stays as built
    (read-only `/api/v1`, admin-issued service tokens, I1), serving whoever
    holds a token; no system-specific integration or outbound webhook (I2) is
    planned.

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

B2. **Decided 2026-11-10 (owner): retention.** Keep the newest 30 complete
    runs plus the first complete run of each of the last 12 calendar months;
    both numbers are settings (`PUT /api/admin/backups/retention`, KV
    `settings:backup-retention`, shown and edited on «صحة المزامنة»). Built in
    `src/phase7/retention.ts`, applied at the end of a run that succeeded,
    after its manifest is read back: an incomplete run (failed, running, no
    manifest) is never a keeper; only the BACKUPS bucket is touched, only
    under `d1/{pruned run}/` and snapshot copies no remaining run lists; each
    removal is written to `audit_log` (`backup.prune`,
    `backup.prune.snapshot_copies`) before it happens, and the run's row keeps
    `pruned_at` / `pruned_objects` / `pruned_by_run` (migration 0006). No D1
    row is ever deleted. Tests: `test/phase7/retention.test.ts`.
    Original note: nothing is ever deleted, so the bucket grows daily.

B3. **Decided 2026-11-10 (owner): backups stay in the same Cloudflare
    account**, bucket `naf-sheets-backups`.

B4. **Not backed up**: the ATTACHMENTS bucket and KV (sessions, settings).
    §14 names R2 snapshots and D1 only.

B5. **Snapshots copied**: the latest version of each live workbook and each
    live template, daily; older versions stay in SNAPSHOTS (never deleted) and
    are listed in the run's inventory.

B6. **Reading of the retention rule** (to confirm): "the last 30 daily runs"
    is read as the 30 newest *complete* runs (one a day under the daily cron;
    an extra run on the same day takes a slot); calendar months are UTC (a
    run at 00:23 UTC has the same date in Riyadh). A run still `running` more
    than 24 hours before the newest one is treated as dead and its partial
    files removed; a `skipped` run wrote nothing and is left alone.

B7. **Snapshot copies made before the per-run lists existed.** Since this
    change each run writes `d1/{run}/snapshot-copies.ndjson` (the copies it
    relies on), and a copy is removed only when no remaining run lists it.
    While any complete run without such a list remains, no snapshot copy is
    removed at all (`snapshotCopies: 'kept_legacy_runs'`). Copies made only
    by those older runs are listed by no run, so they are never removed
    automatically; removing them would be a separate, approved cleanup.

L1. **Load test scope** (docs/load-test.md): local Miniflare and an
    in-process fake Basecamp; not Cloudflare, not Basecamp. Timings inside
    workerd come from `Date.now()`, which advances at I/O only. The spec gives
    no target numbers for phase 7, so nothing is judged pass/fail on speed;
    the assertions are correctness (every task created once, all `synced`).

L2. **Done 2026-11-10 (owner request): one workbook load per batch.** The
    `bc-outbound` consumer groups a batch by workbook, loads its state once
    and, before each task, re-reads only what may have changed since
    (`refreshForTask`: the snapshot when a save moved it on, the sheets and
    mappings, the task's family rows and their assignees). Per message,
    unchanged: its task lease, its actor's token, its own retry / dead
    letter. A repeat of the same task by the same actor in one batch is
    acknowledged without a second step (the step sends the row as it is).
    `max_batch_size` 10 → 50. The names directory (people caches) is read
    once per batch. Before/after in docs/load-test.md. Original note: each
    outbound message loaded the whole workbook (115 ms per task locally for a
    3,500-row workbook against 34 ms for a 100-row one).

L3. **Done 2026-11-10 (owner request).** The cron run holds a lease
    (`sync_jobs`, migration 0006: a run that finds it held does nothing) and a
    12-minute budget: it stops between two lists and stores where; the next
    run continues from there. A to-do is read one by one only when its list
    entry shows a change: `updated_at` or a counter moved *and* the entry is
    not already what the row holds (`confirmedByList`, for synced to-dos
    without subtasks). That removed the reads the old first run spent on
    every completed to-do (a completion answers 204 without `updated_at`).
    Rate limit: 45 requests in any 10 s, platform-wide (`BasecampRateGate`).
    Before/after in docs/load-test.md. Original note: the first
    reconciliation after linking ten large workbooks read 7,701 times (about
    32 min at 4 requests/second, longer than the 15-minute cron).

L4. **Live test: list entries carry every field of a single to-do.**
    `confirmedByList` trusts the entry of `GET /todolists/{id}/todos.json`
    (todos.md's "Get to-dos" example shows description, assignees,
    completion subscribers, counters, steps). If real entries lacked a field,
    a change to it alone would wait for the next change that moves the
    to-do's own content. A to-do with subtasks is always read when its
    `updated_at` moves, because a subtask's change may show only there.

L5. **No ETag is stored at linking.** The wizard reads a list's to-dos only
    for `match_by_title`, with the linking person's token (the ETag cache is
    scoped to the service token: entries differ by token, e.g. redacted
    emails), and the creation of the rows that follows changes every list
    and so every ETag. What the first reconciliation needs from linking and
    creation is the per-row state (`updated_at` from each create, subtask
    and comment counters), which is stored; the list pages themselves are
    read once (700 pages for 10 × 7 × 500 at the fake's 50 per page), then
    answer 304. Store the wizard's reads anyway?

L6. **The rate gate's window is in memory.** `BasecampRateGate` keeps the
    last 45 grants in memory; it is evicted only after being idle (by then
    the 10 s window is empty), but a reset while requests flow (a deploy)
    starts an empty window, so one extra burst of up to 45 is possible at that
    moment. Keep it in the object's storage instead (one write per request)?
    If the gate does not answer, an isolate falls back to its own window.

L7. **Queue concurrency.** `max_batch_size` is 50; `max_concurrency` is left
    at Cloudflare's default. Concurrent consumer invocations share the rate
    gate, so they cannot exceed the limit together, but they do compete for
    it. Limit `bc-outbound` to one invocation at a time?

## Dashboard and appearance (src/dashboard)

D1. **What the figures count.** Completion counts to-dos (level 0) still active in Basecamp, like the files list (#6). Overdue, this week, the timeline and the per-assignee counts count every row (to-dos and subtasks); a to-do whose assignees are the automatic union of its subtasks' (§8.1, `assign_mode = auto` with subtasks) is not counted again for those people. Names in the assignee cell that match nobody are counted under their text (`unmatched`). Rows deleted in Basecamp are left out. Confirm.

D2. **"This week"** is Sunday to Saturday in Asia/Riyadh time (`dayOf` of the internal API, I4); «مستحقة هذا الأسبوع» is from today to Saturday, not completed. The timeline groups due dates by the same weeks and shows at most 16 around this week.

D3. **One range per link.** A figure over rows that are not adjacent (a person's tasks, a group of a widget) links to the bounding range of those cells in the sheet holding most of them, so rows between them are selected too. A multi-range deep link would need the editor's `?range=` to take a list.

D4. **Widgets.** `count` counts non-empty cells (text included); `sum`, `average`, `min`, `max` read numbers only (numeric text such as «1,250» or Arabic-Indic digits counts as a number). A formula cell counts with its stored computed value (`v`); one with none yet is reported as uncomputed, never evaluated on the server. Groups keep first-appearance order, at most 50. A range is refused above 200,000 cells. At most 40 widgets per workbook. A removed widget keeps its row (`removed_at`); nothing is deleted. Widgets are not copied into templates.

D5. **Activity** shows the 20 newest `sync_log` rows of the workbook, leaving out webhook deliveries the platform ignored (`status = 'ignored'`).

D6. **Cost.** GET …/dashboard reads the latest snapshot and every row on each call (the dashboard polls every 30 s while shown, and after each commit). Fine at the platform's size (docs/load-test.md); a cache keyed by snapshot version if it grows.

D7. **Migration number.** `0007_dashboard.sql` was the next free number on 2026-11-10; if another branch adds a 0007 the later one must be renumbered before merging.

D8. **Appearance** is stored in KV `SETTINGS` under `settings:appearance` (palette overrides only, `#rrggbb`); every change is in `audit_log` (`settings.appearance`). Reading it needs a signed-in member; changing it needs a platform admin. **The calm palette is approved as the platform's look (owner, 2026-11-10)**: `apps/web/src/styles/theme.css`, adjustable through «المظهر».

D9. **The dashboard is the workbook's first sheet tab «اللوحة»** (owner, 2026-11-10; apps/web #66). It is a real Univer worksheet, marked by platform data in its `custom` field (`nafSheetRole: 'dashboard'`, never by name or id), kept first in `sheetOrder` (`@naf-sheets/shared` dashboard-sheet.ts). The API adds it with `withDashboardSheet` when it serves a workbook (GET /api/workbooks/:id) and the room adds it with the same deterministic function when it loads one (room.ts `load`), so an editor that opened from the GET holds the same model as the room; blank workbooks, workbooks from a template and Google imports are created with it. It is never in D1 `sheets`: the files list, the link wizard, sync detection, /api/v1 and backups (D1 export) never see it, and backups copy snapshots byte for byte. Templates drop it and re-create it on instantiation. The figures and widgets skip it (a widget naming it is `sheet_missing`). sheet-model refuses it (`dashboard_sheet`) in `readTasks`, `ensureSystemColumns`, `applyInbound`, indentation, decoration and reordering. The room refuses any op that would remove, rename, hide or move it, put a sheet before it, insert a second one, or write its cells, properties or plugin data (footprint.ts `classifyOp`, as `invalid`); row heights and column widths on it pass. PUT …/snapshot stores what the editor sends unchanged (the editor always sends it); a snapshot saved without it is given it again on the next read. Confirm that a stored snapshot may lack it until its next save.

## Platform members «أعضاء المنصة» (src/routes/platform-members.ts)

**Decided 2026-11-11 (owner): P1–P7 approved as built.** Admins are equal: no
owner rank, and any admin may demote another (the self and last-admin guards
stay). A suspension stops access only, and leaves the Basecamp link, the
tokens and queued edits as described in P5.

P1. **Who may change what.** Platform admins only (403 `forbidden` in the route
    for editors and viewers). Any admin may demote or suspend another admin;
    there is no "owner" above admins. An admin cannot change their own role or
    state (409 `cannot_change_self`); the last active admin can never be
    demoted or suspended (409 `last_active_admin`, checked again inside the
    UPDATE so two admins demoting each other at once cannot both win). Confirm
    that every admin may demote other admins.

P2. **Effect.** naf-auth reads `members.role` and `members.is_active` on every
    protected request (`getMember`, no cache in the session or KV; verified by
    test/members-session.test.ts through the real middleware), so a change
    applies from the person's next request: suspended → 403 `access_denied`
    (`reason: inactive`); a demotion caps every workbook role (access.ts). The
    naf-auth session in AUTH_KV is not deleted on suspension; it is refused per
    request and ends with naf-id's session.

P3. **naf-id report** (naf-auth `reportAccessChange`): `role` on a role change,
    `state: revoked` (reason «أُوقف من إعدادات المنصة») on suspension, `granted`
    on reactivation, in one call when both change. Best effort: the local
    change stands; the response says `sent | failed | skipped` (skipped = no
    email, naf-id matches by email) and a failure is logged by code only. No
    retry: naf-auth re-reports the role at the person's next sign-in, but not
    the state. Should a failed report be queued and retried?

P4. **Open realtime connections** are closed after a change, in every live
    workbook the person owns or is a member of (every live workbook if they
    were an admin). Best effort (`waitUntil`).

P5. **Not touched by a suspension:** the person's Basecamp link and tokens,
    workbooks they own, their workbook seats, and `bc-outbound` messages
    already queued with their token (those still go out). Confirm whether
    suspension should also stop their queued writes or revoke their Basecamp link.

P6. **Audit.** One row per change, `member.access.update`, entity `member`,
    details `{ from: { role, active }, to: { role, active } }`, written in the
    same batch only when the UPDATE changed the row. The naf-id outcome is not
    in the audit log (it happens after the commit); it is in the response and the log.

P7. **Basecamp match column** is read from `bc_person_matches` and the account
    people cache as stored (`storedMatches`, basecamp-link/people.ts): no
    Basecamp call and no automatic matching on this screen, so a new member
    shows «غير مطابَق» until the people-matching screen (which refreshes and
    matches by email) has been opened. States: auto (email), manual, declined
    (admin recorded no person), none.

## Images

Owner, 2026-11-11: «دعم اضافة صورة وكذلك استيرادها بحيث تكون على الخلية ولا
تؤثر على بيسكامب، إلا اذا كانت داخل خلية فتكون تابعة لها مثل الملاحظات ونحوها
بشرط دعم بيسكامب لها في الخانة». Code: `src/images/` (routes, store, import,
notes pictures), the room (`src/room/engine.ts`, `footprint.ts`), sync
(`src/sync/detect.ts`, `state.ts` `diffLocal`, `outbound/consumer.ts`), the
backup (`src/phase7/backup.ts`); sheet-model `src/cell-images.ts`;
`@naf-sheets/xlsx-import` `src/images.ts`, `src/import-images.ts`;
`@naf-sheets/gsheets-import` `src/images.ts`; `@naf-sheets/shared`
`src/api-images.ts`; the editor `apps/web/src/images/` (apps/web
`OPEN_QUESTIONS.md` I1–I8); the RTL layer (I15). **Nothing here ran against
real Basecamp** (as P18): the fake Basecamp only.

I1. **Univer packages.** Univer 1.4.0's drawing packages are open source
    (Apache-2.0, checked in each installed `package.json`) and were already in
    the lockfile through the RTL harness: `@univerjs/drawing`, `drawing-ui`,
    `docs-drawing`, `sheets-drawing`, `sheets-drawing-ui`, and
    `@univerjs/preset-sheets-drawing`, which registers them. Added at exactly
    1.4.0: `@univerjs/preset-sheets-drawing` to apps/web, `@univerjs/drawing`
    and `@univerjs/sheets-drawing` (model only, no UI) to apps/api;
    `npm run check:pins` passes. In-cell pictures are part of the open-source
    sheets-drawing-ui («صورة خلية», `InsertCellImageCommand`): a cell document
    with a drawing, no Pro package. The editor uses Univer's own «إدراج ← صورة»
    menu («صورة عائمة» / «صورة خلية») and its image service is replaced by one
    that uploads to the platform (apps/web I1). The worksheet background
    picture is hidden and refused (its mutation is not in the room's list).

I2. **Storage and access.** A picture is stored once in R2 `ATTACHMENTS`
    under `workbooks/{workbookId}/images/{imageId}` (32 hex) with its
    recognised type and the uploader, create-only; the snapshot keeps only
    `/api/workbooks/{id}/images/{imageId}` (`imageSourceType: URL`), never
    base64. `POST /api/workbooks/:id/images` (raw body, `Content-Length`
    required, ≤ `IMAGE_MAX_BYTES` = 10 MiB, refused before a byte is read when
    declared larger, counted while reading otherwise) accepts **PNG, JPEG, GIF
    and WebP, recognised from the bytes**; SVG (script risk), BMP, HTML and
    anything else answer 415 `image_type_not_allowed`, whatever the declared
    type. Editors and admins only: a viewer gets 403 `forbidden`; someone
    outside the workbook 404. `GET …/images/:imageId` serves the picture to
    anyone who may open that workbook (404 `image_not_found` otherwise, and for
    an id of another workbook), with `X-Content-Type-Options: nosniff`,
    `Content-Security-Policy: default-src 'none'; sandbox` and
    `Cross-Origin-Resource-Policy: same-origin`. Every upload is audited
    (`image.upload`: size, type, sha-256). **Open:** the API's `no-store`
    header applies (every page load reads the pictures again); the limit of
    10 MiB is this module's choice (Univer's default is 5 MB).

I3. **The room.** `sheet.mutation.set-drawing-apply` (insert, move, resize,
    order, group and remove of floating pictures: one json1 op on the sheet's
    drawings) is accepted as `resource` data of one sheet: footprint key
    `drawing:<sheet>`, so two people's picture edits on one sheet are
    serialised and a picture edit never conflicts with cell edits. The headless
    room registers `UniverDrawingPlugin` and `UniverSheetsDrawingPlugin`
    (model only), so the room's saves keep resource `SHEET_DRAWING_PLUGIN`
    (without them the first save would have dropped every picture). A picture
    in a cell is cell content (`set-range-values`). `sheet.operation.clear-
    drawing-transformer` (type MUTATION, params an array) is never sent by the
    adapter (params not an object); the background-picture mutation is
    refused. The dashboard sheet «اللوحة» refuses the drawing mutation like any
    plugin data (`dashboardMutationProblem`), and the editor refuses the insert
    commands there before anything is uploaded. Viewers' ops are refused as
    before. Drawing mutations never touch a task row: detection reads the
    snapshot's rows, and floating pictures live in a plugin resource, so
    outbound sends nothing (tested: insert, move, remove → no message, no
    Basecamp write).

I4. **Per column: can the Basecamp field hold a picture?** (spec §8 table,
    Appendix A; `basecamp/bc-api` rich_text.md: a to-do's `description` is rich
    text whose `<bc-attachment sgid>` elements carry files; `content`, people,
    dates and completion are plain values; subtasks have only `title`,
    `due_on`, `assignees`, `completed`, `position`.)

    | Column (mapping) | Basecamp field | Picture inside the cell |
    |---|---|---|
    | المهمة (`title`) | to-do `content` / subtask `title`: plain text | **skipped**: the text beside it is the title; a cell holding only a picture keeps Basecamp's title (I5) |
    | المسؤول (`assignees`) | `assignee_ids` | **skipped**; picture-only: the stored assignees stay |
    | تاريخ البدء (`starts_on`) | `starts_on` (to-do only) | **skipped**; picture-only: Basecamp's date stays |
    | تاريخ الاستحقاق (`due_on`) | `due_on` | **skipped**; picture-only: Basecamp's date stays |
    | الحالة (`completed`) | completion endpoint | **skipped**; picture-only: Basecamp's state stays |
    | ملاحظات (`notes`), to-do | `description`: rich text, takes attachments | **sent as a file of the description** (phase 5 path, I6); the cell's text stays the person's part of the description |
    | ملاحظات (`notes`), subtask | none (no description) | **kept in the platform** |
    | المرفقات (`attachments`) | files of the description | display-only cell (P13): a picture there is skipped |
    | free column, «إلحاق بالوصف» | a line of the managed block (text) | **skipped**; the line carries the cell's text (I17) |
    | free column | none | stays in the platform |
    | floating picture (any column) | none | never sent (I3) |

    "Skipped" is never a sync error, never a conflict, never clears the field,
    and the cell keeps showing its picture.

I5. **Picture-only cells follow Basecamp.** A picture is never text
    (sheet-model `cellText` leaves its placeholder out). A mapped cell holding
    only pictures is marked image-only (`imageOnlyFields`) and its field takes
    the synced base's value in every diff (`withImageOnlyFieldsFromBase` in
    `diffLocal`); assignees keep the stored ones. So nothing is sent and
    nothing cleared, and a change made in Basecamp later is still applied
    (inbound writes the text next to the picture). A row not in Basecamp yet
    (no `bc_recording_id`) whose title is only a picture is still
    `empty_title` (a to-do cannot be created without a title); a row with no
    text title never receives a uid anyway. **Open:** the row's fingerprint
    changes when the text is replaced by a picture, which moves
    `last_local_change_at` (LWW timestamp) although nothing is sent.

I6. **Notes pictures → files of the description.** After a commit, detection
    (`notesImagesOf`, `tasksWithUnsentNotesImages`) finds to-do rows whose
    notes cell holds a picture of this workbook never sent before (no
    `attachments` row with key `attachments/{wb}/{uid}/cell-image-{imageId}`,
    removed or not) and queues the task with the person whose edit touched the
    row (spec §3; never the server). The `bc-outbound` consumer, after the
    task's step and **outside its lease** (the description write takes the
    lease itself), copies the picture into that key, inserts an `attachments`
    row (origin `local`, `uploading`, created by that person) and runs phase
    5's `sendToBasecamp` unchanged: upload with the person's token,
    `<bc-attachment>` added to the description, `attached`, or `failed` with
    the Arabic reason and «إعادة المحاولة». A file a person removed from the
    chips is not sent again while the picture stays in the cell. Only pictures
    of the same workbook (`parseImagePath`) are sent; a copied URL of another
    workbook, a data URL or an external address is skipped. The to-do must be
    synced, active and in a synced sheet (`fileMode` = basecamp). The
    attachments cell then names the file.

I7. **Decided (owner, 2026-11-11: «نعم تحذف») and built: a picture removed
    from a to-do's notes cell leaves its description in Basecamp.**
    Verified against `basecamp/bc-api` (sections `rich_text.md`, `attachments.md`,
    `todos.md`, read 2026-11-11): a file in a description is not a recording
    of its own but the `<bc-attachment sgid>` element in the rich text, whose
    `sgid` is the `attachable_sgid` `POST /attachments.json` returned (phase 5
    put it there with `changeTodoDescription` add, at the end of the person's
    part, I6); `description_attachments` merely lists those elements; there is
    no endpoint that deletes an attachment. So removal = the next
    `PUT /todos/{id}.json` without that element, which carries every field
    ("Omitting a parameter will clear its value", todos.md). Built on phase
    5's removal path (`changeTodoDescription` remove, the attachment editor's
    P4/P5 path): `src/images/notes-images.ts` `syncNotesImages`, run by the
    outbound consumer after the task's step (as I6), on the **latest committed
    snapshot**. Rules:
    - only the sgid the platform recorded for that picture (the `attachments`
      row keyed `attachments/{wb}/{uid}/cell-image-{imageId}`, origin `local`)
      is removed; another file, a file attached in Basecamp, a mention, the
      managed block are sent back byte for byte;
    - with the token of the person whose edit removed it (detection's
      attribution, spec §3); without a usable link nothing is sent (logged
      warning; retried with the row's next change);
    - the description exactly as read is logged first (`sync_log`
      `detach_file_snapshot`, `old_value`), then the PUT, then the chip is
      marked removed (`removed_reason = 'notes_image'`, migration 0008; R2 copy
      kept, `purge_after` +30 days as P4) with audit `attachment.remove_notes_image`;
    - a to-do trashed, archived or not reachable in Basecamp: nothing is sent,
      no error, the chip stays (`fileMode` refused, or `task_deleted_remotely`
      / 404 on the fresh read);
    - a file still `uploading` is left for its outcome; a `failed` one never
      in Basecamp (no sgid) only loses its chip;
    - floating pictures never reach Basecamp (I3), so removing one sends
      nothing; a picture removed from any other column sends nothing (I4).
    **Confirmation: none, by choice** (the safest *consistent* behaviour,
    open for the owner): row deletion asks because Basecamp's deletion is
    destructive (§9.2.7); here nothing is destroyed — the file stays in the
    platform (chip archived, R2 copy, the original picture), the old
    description is logged, and the removal is reversible from the sheet:
    an undo **before the save** never reaches the server; an undo after the
    save but **before the queue runs** sends nothing (the consumer reads the
    latest snapshot); an undo **after** it puts the same file back
    (`<bc-attachment sgid>` re-added, or already re-added by the notes cell's
    own stored description, P11 — the inbound extraction then revives the
    platform's row instead of making a second chip). A file removed with the
    attachment editor (§10, confirmed) or in Basecamp is never sent again
    while its picture stays in the cell (I6, unchanged). **(verify live, I20)**:
    putting a removed `sgid` back into the same description is not documented
    either way (rich_text.md only forbids reusing an attachment in another
    record); the notes cell's undo already relied on it (P11).
    **Open:** changing which column is the notes column (link settings) reads
    the old column's pictures as removed and takes their files out of the
    description (reversible as above). Tests: `test/images/notes-remove.test.ts`.

I8. **Inbound never removes a picture.** Every inbound write goes through
    sheet-model `writeValue`, which, for a cell holding pictures, keeps them
    (`withImagesKept`): the pictures first, then Basecamp's text as plain
    paragraphs, `v`/`t` kept for readers of the value (checkbox, status). A
    date written into a picture cell is `YYYY-MM-DD` text. The text's own
    formatting in such a cell is not kept. The same value twice is
    `unchanged` (no server change).

I9. **Decided (owner, 2026-11-11: «نعم نظف») and built: a daily clean-up of
    picture files nothing refers to.** `src/images/cleanup.ts`, run by
    `runBackup` after a successful backup and its retention policy; operators'
    description in docs/backups.md §7 (B8). Rules: only `ATTACHMENTS` keys
    `workbooks/{id}/images/{imageId}` (phase 5 files, including notes-picture
    copies, are **not** touched: P4 stays open); a picture is deleted only
    when (1) no stored snapshot refers to it — every object in `SNAPSHOTS`
    (every version of every workbook, templates; versions are never deleted)
    and every `snapshots/…` copy in `BACKUPS` whose original is missing; a
    reference is the id after `images/` anywhere in the text, whatever
    workbook it names; (2) every snapshot written after its upload (minus a
    day) has been read (`image_ref_scans` / `image_refs`, migration 0008; each
    immutable snapshot is read once, ≤ 2,000 objects / 256 MiB per run,
    newest first); (3) it was uploaded more than **30 days** ago
    (`IMAGE_CLEANUP_GRACE_DAYS`); (4) its workbook is not archived (no row =
    a failed import: allowed); (5) the backup bucket holds its copy. At most
    200 deletions per run, oldest first; each logged to `audit_log`
    (`image.cleanup`) before the delete; the outcome in
    `backup_runs.details_json.imageCleanup`. **Backups keep removed
    pictures** (`images/…` in `BACKUPS` is never deleted): the safest reading,
    **(owner) confirm**. Consequence: since snapshot versions are kept
    forever, a picture that was ever saved stays forever; what goes is what
    never reached a saved version (undone inserts, failed imports, uploads
    never inserted). Not read: the room's op log (not a restorable version;
    the room saves within 10 s). Tests: `test/images/cleanup.test.ts`.

I10. **Import, floating pictures** (`xl/drawings`, both origins). Anchors →
    Univer `anchorType`: `twoCellAnchor` (default) → `1` (moves and sizes with
    cells); `editAs="oneCell"` → `0` (moves only); `editAs="absolute"` and
    `absoluteAnchor` → `2` (neither, position in pixels; reported `converted`
    for `absoluteAnchor`); `oneCellAnchor` → `0`, size from `ext`. EMU / 9525
    = pixels. `transform` is computed with Univer's header sizes (46 × 20 px)
    and the converted column widths and row heights; Univer recomputes it from
    `sheetTransform` when it draws, except for anchor `2`. Alt text: `title`,
    `descr`. Pictures inside a group shape are reported as shapes (sheet.ts).

I11. **Import, in-cell pictures.** Excel 365's "Place in cell": `vm` cells →
    `xl/metadata.xml` (`XLRICHVALUE`) → `xl/richData/rdrichvalue.xml`
    `_localImage` (`_rvRel:LocalImageIdentifier`, `Text` as alt text) →
    `richValueRel.xml` and its rels → `xl/media`. The cell becomes the
    document Univer's own cell-image command writes (sheets-drawing-ui
    `_insertCellImage`), sized to fit the cell; its `#VALUE!` placeholder value
    goes, its style stays. A `_webimage` (the cached picture of `IMAGE(url)`)
    has no bytes in the file: **reported, never fetched** (the server loads no
    pictures from the internet; SSRF and privacy). An `IMAGE()` formula keeps
    its current treatment (value and a note, "Google import" `imageFormula`).

I12. **(verify) Google's export.** 111 public Google Sheets were exported on
    2026-11-11 (ids found on GitHub); 16 exports held pictures, every one an
    `oneCellAnchor` with `ext` and `editAs` absent, PNG or JPEG in `xl/media`.
    Real fixtures: `packages/xlsx-import/test/fixtures/google-floating-image.xlsx`
    (public "Polyglot Gamedev" master sheet, 17f0dQawb-s_Fd7DHgmVvJoEGDMH_yoSd8EYigrb0zmM)
    and the existing `google-checkboxes.xlsx`. **No export held an in-cell
    picture or `vm` cells, so how Google writes "image in cell" was not
    observed**; the reader handles Excel's rich data whatever the origin. The
    Excel side (all anchor kinds, rich data, a web picture, EMF) is
    **synthesised** (`test/fixtures/excel-pictures.ts`): no Excel was available.

I13. **Import limits.** At most 200 pictures and 40 MiB of picture bytes per
    file (`MAX_IMPORTED_PICTURES`, `MAX_PICTURE_BYTES_TOTAL`), each ≤ 10 MiB
    and of an accepted type; a part used several times is stored once. The
    rest is reported, the import goes on. To calibrate with real files.

I14. **The report.** `counts.floatingImages` / `counts.cellImages` (optional:
    absent in reports stored before 2026-11-11) count what was imported; only
    pictures not imported are items (`drawing_image` / new `cell_image`,
    `not_transferred`, with the reason: type, size, missing, external, limit),
    plus `converted` for an absolute picture. The web report shows both counts
    when present.

I15. **The RTL grid layer** (`packages/univer-rtl`). Checked in Chromium on
    the harness: the picture is drawn not mirrored (existing check); its start
    (visual right) edge and top sit on its anchor cell; a click selects it as
    in the unmirrored grid at the mirrored point; the selection handles are
    drawn around it where it is; dragging two columns to the visual left
    anchors it two columns later; dragging the visual-left middle handle widens
    it and keeps its start edge. All by construction (the flipped canvas, mouse
    hit testing in the element's own coordinates), with no new hook. **Found
    and fixed:** the image menu opened on the picture's start side: Univer
    1.4.0 already asks `'left'` for a right-to-left UI
    (`DrawingPopupMenuController`), and the layer mirrored it again. The layer
    now keeps the side of the popups listed in `RTL_AWARE_POPUPS`
    (`COMPONENT_IMAGE_POPUP_MENU`), and `test/images-contract.test.ts` checks
    that Univer's source still asks for it. 6 checks added to the interaction
    suite (now 65 with the other changes in progress).

I16. **Found and fixed: a cell document without its document style blanks
    the grid.** Univer 1.4.0's cell renderer writes into
    `documentStyle.pageSize`; an in-cell picture document without it threw on
    every frame and the grid stayed empty (and the RTL heartbeat withdrew the
    mirror). Imported pictures and inbound writes now carry the style Univer's
    own documents carry (`CELL_DOCUMENT_STYLE`).

I17. A free column appended to the description: a picture-only cell has no
    text, so its line leaves the managed block (the block is the platform's,
    rewritten whole, §8.2). Open: keep the last text instead?

I18. Pictures of a subtask's notes, of a sheet that does not sync, or of a
    to-do not yet in Basecamp stay in the platform; the last are sent once the
    to-do exists and the row is next queued.

I19. **Open:** a picture copied from another workbook keeps that workbook's
    URL, which this workbook's members may not be allowed to read (404, the
    picture is not shown). Copying the object on paste is not built.

I20. **(verify live)** Basecamp accepting an image as a description file is
    the phase 5 path (P18): not tried against real Basecamp.
