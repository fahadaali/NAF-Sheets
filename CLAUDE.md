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

The spec (§0.5, §15) orders the phases. **Decision by the owner, 2026-11-10:
phase 0 is approved and phases 1–7 proceed in parallel.** Two phase 0 items
could not run for lack of inputs; they are carried forward as acceptance
prerequisites, not dropped:

| Carried forward | Blocks acceptance of | Needs |
|---|---|---|
| Live Basecamp test (`spike/basecamp/`) | phases 3–5 | test project, OAuth app, token, Cloudflare to deploy the recorder |
| Real multi-sheet Google Sheets file | phase 2 | the file, or its `spreadsheets.get` JSON |

| Phase | State |
|---|---|
| 0 — Spike | **Approved 2026-11-10.** Report: `docs/phase-0-report.md` |
| 1 — Foundation | In progress |
| 2 — Import | In progress (converter); live acceptance blocked on the real file |
| 3 / 4 — Outbound / inbound sync | In progress (client, engine); live acceptance blocked on Basecamp inputs |
| 5 — Subtasks, assignment, attachments, comments | Engine rules in progress; email provider undecided (spec §17-7) |
| 6 — Realtime collaboration | Default (a) self-built per spec §5.3 until §17-2 is decided |
| 7 — Hardening | Not started |

Code is "done" only with tests passing. A phase is "accepted" only when its
spec §15 criteria pass against real services — say which, never imply it.

`spike/` stays as phase 0 evidence. Production code lives in `apps/` and `packages/`.

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

### Univer — constraints and the RTL grid layer

- **Univer's grid does not render RTL** (1.4.0, re-checked 2026-11-10): `direction: 'rtl'` mirrors only the UI chrome; `worksheet.rightToLeft` is never read by the renderer.
- **Solved by `@naf-sheets/univer-rtl`** (`packages/univer-rtl/src/rtl-grid.ts`; phase 0 original in `spike/univer`). It flips the canvas container with CSS and flips back what must not be mirrored: text per line or glyph group, rotated cells as a whole, images, the cell editor. It mirrors popup anchors and placement directions, swaps arrow keys and the toolbar's left/right alignment, fixes touch hit testing and negates horizontal wheel deltas. The model is never changed by the mirror.
- **Univer's document layout has no bidi** (1.4.0, verified 2026-11-10 on the stock grid too): the cell editor, the formula bar, rich-text and rotated cells laid Arabic words out left to right («إعداد خطة» shown as «خطة إعداد»), and an Arabic word was one glyph (Backspace deleted the whole word). `IParagraphStyle.direction` is declared but never read. **Solved by the text layer** (`src/bidi.ts`, a full UAX #9; `src/rtl-text.ts`): the layout and the model stay logical; lines are painted in visual order, Arabic runs are re-cut into one glyph per grapheme (painted joined), and caret, selection, hit testing and arrow keys follow the visual positions. The contract check and a text heartbeat judge it separately from the grid: a broken text hook leaves the editors stock and keeps the grid mirrored (`RtlGridStatus.text`).
- **Alignment is logical** (owner decision 2026-11-10): model LEFT = start = visual right. The toolbar and alignment shortcuts are swapped so their buttons mean what they show; programmatic writes (Facade, import, sync — anything that passes an explicit `range`) are stored as given. The Google Sheets import must state which it writes.
- **Upgrade safety (owner requirement: updates must not break it):**
  1. Every `@univerjs/*` is pinned exactly, with the lockfile; `save-exact` in `.npmrc`. Nothing changes without a deliberate pull request.
  2. `npm run check:pins` fails unless every `@univerjs/*` equals `VERIFIED_UNIVER_VERSION` in `rtl-grid.ts`. Raising Univer therefore means raising that constant in the same PR.
  3. CI (`.github/workflows/rtl-grid.yml`) runs the interaction suite in Chromium, Firefox and WebKit; a Univer bump merges only when it is green.
  4. At runtime `checkUniverContract()` verifies every hooked internal before applying anything. A missing or changed hook leaves the stock grid untouched and reports why (`RtlGridStatus`). A heartbeat withdraws the mirror if plain text stops flowing through the flip-back path. Both are covered by tests.
- Never mutate a command's `params` object to change behaviour: shortcut parameters are shared between key presses. Wrap the handler and pass a copy.
- Univer's automatic row height depends on timing (whether the cell editor is initialised before data is written). Tests and the app must wait for lifecycle `Steady` before mutating, or row heights differ between runs.
- `FRange.getCellRect()` is raw skeleton geometry: it ignores scroll and zoom. Do not position anything with it after scrolling or zooming.
- Sheet services and the render unit are created asynchronously after `createWorkbook`; resolve them after it.
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

From the repository root (npm workspaces; `.npmrc` sets `save-exact` and `legacy-peer-deps`):

```bash
npm ci                     # install exactly what package-lock.json says
npm run typecheck          # every workspace
npm test                   # every workspace's unit/integration tests (vitest)
```

Per package:

```bash
# apps/api — Worker + D1/R2/KV/Queues tests on local Miniflare (no remote calls)
cd apps/api && npx vitest run

# apps/web — unit tests, then the browser smoke test against a mocked API (:4174)
cd apps/web && npx vitest run && npm run test:e2e

# packages/univer-rtl — the RTL grid layer
cd packages/univer-rtl
npm test                   # 220 unit tests (pure helpers, UAX #9 bidi, text geometry, Univer contract)
npm run check:pins         # every @univerjs/* == VERIFIED_UNIVER_VERSION
npm run harness:build && (npm run harness:preview &)   # test page on :4175
npm run test:rtl           # 48 interaction checks (BROWSER=chromium|firefox|webkit)
npm run perf:rtl           # frame cost with and without the mirror

# packages/gsheets-import — regenerate the Univer function list after a Univer bump
cd packages/gsheets-import && npm run generate:functions
```

Never run `playwright install` locally: Chromium is pre-installed; CI installs Firefox and WebKit.

Phase 0 evidence (frozen; do not develop there): `spike/univer`, `spike/basecamp` (live Basecamp kit: see its README).
