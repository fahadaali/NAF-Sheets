// Clean-up of picture files nothing refers to (owner decision 2026-11-11,
// apps/api OPEN_QUESTIONS.md "Images" I9: «نعم نظف»). Runs in the daily
// backup cron, after a backup succeeded (src/phase7/backup.ts), with a bounded
// amount of work per run. docs/backups.md §7 describes it for operators.
//
// What it may delete: only pictures, i.e. ATTACHMENTS objects whose key is
// `workbooks/{workbookId}/images/{imageId}` (src/images/store.ts). Phase 5
// files (`attachments/…`, including the copies of notes pictures sent to
// Basecamp) are never touched here: their 30-day archive is a separate,
// undecided question (P4).
//
// A picture is deleted only when every one of these holds:
//   1. no stored snapshot refers to it. "Stored snapshot" = every object in
//      SNAPSHOTS (every version of every workbook, and every template: versions
//      are never deleted, so every one of them can be restored) and every
//      snapshot copy in BACKUPS (`snapshots/…`) whose original is not in
//      SNAPSHOTS. A reference is the picture id after `images/` anywhere in
//      the snapshot's text, whatever workbook it names (a template or a copied
//      cell may point at another workbook's picture), so a match is never
//      missed for a structural reason;
//   2. every snapshot object that could refer to it has been read: snapshot
//      objects are create-only, so each is read once and remembered (D1
//      `image_ref_scans`, `image_refs`); one that is not read yet and was
//      written after the picture's upload (minus a day of clock margin) keeps
//      it. Reading is bounded per run, newest first;
//   3. it was uploaded more than IMAGE_CLEANUP_GRACE_DAYS ago (30), so an
//      insert not saved yet, an import still running or an open editor's
//      picture is never taken;
//   4. its workbook is not archived (an archived workbook keeps everything);
//      a picture whose workbook row does not exist (an import that failed
//      after storing its pictures) may go;
//   5. the backup bucket holds its copy (`images/workbooks/…`, written by the
//      backup that just ran): the copy is never removed (not by this, not by
//      the retention policy), so a mistaken deletion can always be restored.
// At most MAX_IMAGE_DELETIONS_PER_RUN pictures go per run (oldest first); each
// one is written to `audit_log` (`image.cleanup`) before it is deleted, and the
// run's outcome goes into `backup_runs.details_json.imageCleanup`.
//
// Consequence of rule 1: a picture that was ever in a saved version stays as
// long as that version does — today, forever. What this removes in practice
// is what never reached a saved version: an insert undone before the save, the
// pictures of a failed import, an upload never inserted.

import type { Env } from '../env'
import { auditStatement } from '../audit'

export const IMAGE_CLEANUP_GRACE_DAYS = 30
/** Clock margin between a picture's upload and a snapshot that may refer to it. */
export const IMAGE_CLEANUP_MARGIN_MS = 24 * 3600_000

export interface ImageCleanupLimits {
  /** Snapshot objects read per run. */
  scanObjects: number
  /** Bytes of snapshot text read per run (a run stops reading once past it). */
  scanBytes: number
  /** Pictures deleted per run. */
  deletions: number
}

export const IMAGE_CLEANUP_LIMITS: ImageCleanupLimits = { scanObjects: 2000, scanBytes: 256 * 1024 * 1024, deletions: 200 }

export interface ImageCleanupOutcome {
  at: string
  /** Pictures found in ATTACHMENTS. */
  images: number
  /** Snapshot objects read in this run, and still unread after it. */
  scanned: number
  scanBacklog: number
  deleted: number
  /** Deletable pictures left for the next run by the per-run bound. */
  deferred: number
  kept: { referenced: number; grace: number; archived: number; unscanned: number; noBackupCopy: number; changed: number }
  error: string | null
}

const IMAGE_KEY = /^workbooks\/([^/]+)\/images\/([0-9a-f]{32})$/
// `images/` + an id, with the slash plain, JSON-escaped or percent-encoded; optionally preceded by `workbooks/{id}/`.
const SEP = String.raw`(?:\\?\/|%2[fF])`
const REFERENCE = new RegExp(String.raw`(?:workbooks${SEP}([^/\\"%?#\s]{1,128})${SEP})?images${SEP}([0-9a-f]{32})(?![0-9a-f])`, 'g')

/** Picture ids a snapshot's text refers to, with the workbook named before them ('' when none). */
export function imageReferences(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of text.matchAll(REFERENCE)) {
    const id = m[2] as string
    if (!out.has(id) || out.get(id) === '') out.set(id, m[1] ?? '')
  }
  return out
}

interface Listed {
  key: string
  etag: string
  uploaded: number
  size: number
}

async function listAll(bucket: R2Bucket, prefix: string | undefined, keep: (o: R2Object) => boolean): Promise<Listed[]> {
  const out: Listed[] = []
  let cursor: string | undefined
  do {
    const page = await bucket.list({ ...(prefix ? { prefix } : {}), limit: 1000, ...(cursor ? { cursor } : {}) })
    for (const o of page.objects) if (keep(o)) out.push({ key: o.key, etag: o.etag, uploaded: o.uploaded.getTime(), size: o.size })
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return out
}

async function inChunks<T>(values: readonly string[], fn: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < values.length; i += 500) out.push(...(await fn(values.slice(i, i + 500))))
  return out
}

interface ScanTarget extends Listed {
  source: 'snapshots' | 'backups'
}

/**
 * Deletes picture files no restorable snapshot refers to (rules above). Never
 * throws: a failure stops the clean-up (what was deleted is in the audit log)
 * and is reported in the outcome.
 */
export async function cleanUpImages(env: Env, backups: R2Bucket, now: Date, limits: ImageCleanupLimits = IMAGE_CLEANUP_LIMITS): Promise<ImageCleanupOutcome> {
  const at = now.toISOString()
  const outcome: ImageCleanupOutcome = {
    at,
    images: 0,
    scanned: 0,
    scanBacklog: 0,
    deleted: 0,
    deferred: 0,
    kept: { referenced: 0, grace: 0, archived: 0, unscanned: 0, noBackupCopy: 0, changed: 0 },
    error: null,
  }
  const db = env.DB
  try {
    const images = await listAll(env.ATTACHMENTS, 'workbooks/', (o) => IMAGE_KEY.test(o.key))
    outcome.images = images.length
    if (images.length === 0) return outcome

    // --- 1–2. Read the snapshot objects not read yet that could refer to a picture.
    const earliest = images.reduce((min, i) => Math.min(min, i.uploaded), Number.POSITIVE_INFINITY) - IMAGE_CLEANUP_MARGIN_MS
    const live = await listAll(env.SNAPSHOTS, undefined, () => true)
    const liveKeys = new Set(live.map((o) => o.key))
    const copies = await listAll(backups, 'snapshots/', (o) => !liveKeys.has(o.key.slice('snapshots/'.length)))
    const targets: ScanTarget[] = [
      ...live.filter((o) => o.uploaded >= earliest).map((o) => ({ ...o, source: 'snapshots' as const })),
      ...copies.filter((o) => o.uploaded >= earliest).map((o) => ({ ...o, source: 'backups' as const })),
    ]
    const scanned = new Set(
      (
        await inChunks(targets.map((t) => JSON.stringify([t.source, t.key])), async (chunk) => {
          const { results } = await db
            .prepare(
              `SELECT s.source, s.snapshot_key, s.etag FROM image_ref_scans s
               JOIN json_each(?1) j ON s.source = json_extract(j.value, '$[0]') AND s.snapshot_key = json_extract(j.value, '$[1]')`,
            )
            .bind(JSON.stringify(chunk.map((c) => JSON.parse(c) as unknown)))
            .all<{ source: string; snapshot_key: string; etag: string }>()
          return results
        })
      ).map((r) => `${r.source}\u0000${r.snapshot_key}\u0000${r.etag}`),
    )
    const unread = targets.filter((t) => !scanned.has(`${t.source}\u0000${t.key}\u0000${t.etag}`)).sort((a, b) => b.uploaded - a.uploaded)
    let bytes = 0
    const backlog: ScanTarget[] = []
    for (const t of unread) {
      if (outcome.scanned >= limits.scanObjects || bytes >= limits.scanBytes) {
        backlog.push(t)
        continue
      }
      const object = await (t.source === 'snapshots' ? env.SNAPSHOTS : backups).get(t.key)
      if (!object) continue // gone: refers to nothing any more
      const text = await object.text()
      bytes += text.length
      const refs = imageReferences(text)
      const statements: D1PreparedStatement[] = [...refs].map(([imageId, workbookId]) =>
        db
          .prepare(`INSERT INTO image_refs (image_id, workbook_id, first_seen_key, first_seen_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (image_id) DO NOTHING`)
          .bind(imageId, workbookId, `${t.source}:${t.key}`, at),
      )
      // The scan is recorded in the same batch as its references, never before them.
      statements.push(
        db
          .prepare(
            `INSERT INTO image_ref_scans (source, snapshot_key, etag, uploaded_at, scanned_at, refs) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (source, snapshot_key) DO UPDATE SET etag = excluded.etag, uploaded_at = excluded.uploaded_at, scanned_at = excluded.scanned_at, refs = excluded.refs`,
          )
          .bind(t.source, t.key, object.etag, object.uploaded.toISOString(), at, refs.size),
      )
      for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50))
      outcome.scanned++
    }
    outcome.scanBacklog = backlog.length
    const newestUnread = backlog.length > 0 ? backlog.reduce((max, t) => Math.max(max, t.uploaded), Number.NEGATIVE_INFINITY) : null

    // --- 3–5. Which pictures may go.
    const referenced = new Set(
      (
        await inChunks(
          images.map((i) => IMAGE_KEY.exec(i.key)![2] as string),
          async (chunk) =>
            (await db.prepare(`SELECT image_id FROM image_refs WHERE image_id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(chunk)).all<{ image_id: string }>()).results,
        )
      ).map((r) => r.image_id),
    )
    const workbookIds = [...new Set(images.map((i) => IMAGE_KEY.exec(i.key)![1] as string))]
    const archived = new Set(
      (
        await inChunks(
          workbookIds,
          async (chunk) =>
            (await db.prepare(`SELECT id FROM workbooks WHERE archived_at IS NOT NULL AND id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(chunk)).all<{ id: string }>()).results,
        )
      ).map((r) => r.id),
    )
    const graceEnd = now.getTime() - IMAGE_CLEANUP_GRACE_DAYS * 24 * 3600_000
    const deletable: Array<Listed & { workbookId: string; imageId: string }> = []
    for (const image of images) {
      const [, workbookId, imageId] = IMAGE_KEY.exec(image.key) as unknown as [string, string, string]
      if (referenced.has(imageId)) outcome.kept.referenced++
      else if (image.uploaded > graceEnd) outcome.kept.grace++
      else if (archived.has(workbookId)) outcome.kept.archived++
      else if (newestUnread !== null && newestUnread >= image.uploaded - IMAGE_CLEANUP_MARGIN_MS) outcome.kept.unscanned++
      else deletable.push({ ...image, workbookId, imageId })
    }
    deletable.sort((a, b) => a.uploaded - b.uploaded)

    for (const image of deletable) {
      if (outcome.deleted >= limits.deletions) {
        outcome.deferred++
        continue
      }
      if (!(await backups.head(`images/${image.key}`))) {
        outcome.kept.noBackupCopy++
        continue
      }
      // Read again right before: the object deleted is the one judged.
      const current = await env.ATTACHMENTS.head(image.key)
      if (!current || current.etag !== image.etag) {
        outcome.kept.changed++
        continue
      }
      // Logged before the deletion: a deletion is never unrecorded.
      await auditStatement(
        db,
        {
          actorId: null,
          action: 'image.cleanup',
          entityType: 'image',
          entityId: image.imageId,
          workbookId: image.workbookId,
          details: {
            key: image.key,
            size: image.size,
            uploaded: new Date(image.uploaded).toISOString(),
            uploadedBy: current.customMetadata?.uploadedBy ?? null,
            origin: current.customMetadata?.origin ?? null,
            sha256: current.customMetadata?.sha256 ?? null,
            backupCopy: `images/${image.key}`,
            graceDays: IMAGE_CLEANUP_GRACE_DAYS,
          },
        },
        at,
      ).run()
      await env.ATTACHMENTS.delete(image.key)
      outcome.deleted++
    }
  } catch (error) {
    outcome.error = error instanceof Error ? error.name : 'unknown'
    console.error(`image clean-up stopped (${outcome.error})`)
  }
  return outcome
}
