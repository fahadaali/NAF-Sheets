// Workbook snapshots in R2 (spec §6.1): workbooks/{id}/snapshots/{version}.json
//
// A committed version — the one `workbooks.current_snapshot_version` points
// at, or any before it — is never overwritten. A new version is written with
// a create-only put *before* D1 is moved to it, so D1 never points at an
// object that does not exist.

import { DEFAULT_COLUMNS, withDashboardSheet } from '@naf-sheets/shared'
import type { Env } from './env'

/** The Univer release this platform is pinned to (CLAUDE.md §2). */
export const UNIVER_APP_VERSION = '1.4.0'

/** Title of the first sheet of a blank workbook (spec §7.1); Latin digit (§12.2). */
export const FIRST_SHEET_TITLE = 'ورقة 1'

/**
 * The grid's font family (spec §4.1). It must equal the family the web app
 * loads (`--font-sans` in apps/web/src/styles/theme.css), or Univer falls back
 * to its own default (Arial).
 */
export const GRID_FONT_FAMILY = 'Thmanyah Sans'

/** Rows and columns of a blank sheet. */
const BLANK_ROW_COUNT = 1000
const BLANK_COLUMN_COUNT = 26

/** Style id of the header row in the blank workbook. */
const HEADER_STYLE_ID = 'header'

/**
 * A leftover object at the next version (a save that died between R2 and D1)
 * may be replaced once it is this old. Younger objects are treated as a
 * concurrent save still in flight.
 */
// OPEN: the 5-minute window and R2's create-only put in production
// (OPEN_QUESTIONS.md #13).
export const DEFAULT_SNAPSHOT_ORPHAN_AGE_MS = 5 * 60 * 1000

export function snapshotKey(workbookId: string, version: number): string {
  return `workbooks/${workbookId}/snapshots/${version}.json`
}

/**
 * The subset of Univer's `IWorkbookData` (@univerjs/core 1.4.0,
 * sheets/typedef.d.ts) that a blank workbook sets. The API never interprets
 * snapshots beyond producing this first one.
 */
export interface BlankWorkbookData {
  id: string
  name: string
  appVersion: string
  locale: 'arSA'
  styles: Record<string, { bl: 1 }>
  sheetOrder: string[]
  sheets: Record<string, BlankSheetData | Record<string, unknown>>
}

/** «ورقة 1» of a blank workbook. */
export interface BlankSheetData {
  id: string
  name: string
  rowCount: number
  columnCount: number
  /** Stored for the model; the grid is mirrored by @naf-sheets/univer-rtl. */
  rightToLeft: 1
  /** Every cell without its own font uses Thmanyah (spec §4.1). */
  defaultStyle: { ff: typeof GRID_FONT_FAMILY }
  cellData: Record<number, Record<number, { v: string; s: string }>>
}

/**
 * The dashboard sheet «اللوحة» (first tab, @naf-sheets/shared dashboard-sheet.ts),
 * then one sheet «ورقة 1» whose header row holds the default columns of spec
 * §7.1, in order. D1 lists «ورقة 1» only.
 */
export function blankWorkbookSnapshot(input: { workbookId: string; title: string; univerSheetId: string }): BlankWorkbookData {
  const header: Record<number, { v: string; s: string }> = {}
  DEFAULT_COLUMNS.forEach((name, column) => {
    header[column] = { v: name, s: HEADER_STYLE_ID }
  })

  return withDashboardSheet({
    id: input.workbookId,
    name: input.title,
    appVersion: UNIVER_APP_VERSION,
    locale: 'arSA',
    styles: { [HEADER_STYLE_ID]: { bl: 1 } },
    sheetOrder: [input.univerSheetId],
    sheets: {
      [input.univerSheetId]: {
        id: input.univerSheetId,
        name: FIRST_SHEET_TITLE,
        rowCount: BLANK_ROW_COUNT,
        columnCount: BLANK_COLUMN_COUNT,
        rightToLeft: 1,
        defaultStyle: { ff: GRID_FONT_FAMILY },
        cellData: { 0: header },
      },
    },
  })
}

function putOptions(meta: { workbookId: string; version: number; savedBy: string }): R2PutOptions {
  return {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { workbookId: meta.workbookId, version: String(meta.version), savedBy: meta.savedBy },
  }
}

/**
 * Writes `version` of a workbook's snapshot unless an object already holds it.
 *
 * Returns `false` when another save owns that version — a concurrent save of
 * the same base, still in flight — so the caller answers 409.
 *
 * An existing object older than `orphanAgeMs` is a save that died between
 * R2 and D1; it is replaced, conditionally on its exact etag, provided
 * `stillUncommitted()` confirms D1 has not moved to that version meanwhile.
 */
export async function writeSnapshotVersion(
  env: Env,
  meta: { workbookId: string; version: number; savedBy: string },
  body: string,
  options: { orphanAgeMs: number; stillUncommitted: () => Promise<boolean> },
): Promise<boolean> {
  const key = snapshotKey(meta.workbookId, meta.version)

  const created = await env.SNAPSHOTS.put(key, body, { ...putOptions(meta), onlyIf: { etagDoesNotMatch: '*' } })
  if (created) return true

  const existing = await env.SNAPSHOTS.head(key)
  if (!existing) return false
  if (Date.now() - existing.uploaded.getTime() < options.orphanAgeMs) return false
  if (!(await options.stillUncommitted())) return false

  const replaced = await env.SNAPSHOTS.put(key, body, { ...putOptions(meta), onlyIf: { etagMatches: existing.etag } })
  return replaced !== null
}

export async function readSnapshot(env: Env, workbookId: string, version: number): Promise<unknown | null> {
  const object = await env.SNAPSHOTS.get(snapshotKey(workbookId, version))
  if (!object) return null
  return object.json<unknown>()
}
