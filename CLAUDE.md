# NAF Sheets — منصة إدارة مشاريع الاتصال المؤسسي

Internal NAF platform: a Google-Sheets-like workbook editor where every workbook
is a Basecamp 5 project, every sheet a to-do list, every row a to-do and every
indented row a subtask, kept in two-way sync. The full specification is
`docs/spec.md` (code name `naf-comms`). Read it before changing anything; this
file only records the decisions that govern the code and the commands.

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

What still applies, because the **spec itself** requires it (not because of `naf-ui`):

- Arabic-first, full RTL interface (§12.2). Logical CSS properties (`ms-*`, `pe-*`, `inset-inline-start` …), never physical ones.
- Thmanyah font (§4.1). Self-host the official files — see `docs/phase-0-report.md` §2.6.
- Lucide icons only (§12.2). No emoji in the interface.
- Latin digits; Gregorian dates as `YYYY-MM-DD`, optional Hijri display (§12.2).
- Every error message in Arabic, stating what happened and what to do (§12.2).

**Open:** what replaces `naf-ui` for colours and components. Until decided,
define the theme once, in one file in this repo, and consume it everywhere —
never scatter raw colour values through components.

`naf-id` (sign-in) is **not** part of the design system and still applies — §2.

---

## 1. Phase gate — where the project stands

The spec (§0.5, §15) forbids starting a phase before the previous phase's
acceptance criteria pass. **Phase 0 (feasibility spike) is mandatory before any
build and ends by waiting for approval.**

| Phase | State |
|---|---|
| 0 — Spike | Univer checks done; Basecamp live test and real Google Sheets file **blocked on inputs**. Report: `docs/phase-0-report.md`. **Waiting for approval.** |
| 1 — Foundation | Not started. Do not start until phase 0 is approved. |

`spike/` is throwaway evidence for phase 0, not a base for production code.

---

## 2. Architecture (spec §4)

| Layer | Choice |
|---|---|
| Web | React + TypeScript + Vite, Thmanyah font |
| Grid engine | Univer open source, `@univerjs/*` **1.4.0 pinned exactly** — all `@univerjs/*` packages must share one version |
| API | Cloudflare Workers + Hono |
| Data | D1 (metadata, mappings), R2 (workbook snapshots, attachments), KV (settings, short-lived tokens) |
| Realtime | Durable Object `WorkbookRoom` per workbook |
| Sync jobs | Queue `bc-outbound` + DLQ; Cron reconciliation every 15 min |
| Auth | `naf-id` through the `naf-auth` package |

Planned layout (§4.3): `apps/web`, `apps/api`, `packages/{shared,gsheets-import,basecamp,sync-engine}`, `migrations/`.

### Sign-in: `naf-id` via `naf-auth`

- Depend on `"naf-auth": "github:fahadaali/naf-auth#v3.4.0"` — a tag, never `main`, never `v1.0.0`.
- Hono wiring: `handleCallback`, `handleLogout`, `handleBackchannelLogout`, `honoMiddleware`; the user is `c.get('user')`.
- `AUTH_ISSUER = "https://app.naflaw.sa"` (no trailing slash; compared literally).
- `PLATFORM_ID` is **case-sensitive** and must equal the row registered in the naf-id admin panel. Not decided yet — ask.
- `AUTH_CLIENT_SECRET` only via `wrangler secret put`.
- Authentication is central, permissions are local: the platform's own `admin` / `editor` / `viewer` live in the local members table. `viewer` must be truly read-only in every route, not only hidden in the UI.

### Basecamp (spec Appendix A, re-checked against `basecamp/bc-api` on 2026-11-09)

- Every request: `User-Agent: NAF Comms (info@naflaw.sa)`; POST/PUT also `Content-Type: application/json; charset=utf-8`.
- `PUT /todos/{id}.json` **clears every field you omit.** Always send `content`, `description`, `assignee_ids`, `completion_subscriber_ids`, `due_on`, `starts_on`.
- `PUT /subtasks/{id}.json` is partial. Clear with `"due_on": null` / `"assignee_ids": []`.
- `DELETE /subtasks/{id}.json` is **permanent** (no trash). Snapshot the subtask before deleting.
- Webhooks carry no signature and no `description` / `completed` / `assignees`: secret in the path, check `recording.bucket.id`, then always fetch the record.
- No documented event for a due-date change or for completing a subtask. Do not rely on webhooks for those until phase 0's live test says otherwise; reconciliation covers them.
- Writes go out with **the acting user's own token**. The service token is for webhooks, read-only reconciliation and member caches only. The single documented exception is the automatic parent-assignment rule (§8.1).
- Retry `429` after `Retry-After` and `5xx` with backoff. Never retry `404`; `Reason: Account Inactive` stops the whole account's sync.

### Univer — constraints found in phase 0

- **The grid does not render RTL.** `direction: 'rtl'` mirrors only the UI chrome (menus, toolbar, tabs, editor alignment). `worksheet.rightToLeft` is stored but never read by the renderer: column A stays on the left. Decision pending — see `docs/phase-0-report.md`.
- Cell text uses an LTR paragraph base. Arabic+digits renders correctly; Arabic+Latin words come out in LTR order. Workaround verified: a display-only `CELL_CONTENT` interceptor wrapping such strings in `U+2067 … U+2069`.
- With that interceptor active, Facade `getValue()` returns the **wrapped** display value. Sync and export code must read the raw model (`worksheet.getCellRaw`), never `getValue()`.
- Sheet services are registered lazily, when the first sheet unit is created. Resolve them after `createWorkbook`, not after `createUniver`.
- Arabic text needs an explicit right horizontal alignment; Univer defaults to left.
- Out of scope / Pro-only: XLSX import/export, built-in collaboration, pivot tables, charts, print, edit history.

---

## 3. Working rules

- Never delete a file, and never delete data locally, in Basecamp or in Drive, without explicit approval from the user.
- Never edit an original asset: copy it and edit the copy.
- When the spec and the docs disagree, or behaviour is uncertain: stop and ask. Do not guess.
- Every sync rule and every import converter ships with tests (§0.6).
- Pin exact versions (no `^` or `~`) for `@univerjs/*`, `lucide-react` and the font.
- Commit messages: Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:` …).
- Secrets only through `wrangler secret put`, never in files, logs or chat.

---

## 4. Commands

Phase 0 spike only (no application exists yet):

```bash
# Univer feature check — builds a test page and drives it in headless Chromium
cd spike/univer
npm install
npm run build
npm run typecheck
npm run preview &          # serves on :4173
npm run verify             # writes results/results.json and screenshots
npm run closeups           # 2x cell close-ups cited in the phase 0 report
npm run reference          # the browser's own RTL/LTR rendering of the same strings

# Basecamp live-test kit — tests run offline against a mock Basecamp
cd spike/basecamp
npm test
# live run: see spike/basecamp/README.md (needs a test project and credentials)
```
