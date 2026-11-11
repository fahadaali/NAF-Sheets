// Clean-up of picture files nothing refers to (src/images/cleanup.ts, apps/api
// OPEN_QUESTIONS.md "Images" I9, owner 2026-11-11): a picture referred to by
// any kept snapshot version or backup copy stays; one inside the grace period
// stays; an archived workbook's stays; one without a backup copy stays; an
// orphan past the grace period goes, logged first; the per-run bounds hold;
// nothing but pictures is ever touched.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { imagePath } from '@naf-sheets/shared'
import type { Env } from '../../src/env'
import { cleanUpImages, IMAGE_CLEANUP_GRACE_DAYS, IMAGE_CLEANUP_LIMITS, imageReferences } from '../../src/images/cleanup'
import { imageKey, storeImage } from '../../src/images/store'
import { runBackup } from '../../src/phase7'
import { createWorkbook, seedMember, testApp } from '../helpers'
import { PNG_1PX } from './png'

const app = testApp()
const e = env as Env
const DAY = 24 * 3600_000
/** A moment past the grace period of every picture stored by these tests. */
const later = () => new Date(Date.now() + (IMAGE_CLEANUP_GRACE_DAYS + 1) * DAY)

async function picture(workbookId: string, withBackupCopy = true): Promise<{ imageId: string; key: string }> {
  const stored = await storeImage(e, workbookId, PNG_1PX, { uploadedBy: 'test-user', origin: 'editor' })
  if (!stored.ok) throw new Error('not stored')
  const key = imageKey(workbookId, stored.imageId)
  if (withBackupCopy) await env.BACKUPS!.put(`images/${key}`, PNG_1PX)
  return { imageId: stored.imageId, key }
}

/** A snapshot version as src/snapshot.ts writes it, holding the picture in a cell (Univer's cell-image document). */
async function version(workbookId: string, v: number, sources: string[]): Promise<void> {
  const drawings = Object.fromEntries(sources.map((s, i) => [`d${i}`, { drawingId: `d${i}`, imageSourceType: 'URL', source: s }]))
  const snapshot = { id: workbookId, sheets: { s1: { id: 's1', cellData: { 1: { 6: { p: { drawings } } } } } } }
  await env.SNAPSHOTS.put(`workbooks/${workbookId}/snapshots/${v}.json`, JSON.stringify(snapshot), { onlyIf: { etagDoesNotMatch: '*' } })
}

async function cleanupAudit(imageId: string) {
  const { results } = await env.DB.prepare(`SELECT id, actor_id, workbook_id, details_json FROM audit_log WHERE action = 'image.cleanup' AND entity_id = ?1`).bind(imageId).all<{
    id: number
    actor_id: string | null
    workbook_id: string
    details_json: string
  }>()
  return results
}

describe('image references', () => {
  it('finds a picture id however its URL is written', () => {
    const wb = crypto.randomUUID()
    const id = 'a'.repeat(32)
    expect(imageReferences(JSON.stringify({ source: imagePath(wb, id) }))).toEqual(new Map([[id, wb]]))
    expect(imageReferences(JSON.stringify({ data: JSON.stringify({ source: `https://sheets.naflaw.sa${imagePath(wb, id)}` }) })).get(id)).toBe(wb)
    expect(imageReferences(`images\\/${id}`).has(id)).toBe(true)
    expect(imageReferences(`%2Fimages%2F${id}`).has(id)).toBe(true)
    expect(imageReferences(`images/${id}0`).size).toBe(0)
  })
})

describe('picture clean-up', () => {
  it('in the daily backup: keeps a picture an old kept version refers to, deletes an orphan past the grace period and logs it first', async () => {
    const owner = await seedMember('editor')
    const wb = await createWorkbook(app, owner)
    const used = await picture(wb, false)
    // An old version refers to it; the newest one no longer does (the picture was removed from the sheet).
    await version(wb, 1001, [imagePath(wb, used.imageId)])
    await version(wb, 1002, [])
    // The pictures of an import that failed: a workbook id with no workbook row, no snapshot.
    const failedImport = crypto.randomUUID()
    const orphan = await picture(failedImport, false)
    // A phase 5 file and an odd key under the same prefix: never pictures, never touched.
    await env.ATTACHMENTS.put(`attachments/${wb}/some-task/file-1`, 'a phase 5 file')
    await env.ATTACHMENTS.put(`workbooks/${wb}/images/not-an-image-id`, 'x')

    const result = await runBackup(e, later())
    expect(result.status).toBe('succeeded')
    const outcome = result.details!.imageCleanup!
    expect(outcome.error).toBeNull()
    expect(outcome.deleted).toBeGreaterThanOrEqual(1)

    expect(await env.ATTACHMENTS.head(used.key)).not.toBeNull()
    expect(await env.ATTACHMENTS.head(orphan.key)).toBeNull()
    // The backup's copy of the deleted picture stays: it can be restored.
    expect(await env.BACKUPS!.head(`images/${orphan.key}`)).not.toBeNull()
    expect(await env.ATTACHMENTS.head(`attachments/${wb}/some-task/file-1`)).not.toBeNull()
    expect(await env.ATTACHMENTS.head(`workbooks/${wb}/images/not-an-image-id`)).not.toBeNull()

    const audit = await cleanupAudit(orphan.imageId)
    expect(audit).toHaveLength(1)
    expect(audit[0]!.actor_id).toBeNull()
    expect(audit[0]!.workbook_id).toBe(failedImport)
    expect(JSON.parse(audit[0]!.details_json)).toMatchObject({ key: orphan.key, size: PNG_1PX.byteLength, uploadedBy: 'test-user', origin: 'editor', backupCopy: `images/${orphan.key}`, graceDays: 30 })
    expect(await cleanupAudit(used.imageId)).toEqual([])
    // The outcome is kept with the run.
    const row = await env.DB.prepare(`SELECT details_json FROM backup_runs WHERE id = ?1`).bind(result.runId).first<{ details_json: string }>()
    expect(JSON.parse(row!.details_json).imageCleanup).toMatchObject({ deleted: outcome.deleted })
  })

  it('keeps a picture only a snapshot copy in the backup bucket refers to', async () => {
    const wb = crypto.randomUUID()
    const p = await picture(wb)
    await env.BACKUPS!.put(`snapshots/workbooks/${crypto.randomUUID()}/snapshots/3.json`, JSON.stringify({ src: imagePath(wb, p.imageId) }))
    const outcome = await cleanUpImages(e, env.BACKUPS!, later())
    expect(outcome.error).toBeNull()
    expect(await env.ATTACHMENTS.head(p.key)).not.toBeNull()
    expect(await cleanupAudit(p.imageId)).toEqual([])
  })

  it('keeps a picture another workbook’s version or a template refers to', async () => {
    const wb = crypto.randomUUID()
    const p = await picture(wb)
    await env.SNAPSHOTS.put(`templates/${crypto.randomUUID()}/snapshot.json`, JSON.stringify({ source: imagePath(wb, p.imageId) }))
    await cleanUpImages(e, env.BACKUPS!, later())
    expect(await env.ATTACHMENTS.head(p.key)).not.toBeNull()
  })

  it('keeps an unreferenced picture inside the grace period', async () => {
    const p = await picture(crypto.randomUUID())
    const outcome = await cleanUpImages(e, env.BACKUPS!, new Date(Date.now() + (IMAGE_CLEANUP_GRACE_DAYS - 1) * DAY))
    expect(outcome.kept.grace).toBeGreaterThanOrEqual(1)
    expect(await env.ATTACHMENTS.head(p.key)).not.toBeNull()
  })

  it('keeps every picture of an archived workbook', async () => {
    const owner = await seedMember('editor')
    const wb = await createWorkbook(app, owner)
    const p = await picture(wb)
    await env.DB.prepare(`UPDATE workbooks SET archived_at = ?2 WHERE id = ?1`).bind(wb, new Date().toISOString()).run()
    const outcome = await cleanUpImages(e, env.BACKUPS!, later())
    expect(outcome.kept.archived).toBeGreaterThanOrEqual(1)
    expect(await env.ATTACHMENTS.head(p.key)).not.toBeNull()
  })

  it('keeps an orphan the backup bucket holds no copy of', async () => {
    const p = await picture(crypto.randomUUID(), false)
    const outcome = await cleanUpImages(e, env.BACKUPS!, later())
    expect(outcome.kept.noBackupCopy).toBeGreaterThanOrEqual(1)
    expect(await env.ATTACHMENTS.head(p.key)).not.toBeNull()
  })

  it('keeps a picture while a snapshot written after it is still unread, and reads it on a later run', async () => {
    const wb = crypto.randomUUID()
    const p = await picture(wb)
    // Read everything there is, then a new version appears that the next run may not read.
    await cleanUpImages(e, env.BACKUPS!, new Date())
    await version(wb, 7, [])
    const limited = await cleanUpImages(e, env.BACKUPS!, later(), { ...IMAGE_CLEANUP_LIMITS, scanObjects: 0 })
    expect(limited.scanBacklog).toBeGreaterThanOrEqual(1)
    expect(limited.kept.unscanned).toBeGreaterThanOrEqual(1)
    expect(await env.ATTACHMENTS.head(p.key)).not.toBeNull()
    const full = await cleanUpImages(e, env.BACKUPS!, later())
    expect(full.scanBacklog).toBe(0)
    expect(await env.ATTACHMENTS.head(p.key)).toBeNull()
  })

  it('deletes at most the per-run bound, oldest first, and the rest on later runs', async () => {
    const wb = crypto.randomUUID()
    const mine = [] as Array<{ imageId: string; key: string }>
    for (let i = 0; i < 5; i++) mine.push(await picture(wb))
    const exists = async () => (await Promise.all(mine.map((p) => env.ATTACHMENTS.head(p.key)))).filter((o) => o !== null).length
    const first = await cleanUpImages(e, env.BACKUPS!, later(), { ...IMAGE_CLEANUP_LIMITS, deletions: 2 })
    expect(first.deleted).toBe(2)
    expect(first.deferred).toBeGreaterThanOrEqual(3)
    const left = await exists()
    expect(left).toBeGreaterThanOrEqual(3)
    const second = await cleanUpImages(e, env.BACKUPS!, later(), { ...IMAGE_CLEANUP_LIMITS, deletions: 2 })
    expect(second.deleted).toBe(2)
    await cleanUpImages(e, env.BACKUPS!, later())
    expect(await exists()).toBe(0)
    for (const p of mine) expect(await cleanupAudit(p.imageId)).toHaveLength(1)
  })

  it('does nothing when there is no picture at all to judge, and reads no snapshot', async () => {
    const before = await env.DB.prepare(`SELECT COUNT(*) AS n FROM image_ref_scans`).first<{ n: number }>()
    const images = await env.ATTACHMENTS.list({ prefix: 'workbooks/' })
    if (images.objects.some((o) => /\/images\/[0-9a-f]{32}$/.test(o.key))) return // storage shared with earlier tests: covered above
    const outcome = await cleanUpImages(e, env.BACKUPS!, later())
    expect(outcome).toMatchObject({ images: 0, scanned: 0, deleted: 0 })
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM image_ref_scans`).first<{ n: number }>())?.n).toBe(before?.n)
  })
})
