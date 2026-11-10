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

### Univer — constraints found in phase 0

- **Univer's grid does not render RTL.** `direction: 'rtl'` mirrors only the UI chrome (menus, toolbar, tabs, editor alignment); `worksheet.rightToLeft` is stored but never read by the renderer. Re-checked 2026-11-10: 1.4.0 is still the latest release.
- **Solved by a mirroring layer: `spike/univer/src/rtl-grid.ts`** (phase 0, pending approval — `docs/phase-0-report.md` §9). It flips the sheet canvas container with CSS, flips text back per line (plain cells) or per glyph group (rich/wrapped cells), un-flips the cell editor, mirrors cell-anchored popup rectangles, swaps ArrowLeft/ArrowRight for selection moves and negates horizontal wheel deltas. The model is untouched. `npm run test:rtl` must pass 14/14.
- The layer depends on Univer internals (`Documents.prototype._drawGlyphGroup` / `_drawGlyphGroupBackgrounds`, `scene.render`, `MoveSelectionCommand.handler`, `ICanvasPopupService.addPopup`, `FUniver._injector`). **Never raise the `@univerjs/*` pin without re-running `npm run test:rtl` and the screenshots.**
- Never mutate a command's `params` object to change behaviour: shortcut parameters are shared between key presses. Wrap the handler and pass a copy.
- Alignment on the mirrored grid is **logical**: model LEFT renders at the start (visual right), RIGHT at the end (visual left). The toolbar's left/right buttons therefore look inverted. Open decision — report §9.5.
- Known gaps of the layer: rotated text and in-sheet images render mirrored; note/filter popups keep Univer's right-hand placement; untested on Firefox, Safari and touch.
- Without the layer, cell text uses an LTR paragraph base (Arabic+Latin words come out in LTR order) and needs explicit right alignment. With the layer neither applies, and the `RLI…PDI` display interceptor from report §2.3 is not needed.
- Sheet services and the render unit are created asynchronously after `createWorkbook`; resolve them after it (the layer waits for `created$` and for the canvas to be mounted).
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
npm run test:rtl           # 14 interaction checks on the mirrored (RTL) grid
npm run closeups           # 2x cell close-ups cited in the phase 0 report
npm run reference          # the browser's own RTL/LTR rendering of the same strings

# Basecamp live-test kit — tests run offline against a mock Basecamp
cd spike/basecamp
npm test
# live run: see spike/basecamp/README.md (needs a test project and credentials)
```
