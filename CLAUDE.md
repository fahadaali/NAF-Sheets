# NAF Sheets — محطة ربط Google Sheets بـ Basecamp

Internal NAF platform: a **station** that links existing Google Sheets files,
left where they are, to Basecamp 5 projects, two-way, on fixed columns. Every
linked tab is a to-do list, every to-do row a to-do and every row under it a
subtask. People work in the sheet and in Basecamp; the platform only links,
configures and reports. The reference is `docs/station-plan.md` (decisions in
§11); `docs/spec.md` describes the removed workbook editor and is history.

UI language: Arabic, RTL. Code, identifiers and comments: English.

---

## 0. This platform is exempt from the NAF design system

**Decision by the owner, 2026-11-09:** NAF Sheets is a separate, exceptional
platform and is **not** governed by the NAF UI Rules that live in the
`CLAUDE.md` of the other NAF repositories.

That means, in this repository:

- No link to the `fahadaali/naf-ui` registry. No `naf-theme.css`, no `naf-ui` components.
- `naf-terms.md`, `naf-icons.md`, `naf-format` and `naf-currency` are not the source of copy, icons or formatting here.
- The `/check-drift` and `/link-platform` skills do not apply. Do not run them here, and do not "fix" this repo toward `naf-ui`.
- The principle "the registry precedes the platform" does not apply. Decisions are recorded in this repository.

What still applies:

- Arabic-first, full RTL interface. Logical CSS properties (`ms-*`, `pe-*`, `inset-inline-start` …), never physical ones.
- Thmanyah font, self-hosted (`@dawod/thmanyah-font-web`).
- Lucide icons only. No emoji in the interface.
- Latin digits; Gregorian dates as `YYYY-MM-DD`.
- Every error message in Arabic, stating what happened and what to do.
- **The calm palette is the platform's look** (owner, 2026-11-10): `apps/web/src/styles/theme.css` is the one file that defines the theme, plus the admin screen «المظهر» (overrides in KV). Consume its tokens everywhere — never raw colour values in components.

`naf-id` (sign-in) is **not** part of the design system and still applies — §2.

---

## 1. Where the project stands

**Decision by the owner, 2026-11-15:** the workbook editor is replaced by the
station (`docs/station-plan.md`); the editor's code was removed with the
owner's approval. Its D1 tables, R2 objects, the `bc-outbound` queues and the
`WorkbookRoom` Durable Object class (kept as a stub, `apps/api/src/legacy-room.ts`)
still exist: removing any of them deletes data and needs the owner.

| Stage (`docs/station-plan.md` §9) | State |
|---|---|
| S0 — live feasibility (row identity, Drive notification delay, quotas) | Deployed 2026-11-15. Row identity passed on the real Google (`docs/station-s0-report.md`); delay and quotas wait for the first real link |
| S1 — remove the editor | Done |
| S2–S5 — links, both directions, deletion, alerts, screens | Built and tested against a fake Google sheet and a fake Basecamp |
| S6 — hardening, live acceptance | Waits for the first real link |

Code is "done" only with tests passing. A stage is "accepted" only against the
real Google and Basecamp — say which, never imply it.

`spike/` stays as the old phase 0 evidence. Production code lives in `apps/` and `packages/`.

---

## 2. Architecture

| Layer | Choice |
|---|---|
| Web | React + TypeScript + Vite (`apps/web`): the station screens (`src/station`), settings, members, appearance |
| API | Cloudflare Workers + Hono (`apps/api`) |
| Sheet ↔ task logic | `packages/station-sheet` (pure): fixed columns, rows → tasks, names, status, dates, Basecamp changes → cells, alert email |
| Diff | `packages/sync-engine` (pure, field-level three-way diff), unchanged from the editor |
| Basecamp client | `packages/basecamp` |
| Data | D1 (`station_*` tables, `migrations/0010`–`0013`), KV (sessions, settings), R2 (backups; the old editor's objects) |
| Triggers | Drive push notifications (`/webhooks/google/:secret`), Basecamp project webhooks (`/webhooks/basecamp/:secret`), cron every minute (changed files; each link's full pass every 15 min; channel and webhook upkeep; alert emails), «مزامنة الآن» — all become runs on the `bc-inbound` queue |
| Auth | `naf-id` through the `naf-auth` package |
| Hosting | **One Worker `naf-sheets`** on `sheets.naflaw.sa`: the API plus `apps/web/dist` as static assets. Deployed by `scripts/deploy-api.sh` from `main` (`docs/cloudflare-setup.md`) |

### Sign-in: `naf-id` via `naf-auth`

- Depend on `"naf-auth": "github:fahadaali/naf-auth#v3.4.0"` — a tag, never `main`.
- `AUTH_ISSUER = "https://app.naflaw.sa"` (no trailing slash; compared literally).
- `PLATFORM_ID` is a dashboard variable (`naf-sheets`), **case-sensitive**, equal to the naf-id admin panel row.
- Authentication is central, permissions are local: `admin` creates, changes and removes links, maps names, connects the sync account; everyone else reads. Enforced in every route, not only hidden in the UI.

### The station's rules (owner decisions, `docs/station-plan.md` §11)

- **Fixed columns**, found by header text, never by position: «المهمة الرئيسية», «المهمة», «القسم», «الحالة», «الموعد». Other columns are never read or written.
- A row with only «المهمة الرئيسية» is a to-do; a row with «المهمة» is a subtask of the **nearest to-do row above it**; the platform rewrites a stale repeated to-do title.
- **People come from the sheet**: «القسم» → the roles tab («المسميات» by default, per link) → names (several split on a dash — «-», «–», «—» — with a space on either side, or «،», «,», «؛») → Basecamp people through the platform's name directory (`station_names`, one for every link; exact names map themselves). A people change made in Basecamp is put back and alerted. A row whose people cannot be resolved is **held back**, never sent with no assignee; so is a subtask row whose «القسم» is empty (owner, 2026-11-17). A title written twice in the roles tab with different names is alerted; the first is used.
- «منجزة» ↔ completed; un-completing in Basecamp writes «جارية».
- **Notifications reach everyone** (owner, 2026-11-15): every project member (clients excepted) is on each to-do's «When done, notify» list and among its subscribers (`station_tasks.notify_key`, redone when the members change). Basecamp sends nothing for a subtask's completion, so a subtask completed from the sheet posts a comment on its to-do.
- **A to-do's due date** (owner, 2026-11-15, option أ): its own «الموعد» when written; when empty, the latest of its subtasks' dates — changed in Basecamp only, it is put back, and never written into the empty cell.
- **Deletion is automatic**: a row gone from the sheet trashes its to-do (subtasks go with it) or deletes its subtask for good after storing its snapshot (`station_deleted`). **Never** when a tab reads empty while it had tasks, nor when a row's two title cells are emptied (that row is held with an alert; owner, 2026-11-17). A new row copying a task already in Basecamp (same title, same to-do) is held with an alert, never created twice. A record deleted in Basecamp leaves the row with a note.
- **Unlinking keeps the sync record** (owner, 2026-11-17): the link is marked (`unlinked_at`), not deleted; linking the same file to the same project again takes it back, so nothing is created twice.
- The editor's personal Basecamp links and member matching were removed (owner, 2026-11-17); only the sync account is connected, by an admin.
- Records created in Basecamp get rows in the sheet; the sheet's order is the reference.
- **Row identity** is row developer metadata (`naf_task_uid`), never a visible column.
- One run per link at a time (D1 lease, `resync` coalesces bursts).
- Problems are stored (`station_alerts`, one key per problem) and emailed once through Resend from `ALERT_EMAIL_FROM` to `ALERT_EMAIL_TO` (or every admin).

### Google

- A **service account** (`naf-sync@naf-sheets-station.iam.gserviceaccount.com`); its JSON key is the secret `GOOGLE_SERVICE_ACCOUNT_KEY`. Each linked file is shared with it as Editor. No Google OAuth, no `GOOGLE_CLIENT_*`.
- Read values with `UNFORMATTED_VALUE` and `SERIAL_NUMBER`; write cells with `USER_ENTERED`.
- Drive file channels last at most a day: renewed by the minute cron.

### Basecamp (`docs/spec.md` Appendix A, still valid)

- **Every write goes out with the sync account's token** (owner decision 7: Fahad Alotaibi's account, connected by an admin at `/auth/basecamp/start?service=1`). This replaces the editor's "each user's own token" rule.
- Every request: `User-Agent: NAF Comms (info@naflaw.sa)`; POST/PUT also `Content-Type: application/json; charset=utf-8`.
- `PUT /todos/{id}.json` **clears every field you omit.** Always send `content`, `description`, `assignee_ids`, `completion_subscriber_ids`, `due_on`, `starts_on` (the station carries the description and start date it has no column for from the last synced base).
- `PUT /subtasks/{id}.json` is partial. `DELETE /subtasks/{id}.json` is **permanent**: snapshot first.
- Webhooks carry no signature: secret in the path, then always fetch the record. No documented event for a due-date change or a subtask completion: the 15-minute full pass covers them.
- Retry `429` after `Retry-After` and `5xx` with backoff. Never retry `404`.

---

## 3. Working rules

- Never delete a file, and never delete data locally, in Basecamp, in Drive or in Cloudflare (D1, R2, queues, Durable Objects), without explicit approval from the user.
- Never edit an original asset: copy it and edit the copy.
- When the plan and the docs disagree, or behaviour is uncertain: stop and ask. Do not guess.
- Every sync rule ships with tests (fake Google sheet `apps/api/test/station/fake-sheet.ts`, fake Basecamp `apps/api/test/support/fake-basecamp.ts`).
- Pin exact versions (no `^` or `~`) for `lucide-react` and the font; `.npmrc` sets `save-exact`.
- Commit messages: Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:` …).
- Secrets only through `wrangler secret put` or the Worker's dashboard (type Secret), never in files, logs or chat.
- No resource id and no undecided value in `wrangler.toml`; dashboard variables survive deploys (`keep_vars = true`). Setup: `docs/cloudflare-setup.md`, `docs/google-service-account.md`.

---

## 4. Commands

From the repository root (npm workspaces):

```bash
npm ci                     # install exactly what package-lock.json says
npm run typecheck          # every workspace
npm test                   # every workspace's tests (vitest)
```

Per package:

```bash
# apps/api — Worker + D1/KV/R2/Queues on local Miniflare (no remote calls)
cd apps/api && npx vitest run
cd apps/api && npx vitest run test/station     # the station only

# apps/web — unit tests; build
cd apps/web && npx vitest run && npx vite build

# packages/station-sheet — pure sheet ↔ task logic
cd packages/station-sheet && npx vitest run
```

Never run `playwright install`: Chromium is pre-installed.
