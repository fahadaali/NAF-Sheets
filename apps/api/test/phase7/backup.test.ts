// Daily backup (spec §14): D1 export and copies of the latest snapshots into a
// separate bucket. Create-only; never deletes; an admin sees each run.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { BackupRunsResponse } from '@naf-sheets/shared'
import { BACKUP_CRON, handleScheduled } from '../../src/background'
import type { Env } from '../../src/env'
import { runBackup } from '../../src/phase7'
import { snapshotKey } from '../../src/snapshot'
import { call, createWorkbook, isArabic, json, seedMember, testApp } from '../helpers'

const app = testApp()

async function listAll(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = []
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) })
    keys.push(...page.objects.map((o) => o.key))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return keys
}

async function readNdjson(bucket: R2Bucket, keys: string[]): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = []
  for (const key of keys) {
    const text = await (await bucket.get(key))!.text()
    for (const line of text.split('\n')) if (line) rows.push(JSON.parse(line) as Record<string, unknown>)
  }
  return rows
}

describe('runBackup', () => {
  it('exports every D1 table and copies each live workbook’s latest snapshot, then a manifest', async () => {
    const owner = await seedMember('editor')
    const id = await createWorkbook(app, owner, 'ملف النسخ الاحتياطي')
    const result = await runBackup(env as Env)
    expect(result.status).toBe('succeeded')
    const bucket = env.BACKUPS!
    const prefix = `d1/${result.runId}`

    const manifest = (await (await bucket.get(`${prefix}/manifest.json`))!.json()) as { tables: Array<{ name: string; rows: number }>; rows: number }
    const names = manifest.tables.map((t) => t.name)
    for (const table of ['members', 'workbooks', 'sheets', 'tasks', 'audit_log', 'templates', 'api_tokens', 'backup_runs']) expect(names).toContain(table)

    const workbooks = await readNdjson(bucket, await listAll(bucket, `${prefix}/workbooks/`))
    expect(workbooks.find((w) => w.id === id)).toMatchObject({ title: 'ملف النسخ الاحتياطي', owner_id: owner.id })
    expect(manifest.tables.find((t) => t.name === 'workbooks')?.rows).toBe(workbooks.length)
    expect(await bucket.head(`${prefix}/schema.json`)).not.toBeNull()
    expect(await bucket.head(`snapshots/${snapshotKey(id, 1)}`)).not.toBeNull()
    expect((await listAll(bucket, `${prefix}/r2-inventory/`)).length).toBeGreaterThan(0)

    // A second run copies nothing already there and replaces nothing.
    const firstCopy = await bucket.head(`snapshots/${snapshotKey(id, 1)}`)
    const again = await runBackup(env as Env)
    expect(again.status).toBe('succeeded')
    expect(again.details?.snapshotsCopied).toBe(0)
    expect(again.details?.snapshotsPresent).toBeGreaterThan(0)
    expect((await bucket.head(`snapshots/${snapshotKey(id, 1)}`))?.etag).toBe(firstCopy?.etag)
    expect(await bucket.head(`${prefix}/manifest.json`)).not.toBeNull()
    // The source bucket is untouched.
    expect(await env.SNAPSHOTS.head(snapshotKey(id, 1))).not.toBeNull()
  })

  it('pages large tables', async () => {
    const owner = await seedMember('editor')
    const statements = Array.from({ length: 1205 }, (_, i) =>
      env.DB.prepare(`INSERT INTO audit_log (at, actor_id, action, entity_type, entity_id) VALUES (?1, ?2, 'test.page', 'test', ?3)`).bind(new Date().toISOString(), owner.id, `e-${i}`),
    )
    await env.DB.batch(statements)
    const result = await runBackup(env as Env)
    const audit = result.details!.tables.find((t) => t.name === 'audit_log')!
    expect(audit.pages).toBe(Math.ceil(audit.rows / 1000))
    expect(audit.pages).toBeGreaterThanOrEqual(2)
    const rows = await readNdjson(env.BACKUPS!, await listAll(env.BACKUPS!, `d1/${result.runId}/audit_log/`))
    expect(rows.length).toBe(audit.rows)
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  })

  it('without a BACKUPS bucket, records the run as skipped and writes nothing', async () => {
    const { BACKUPS: _none, ...rest } = env as Env
    const result = await runBackup(rest as Env)
    expect(result).toMatchObject({ status: 'skipped', error: 'no_bucket' })
    const row = await env.DB.prepare('SELECT status, error FROM backup_runs WHERE id = ?1').bind(result.runId).first()
    expect(row).toEqual({ status: 'skipped', error: 'no_bucket' })
    expect(await listAll(env.BACKUPS!, `d1/${result.runId}/`)).toEqual([])
  })

  it('runs from the daily cron only; the 15-minute cron stays the reconciliation', async () => {
    const before = (await env.DB.prepare('SELECT COUNT(*) AS n FROM backup_runs').first<{ n: number }>())!.n
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext
    await handleScheduled({ cron: BACKUP_CRON, scheduledTime: Date.now(), noRetry: () => {} } as ScheduledController, env as Env, ctx)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM backup_runs').first<{ n: number }>())!.n).toBe(before + 1)
  })
})

describe('GET /api/admin/backups', () => {
  it('shows the latest runs to admins only, with an Arabic message on a run that did not succeed', async () => {
    const admin = await seedMember('admin')
    const editor = await seedMember('editor')
    const { BACKUPS: _none, ...rest } = env as Env
    await runBackup(rest as Env)
    expect((await call(app, 'GET', '/api/admin/backups', { user: editor })).status).toBe(403)
    const body = await json<BackupRunsResponse>(await call(app, 'GET', '/api/admin/backups', { user: admin }))
    expect(body.configured).toBe(true)
    const skipped = body.runs.find((r) => r.status === 'skipped')
    expect(isArabic(skipped?.message)).toBe(true)
    expect(body.runs.length).toBeLessThanOrEqual(14)
  })
})
