// Backups (spec §14: «نسخ احتياطي: لقطات R2 بإصدارات + تصدير D1 يومي»).
//
// What the platform already guarantees: every workbook snapshot is a new,
// create-only R2 object (`workbooks/{id}/snapshots/{version}.json`) and no
// version is ever overwritten or deleted (src/snapshot.ts). So "R2 snapshots
// with versions" holds by construction inside the SNAPSHOTS bucket.
//
// What this daily job adds, into a *separate* bucket (binding BACKUPS):
//   d1/{run}/schema.json                     sqlite_master (tables, indexes, triggers)
//   d1/{run}/{table}/{page}.ndjson           every row of every table, 1000 rows a page
//   snapshots/workbooks/{id}/snapshots/{v}.json   the latest snapshot of each live workbook
//   snapshots/templates/{id}/snapshot.json        each live template's snapshot
//   d1/{run}/r2-inventory/{page}.ndjson      key, size, etag, uploaded of every SNAPSHOTS object
//   d1/{run}/snapshot-copies.ndjson          the snapshot copies this run relies on (copied or already there)
//   images/workbooks/{id}/images/{imageId}   each picture over or in a cell (ATTACHMENTS, src/images),
//                                            copied once: a picture never changes (OPEN_QUESTIONS.md "Images" I9)
//   d1/{run}/manifest.json                   counts, written last (a run without it is incomplete)
//
// Nothing is ever overwritten: every put is create-only, and a snapshot
// already copied (same key) is skipped. The only removal is the retention
// policy (./retention.ts, owner decision 2026-11-10): after a run succeeds,
// the files of old runs in this bucket — nothing else. Restoring is a manual,
// documented procedure (docs/backups.md), never automatic.
//
// OPEN (B1, B4, B5, apps/api/OPEN_QUESTIONS.md): Cloudflare's own D1 export /
// Time Travel as the official mechanism, attachments (ATTACHMENTS bucket) and
// KV are product decisions not taken here. Decided: retention (B2), the bucket
// stays in the same Cloudflare account (B3).

import type { BackupPruneSummary, BackupRetentionResponse, BackupRunSummary, BackupRunsResponse } from '@naf-sheets/shared'
import { Hono } from 'hono'
import type { AppEnv } from '../auth'
import type { Env } from '../env'
import { auditStatement } from '../audit'
import { ApiFailure } from '../errors'
import { callerOf } from '../request'
import { snapshotKey } from '../snapshot'
import { backupRetention, isValidRetention, pruneBackups, saveBackupRetention, SNAPSHOT_LIST_FILE } from './retention'
import type { PruneOutcome } from './retention'

export const BACKUP_PAGE_ROWS = 1000
const INVENTORY_PAGE = 1000

export interface BackupDetails {
  tables: Array<{ name: string; rows: number; pages: number }>
  rows: number
  snapshotsCopied: number
  snapshotsPresent: number
  snapshotsMissing: number
  inventoryObjects: number
  /** Entries of `snapshot-copies.ndjson`. */
  snapshotCopiesListed: number
  /** Pictures (src/images) copied by this run, and already in the bucket from an earlier run. */
  imagesCopied?: number
  imagesPresent?: number
  /** The retention policy applied after this run succeeded. */
  retention?: PruneOutcome
}

export interface BackupResult {
  runId: string
  status: 'succeeded' | 'failed' | 'skipped'
  details: BackupDetails | null
  error: string | null
}

const JSON_TYPE = { httpMetadata: { contentType: 'application/json; charset=utf-8' } }
const NDJSON_TYPE = { httpMetadata: { contentType: 'application/x-ndjson; charset=utf-8' } }

/** Create-only put. False when the key already exists (nothing is replaced). */
async function putOnce(bucket: R2Bucket, key: string, body: string, options: R2PutOptions): Promise<boolean> {
  const done = await bucket.put(key, body, { ...options, onlyIf: { etagDoesNotMatch: '*' } })
  return done !== null
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

export function backupRunId(at: Date): string {
  return `${at.toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`
}

async function exportTable(env: Env, bucket: R2Bucket, prefix: string, table: string): Promise<{ rows: number; pages: number }> {
  let rows = 0
  let pages = 0
  let after = Number.MIN_SAFE_INTEGER
  for (;;) {
    // Paged by rowid (every table of the schema has one); stable and O(n).
    const { results } = await env.DB.prepare(`SELECT rowid AS __backup_rowid, * FROM ${quoteIdent(table)} WHERE rowid > ?1 ORDER BY rowid LIMIT ?2`)
      .bind(after, BACKUP_PAGE_ROWS)
      .all<Record<string, unknown> & { __backup_rowid: number }>()
    if (results.length === 0) break
    pages++
    const lines = results.map((r) => {
      const { __backup_rowid: _rowid, ...row } = r
      return JSON.stringify(row)
    })
    const ok = await putOnce(bucket, `${prefix}/${table}/${String(pages).padStart(5, '0')}.ndjson`, `${lines.join('\n')}\n`, NDJSON_TYPE)
    if (!ok) throw new Error(`backup key already exists for ${table} page ${pages}`)
    rows += results.length
    after = results[results.length - 1]!.__backup_rowid
    if (results.length < BACKUP_PAGE_ROWS) break
  }
  return { rows, pages }
}

async function copySnapshot(env: Env, bucket: R2Bucket, key: string): Promise<'copied' | 'present' | 'missing'> {
  const target = `snapshots/${key}`
  if (await bucket.head(target)) return 'present'
  const object = await env.SNAPSHOTS.get(key)
  if (!object) return 'missing'
  const copied = await bucket.put(target, await object.text(), {
    ...JSON_TYPE,
    customMetadata: { ...(object.customMetadata ?? {}), sourceEtag: object.etag },
    onlyIf: { etagDoesNotMatch: '*' },
  })
  return copied ? 'copied' : 'present'
}

async function inventory(env: Env, bucket: R2Bucket, prefix: string): Promise<number> {
  let cursor: string | undefined
  let page = 0
  let count = 0
  do {
    const listed = await env.SNAPSHOTS.list({ limit: INVENTORY_PAGE, ...(cursor ? { cursor } : {}) })
    if (listed.objects.length > 0) {
      page++
      const lines = listed.objects.map((o) => JSON.stringify({ key: o.key, size: o.size, etag: o.etag, uploaded: o.uploaded.toISOString() }))
      await putOnce(bucket, `${prefix}/r2-inventory/${String(page).padStart(5, '0')}.ndjson`, `${lines.join('\n')}\n`, NDJSON_TYPE)
      count += listed.objects.length
    }
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)
  return count
}

/**
 * Pictures of the workbooks (ATTACHMENTS `workbooks/{id}/images/{imageId}`,
 * src/images/store.ts) into `images/…` of the backup bucket. A picture is
 * written once and never changed, so a copy already there is kept; the
 * retention policy never removes them (it removes `d1/{run}/` files and
 * snapshot copies only).
 */
async function copyImages(env: Env, bucket: R2Bucket): Promise<{ copied: number; present: number }> {
  let cursor: string | undefined
  let copied = 0
  let present = 0
  do {
    const listed = await env.ATTACHMENTS.list({ prefix: 'workbooks/', limit: INVENTORY_PAGE, ...(cursor ? { cursor } : {}) })
    for (const o of listed.objects) {
      if (!/^workbooks\/[^/]+\/images\/[0-9a-f]{32}$/.test(o.key)) continue
      const target = `images/${o.key}`
      if (await bucket.head(target)) {
        present++
        continue
      }
      const object = await env.ATTACHMENTS.get(o.key)
      if (!object) continue
      const done = await bucket.put(target, object.body.pipeThrough(new FixedLengthStream(object.size)), {
        httpMetadata: object.httpMetadata,
        customMetadata: { ...(object.customMetadata ?? {}), sourceEtag: object.etag },
        onlyIf: { etagDoesNotMatch: '*' },
      })
      if (done) copied++
      else present++
    }
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)
  return { copied, present }
}

/** The daily backup. Records its run in D1 `backup_runs`; never throws. */
export async function runBackup(env: Env, at: Date = new Date()): Promise<BackupResult> {
  const runId = backupRunId(at)
  const startedAt = at.toISOString()
  const db = env.DB
  if (!env.BACKUPS) {
    // OPEN (B1): no bucket bound: nothing to write to. Recorded so an admin sees it.
    await db
      .prepare(`INSERT INTO backup_runs (id, started_at, finished_at, status, details_json, error) VALUES (?1, ?2, ?2, 'skipped', '{}', 'no_bucket')`)
      .bind(runId, startedAt)
      .run()
    return { runId, status: 'skipped', details: null, error: 'no_bucket' }
  }
  const bucket = env.BACKUPS
  await db.prepare(`INSERT INTO backup_runs (id, started_at, status) VALUES (?1, ?2, 'running')`).bind(runId, startedAt).run()
  const prefix = `d1/${runId}`
  try {
    const { results: schema } = await db
      .prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name`)
      .all<{ type: string; name: string; tbl_name: string; sql: string | null }>()
    await putOnce(bucket, `${prefix}/schema.json`, JSON.stringify(schema), JSON_TYPE)

    const details: BackupDetails = { tables: [], rows: 0, snapshotsCopied: 0, snapshotsPresent: 0, snapshotsMissing: 0, inventoryObjects: 0, snapshotCopiesListed: 0 }
    for (const t of schema.filter((s) => s.type === 'table')) {
      const counted = await exportTable(env, bucket, prefix, t.name)
      details.tables.push({ name: t.name, ...counted })
      details.rows += counted.rows
    }

    const { results: workbooks } = await db
      .prepare(`SELECT id, current_snapshot_version AS v FROM workbooks WHERE archived_at IS NULL ORDER BY id`)
      .all<{ id: string; v: number }>()
    const { results: templates } = await db.prepare(`SELECT r2_key FROM templates WHERE archived_at IS NULL ORDER BY id`).all<{ r2_key: string }>()
    // The copies this run relies on: retention removes a copy only when no remaining run lists it.
    const relied: string[] = []
    for (const key of [...workbooks.map((w) => snapshotKey(w.id, w.v)), ...templates.map((t) => t.r2_key)]) {
      const outcome = await copySnapshot(env, bucket, key)
      if (outcome === 'copied') details.snapshotsCopied++
      else if (outcome === 'present') details.snapshotsPresent++
      else details.snapshotsMissing++
      if (outcome !== 'missing') relied.push(`snapshots/${key}`)
    }
    const listed = await putOnce(bucket, `${prefix}/${SNAPSHOT_LIST_FILE}`, relied.map((key) => JSON.stringify({ key })).join('\n') + (relied.length > 0 ? '\n' : ''), NDJSON_TYPE)
    if (!listed) throw new Error('backup snapshot list already exists')
    details.snapshotCopiesListed = relied.length
    details.inventoryObjects = await inventory(env, bucket, prefix)
    const images = await copyImages(env, bucket)
    details.imagesCopied = images.copied
    details.imagesPresent = images.present

    const finishedAt = new Date().toISOString()
    await putOnce(bucket, `${prefix}/manifest.json`, JSON.stringify({ runId, startedAt, finishedAt, ...details }), JSON_TYPE)
    await db
      .prepare(`UPDATE backup_runs SET status = 'succeeded', finished_at = ?2, details_json = ?3 WHERE id = ?1`)
      .bind(runId, finishedAt, JSON.stringify(details))
      .run()
    // Retention (B2): only now that this run succeeded and its manifest is written.
    details.retention = await pruneBackups(env, bucket, runId, new Date().toISOString())
    await db.prepare(`UPDATE backup_runs SET details_json = ?2 WHERE id = ?1`).bind(runId, JSON.stringify(details)).run()
    return { runId, status: 'succeeded', details, error: null }
  } catch (error) {
    // Name only: a message may carry row content (§14).
    const code = error instanceof Error ? error.name : 'unknown'
    console.error(`backup ${runId} failed: ${code}`)
    await db
      .prepare(`UPDATE backup_runs SET status = 'failed', finished_at = ?2, error = ?3 WHERE id = ?1`)
      .bind(runId, new Date().toISOString(), code)
      .run()
    return { runId, status: 'failed', details: null, error: code }
  }
}

const RUN_MESSAGES: Record<string, string> = {
  no_bucket: 'لم تُنفَّذ النسخة الاحتياطية لأن حاوية النسخ الاحتياطي (BACKUPS) غير مربوطة بالخادم. اطلب من مسؤول البنية ربطها وفق docs/backups.md.',
  failed: 'فشلت النسخة الاحتياطية ولم تكتمل. ستُعاد المحاولة في الموعد اليومي التالي؛ وإن تكرّر الفشل فراجع سجلات الخادم وفق docs/backups.md.',
  running: 'النسخة الاحتياطية قيد التنفيذ الآن، أو توقفت قبل أن تكتمل. إن بقيت كذلك بعد ساعة فراجع سجلات الخادم.',
}

interface RunRow {
  id: string
  started_at: string
  finished_at: string | null
  status: BackupRunSummary['status']
  details_json: string
  error: string | null
  pruned_at: string | null
}

function detailsOf(row: Pick<RunRow, 'details_json'>): Partial<BackupDetails> {
  try {
    return JSON.parse(row.details_json) as Partial<BackupDetails>
  } catch {
    return {}
  }
}

function toSummary(row: RunRow): BackupRunSummary {
  const details = detailsOf(row)
  const message = row.status === 'succeeded' ? null : row.status === 'skipped' ? (RUN_MESSAGES[row.error ?? ''] ?? RUN_MESSAGES.failed!) : (RUN_MESSAGES[row.status] ?? RUN_MESSAGES.failed!)
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    tables: details.tables?.length ?? 0,
    rows: details.rows ?? 0,
    snapshots: (details.snapshotsCopied ?? 0) + (details.snapshotsPresent ?? 0),
    message,
    prunedAt: row.pruned_at,
  }
}

function pruneSummary(p: PruneOutcome | undefined): BackupPruneSummary | null {
  if (!p) return null
  return {
    at: p.at,
    byRunId: p.byRunId,
    runsRemoved: p.runsRemoved,
    objectsRemoved: p.objectsRemoved,
    snapshotCopiesRemoved: p.snapshotCopiesRemoved,
    runsKept: p.runsKept,
    message: p.message,
  }
}

/**
 * GET /api/admin/backups — the latest 14 runs, the retention policy and what
 * it last removed; PUT /api/admin/backups/retention — the policy (admin only).
 */
export function backupRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()
  routes.get('/', async (c) => {
    if (callerOf(c).role !== 'admin') throw new ApiFailure(403, 'admin_only')
    const { results } = await c.env.DB.prepare(
      `SELECT id, started_at, finished_at, status, details_json, error, pruned_at FROM backup_runs ORDER BY started_at DESC, id DESC LIMIT 14`,
    ).all<RunRow>()
    const lastApplied = await c.env.DB.prepare(
      `SELECT details_json FROM backup_runs WHERE status = 'succeeded' AND json_extract(details_json, '$.retention') IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT 1`,
    ).first<{ details_json: string }>()
    return c.json<BackupRunsResponse>({
      configured: Boolean(c.env.BACKUPS),
      runs: results.map(toSummary),
      retention: await backupRetention(c.env.SETTINGS),
      lastPrune: lastApplied ? pruneSummary(detailsOf(lastApplied).retention) : null,
    })
  })
  routes.put('/retention', async (c) => {
    const caller = callerOf(c)
    if (caller.role !== 'admin') throw new ApiFailure(403, 'admin_only')
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      throw new ApiFailure(400, 'invalid_json')
    }
    if (!isValidRetention(body)) throw new ApiFailure(400, 'invalid_backup_retention')
    const retention = await saveBackupRetention(c.env.SETTINGS, body)
    await auditStatement(
      c.env.DB,
      { actorId: caller.id, action: 'settings.backup_retention', entityType: 'settings', entityId: 'backup-retention', workbookId: null, details: retention },
      new Date().toISOString(),
    ).run()
    return c.json<BackupRetentionResponse>({ retention })
  })
  return routes
}
