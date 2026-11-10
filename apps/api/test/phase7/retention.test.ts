// Backup retention (owner decision 2026-11-10, B2): the newest 30 complete
// runs plus the first complete run of each of the last 12 months stay; older
// runs' files are removed from the BACKUPS bucket only. These tests prove
// that nothing else is ever deleted: not another bucket, not a D1 row, not a
// kept run's file, not an object the runs do not own.
//
// Each test works in its own era (years apart, the later tests further in the
// past): a run newer than the one that just succeeded is never touched nor
// counted, so the eras do not see each other.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { BackupRetentionResponse, BackupRunsResponse } from '@naf-sheets/shared'
import type { Env } from '../../src/env'
import { planRetention, runBackup, saveBackupRetention } from '../../src/phase7'
import type { RunFacts } from '../../src/phase7'
import { call, createWorkbook, json, seedMember, testApp } from '../helpers'

const app = testApp()
const DAY = 24 * 3600_000

async function listAll(bucket: R2Bucket, prefix = ''): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) })
    for (const o of page.objects) out.set(o.key, o.etag)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return out
}

async function tableCounts(): Promise<Map<string, number>> {
  const { results } = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`).all<{ name: string }>()
  const out = new Map<string, number>()
  for (const { name } of results) {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).first<{ n: number }>()
    out.set(name, row?.n ?? 0)
  }
  return out
}

interface Seeded {
  id: string
  startedAt: string
  keys: string[]
}

/**
 * An old run as runBackup leaves it: its row, a few export files, its
 * snapshot list (unless `legacy`) and, when complete, its manifest.
 */
async function seedRun(at: Date, options: { status?: RunFacts['status']; manifest?: boolean; legacy?: boolean; copies?: string[] } = {}): Promise<Seeded> {
  const status = options.status ?? 'succeeded'
  const id = `${at.toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`
  const startedAt = at.toISOString()
  await env.DB.prepare(`INSERT INTO backup_runs (id, started_at, finished_at, status, details_json) VALUES (?1, ?2, ?3, ?4, '{}')`)
    .bind(id, startedAt, status === 'running' ? null : startedAt, status)
    .run()
  const bucket = env.BACKUPS!
  const keys = [`d1/${id}/schema.json`, `d1/${id}/members/00001.ndjson`, `d1/${id}/audit_log/00001.ndjson`]
  if (status !== 'skipped') {
    for (const key of keys) await bucket.put(key, '{}\n')
    if (!options.legacy) {
      const list = (options.copies ?? []).map((k) => JSON.stringify({ key: k })).join('\n')
      await bucket.put(`d1/${id}/snapshot-copies.ndjson`, list)
      keys.push(`d1/${id}/snapshot-copies.ndjson`)
    }
    if (options.manifest ?? status === 'succeeded') {
      await bucket.put(`d1/${id}/manifest.json`, '{}')
      keys.push(`d1/${id}/manifest.json`)
    }
    for (const copy of options.copies ?? []) if (!(await bucket.head(copy))) await bucket.put(copy, '{"copy":true}')
  } else {
    keys.length = 0
  }
  return { id, startedAt, keys }
}

/** Buckets that record every delete; SNAPSHOTS and ATTACHMENTS refuse any. */
function guardedEnv(): { env: Env; deleted: string[]; forbidden: string[] } {
  const deleted: string[] = []
  const forbidden: string[] = []
  const wrap = (bucket: R2Bucket, name: string, allow: boolean): R2Bucket =>
    new Proxy(bucket, {
      get(target, prop) {
        if (prop === 'delete') {
          return async (keys: string | string[]) => {
            const list = Array.isArray(keys) ? keys : [keys]
            if (!allow) {
              forbidden.push(...list.map((k) => `${name}:${k}`))
              throw new Error(`delete on ${name}`)
            }
            deleted.push(...list)
            return target.delete(keys)
          }
        }
        const value = Reflect.get(target, prop) as unknown
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    })
  const base = env as Env
  return {
    env: { ...base, BACKUPS: wrap(base.BACKUPS!, 'BACKUPS', true), SNAPSHOTS: wrap(base.SNAPSHOTS, 'SNAPSHOTS', false), ATTACHMENTS: wrap(base.ATTACHMENTS, 'ATTACHMENTS', false) },
    deleted,
    forbidden,
  }
}

const facts = (id: string, startedAt: string, complete = true, status: RunFacts['status'] = 'succeeded'): RunFacts => ({ id, startedAt, status, complete, prunedAt: null })

describe('planRetention (pure)', () => {
  it('keeps the newest 30 complete runs and the first complete run of each of the last 12 months', () => {
    // One run a day from 2025-01-01 to 2026-03-31.
    const runs: RunFacts[] = []
    for (let t = Date.UTC(2025, 0, 1, 0, 23); t <= Date.UTC(2026, 2, 31, 0, 23); t += DAY) runs.push(facts(`r${t}`, new Date(t).toISOString()))
    const newest = runs[runs.length - 1]!
    const plan = planRetention(runs, newest, { keepDaily: 30, keepMonthly: 12 })
    const daily = [...plan.keep].filter(([, as]) => as.includes('daily')).map(([id]) => id)
    expect(daily).toEqual(runs.slice(-30).map((r) => r.id).reverse())
    const monthly = [...plan.keep].filter(([, as]) => as.includes('monthly')).map(([id]) => runs.find((r) => r.id === id)!.startedAt.slice(0, 10)).sort()
    // 2025-04 … 2026-03: twelve months, each on its 1st.
    expect(monthly).toEqual(['2025-04-01', '2025-05-01', '2025-06-01', '2025-07-01', '2025-08-01', '2025-09-01', '2025-10-01', '2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01', '2026-03-01'])
    // Everything else is removed, and nothing kept is removed.
    expect(plan.prune.length + plan.keep.size).toBe(runs.length)
    for (const r of plan.prune) expect(plan.keep.has(r.id)).toBe(false)
  })

  it('never counts an incomplete run as a keeper, and removes old incomplete runs only', () => {
    const t = (d: number) => new Date(Date.UTC(2026, 0, 1 + d, 0, 23)).toISOString()
    const runs = [
      facts('ok-1', t(0)),
      facts('failed', t(1), false, 'failed'),
      facts('no-manifest', t(2), false, 'succeeded'),
      facts('dead-running', t(3), false, 'running'),
      facts('skipped', t(4), false, 'skipped'),
      facts('ok-2', t(5)),
      facts('fresh-running', t(5.5), false, 'running'),
      facts('ok-3', t(6)),
    ]
    const plan = planRetention(runs, runs[7]!, { keepDaily: 2, keepMonthly: 0 })
    expect([...plan.keep.keys()].sort()).toEqual(['ok-2', 'ok-3'])
    // The incomplete runs never took a daily slot: two complete runs are kept.
    expect(plan.prune.map((r) => r.id)).toEqual(['ok-1', 'failed', 'no-manifest', 'dead-running'])
  })

  it('touches nothing newer than the run that just succeeded, and nothing already removed', () => {
    const runs = [facts('old', '2026-01-01T00:23:00.000Z'), { ...facts('gone', '2026-01-02T00:23:00.000Z'), prunedAt: '2026-02-01T00:00:00.000Z' }, facts('now', '2026-01-03T00:23:00.000Z'), facts('later', '2026-01-04T00:23:00.000Z')]
    const plan = planRetention(runs, runs[2]!, { keepDaily: 1, keepMonthly: 0 })
    expect(plan.prune.map((r) => r.id)).toEqual(['old'])
    expect(plan.keep.has('now')).toBe(true)
  })
})

describe('runBackup with retention', () => {
  it('removes old runs’ files from BACKUPS only, logs each removal, and deletes nothing else anywhere', async () => {
    // Era: 1999. 40 complete daily runs (Nov 20 → Dec 29), a failed one and an old manifest-less one.
    const owner = await seedMember('editor')
    await createWorkbook(app, owner, 'ملف حيّ لا يُمس')
    await env.ATTACHMENTS.put(`retention-test/${crypto.randomUUID()}`, 'live attachment')
    const shared = `snapshots/workbooks/retention-wb/snapshots/1.json`
    const onlyOld = `snapshots/workbooks/retention-wb-old/snapshots/7.json`
    const runs: Seeded[] = []
    for (let d = 0; d < 40; d++) {
      const at = new Date(Date.UTC(1999, 10, 20 + d, 0, 23))
      runs.push(await seedRun(at, { copies: d < 5 ? [onlyOld, shared] : [shared] }))
    }
    const failed = await seedRun(new Date(Date.UTC(1999, 10, 25, 1, 0)), { status: 'failed', manifest: false })
    const noManifest = await seedRun(new Date(Date.UTC(1999, 11, 28, 1, 0)), { status: 'succeeded', manifest: false })
    // Objects in BACKUPS that no run owns: never touched.
    await env.BACKUPS!.put('d1/not-a-known-run/schema.json', '{}')
    await env.BACKUPS!.put('elsewhere/readme.txt', 'not a run')

    const guarded = guardedEnv()
    const before = { snapshots: await listAll(env.SNAPSHOTS), attachments: await listAll(env.ATTACHMENTS), backups: await listAll(env.BACKUPS!), tables: await tableCounts() }
    const kv = await env.SETTINGS.list()
    const result = await runBackup(guarded.env, new Date(Date.UTC(1999, 11, 30, 0, 23)))
    expect(result.status).toBe('succeeded')
    const retention = result.details!.retention!
    expect(retention.error).toBeNull()

    // Nothing was ever asked of another bucket.
    expect(guarded.forbidden).toEqual([])
    expect(await listAll(env.SNAPSHOTS)).toEqual(before.snapshots)
    expect(await listAll(env.ATTACHMENTS)).toEqual(before.attachments)
    expect((await env.SETTINGS.list()).keys.map((k) => k.name)).toEqual(kv.keys.map((k) => k.name))

    // Kept: the newest run + 29 newest seeded complete runs (daily) + the first of Nov and Dec 1999 (monthly).
    const keptSeeded = new Set(runs.slice(-29).map((r) => r.id))
    keptSeeded.add(runs[0]!.id) // 1999-11-20: the first complete run of November
    keptSeeded.add(runs[11]!.id) // 1999-12-01: the first of December
    const removedRuns = [...runs.filter((r) => !keptSeeded.has(r.id)), failed, noManifest]
    expect(retention.removed.map((r) => r.id).sort()).toEqual(removedRuns.map((r) => r.id).sort())
    expect(retention.runsKept).toBe(keptSeeded.size + 1)

    // Exactly these keys were deleted: the removed runs' files, and the copy only they listed.
    const expected = new Set([...removedRuns.flatMap((r) => r.keys)])
    // runs[0] (kept) lists onlyOld too, so it stays.
    expect(new Set(guarded.deleted)).toEqual(expected)
    const after = await listAll(env.BACKUPS!)
    for (const [key, etag] of before.backups) {
      if (expected.has(key)) expect(after.has(key)).toBe(false)
      else expect(after.get(key)).toBe(etag)
    }
    expect(after.has(shared)).toBe(true)
    expect(after.has(onlyOld)).toBe(true)
    expect(after.has('d1/not-a-known-run/schema.json')).toBe(true)
    expect(after.has('elsewhere/readme.txt')).toBe(true)
    for (const id of keptSeeded) expect(after.has(`d1/${id}/manifest.json`)).toBe(true)

    // D1: no row deleted anywhere; the run rows are marked, every removal is in the audit log.
    const tables = await tableCounts()
    for (const [name, n] of before.tables) {
      if (name === 'backup_runs') expect(tables.get(name)).toBe(n + 1)
      else if (name === 'audit_log') expect(tables.get(name)).toBe(n + removedRuns.length)
      else expect(tables.get(name)).toBe(n)
    }
    for (const r of removedRuns) {
      const row = await env.DB.prepare(`SELECT pruned_at, pruned_objects, pruned_by_run FROM backup_runs WHERE id = ?1`).bind(r.id).first<{ pruned_at: string; pruned_objects: number; pruned_by_run: string }>()
      expect(row).toMatchObject({ pruned_by_run: result.runId, pruned_objects: r.keys.length })
      const audit = await env.DB.prepare(`SELECT actor_id, details_json FROM audit_log WHERE action = 'backup.prune' AND entity_id = ?1`).bind(r.id).first<{ actor_id: string | null; details_json: string }>()
      expect(audit?.actor_id).toBeNull()
      expect(JSON.parse(audit!.details_json)).toMatchObject({ objects: r.keys.length, prefix: `d1/${r.id}/`, byRun: result.runId })
    }
    for (const id of keptSeeded) {
      expect((await env.DB.prepare(`SELECT pruned_at FROM backup_runs WHERE id = ?1`).bind(id).first<{ pruned_at: string | null }>())?.pruned_at).toBeNull()
    }

    // The next day, 1999-12-01 leaves the 30 newest but stays as December's first: nothing goes.
    const second = guardedEnv()
    const next = await runBackup(second.env, new Date(Date.UTC(1999, 11, 31, 0, 23)))
    expect(second.forbidden).toEqual([])
    expect(next.details!.retention!.removed).toEqual([])
    // The day after, 1999-12-02 leaves the 30 newest and is no month's first: only it goes.
    const third = guardedEnv()
    const later = await runBackup(third.env, new Date(Date.UTC(2000, 0, 1, 0, 23)))
    expect(third.forbidden).toEqual([])
    expect(later.details!.retention!.removed.map((r) => r.id)).toEqual([runs[12]!.id])
    expect(new Set(third.deleted)).toEqual(new Set(runs[12]!.keys))
  })

  it('removes a snapshot copy once no remaining run lists it — and none while a kept run has no list', async () => {
    // Era: 1990.
    const gone = 'snapshots/workbooks/retention-1990/snapshots/1.json'
    const legacyRun = await seedRun(new Date(Date.UTC(1990, 5, 1, 0, 23)), { legacy: true })
    const old = await seedRun(new Date(Date.UTC(1990, 5, 2, 0, 23)), { copies: [gone] })
    await seedRun(new Date(Date.UTC(1990, 5, 3, 0, 23)), { copies: [] })
    await saveBackupRetention(env.SETTINGS, { keepDaily: 3, keepMonthly: 0 })
    try {
      // legacyRun is old enough to go, but `old` stays (3 newest: old, the 3rd, the new run) … so keepDaily 3 keeps `old`.
      const first = guardedEnv()
      const r1 = await runBackup(first.env, new Date(Date.UTC(1990, 5, 4, 0, 23)))
      expect(r1.details!.retention!.removed.map((r) => r.id)).toEqual([legacyRun.id])
      expect(await env.BACKUPS!.head(gone)).not.toBeNull()

      // Now `old` falls out; its copy is listed by no remaining run and goes with it.
      await seedRun(new Date(Date.UTC(1990, 5, 5, 0, 23)), { copies: [] })
      const second = guardedEnv()
      const r2 = await runBackup(second.env, new Date(Date.UTC(1990, 5, 6, 0, 23)))
      expect(r2.details!.retention!.removed.map((r) => r.id)).toContain(old.id)
      expect(r2.details!.retention!.snapshotCopiesRemoved).toBe(1)
      expect(second.deleted).toContain(gone)
      expect(second.forbidden).toEqual([])
      const audit = await env.DB.prepare(`SELECT details_json FROM audit_log WHERE action = 'backup.prune.snapshot_copies' ORDER BY id DESC LIMIT 1`).first<{ details_json: string }>()
      expect(JSON.parse(audit!.details_json)).toMatchObject({ byRun: r2.runId, count: 1, keys: [gone] })
    } finally {
      await saveBackupRetention(env.SETTINGS, { keepDaily: 30, keepMonthly: 12 })
    }
  })

  it('keeps every snapshot copy while a kept run predates the lists', async () => {
    // Era: 1985.
    const copy = 'snapshots/workbooks/retention-1985/snapshots/3.json'
    await seedRun(new Date(Date.UTC(1985, 0, 1, 0, 23)), { copies: [copy] })
    await seedRun(new Date(Date.UTC(1985, 0, 2, 0, 23)), { legacy: true })
    await saveBackupRetention(env.SETTINGS, { keepDaily: 2, keepMonthly: 0 })
    try {
      const guarded = guardedEnv()
      const result = await runBackup(guarded.env, new Date(Date.UTC(1985, 0, 3, 0, 23)))
      expect(result.details!.retention!.runsRemoved).toBe(1)
      expect(result.details!.retention!.snapshotCopies).toBe('kept_legacy_runs')
      expect(await env.BACKUPS!.head(copy)).not.toBeNull()
      expect(guarded.deleted.every((k) => k.startsWith('d1/'))).toBe(true)
    } finally {
      await saveBackupRetention(env.SETTINGS, { keepDaily: 30, keepMonthly: 12 })
    }
  })

  it('removes nothing when the run fails', async () => {
    // Era: 1980. Plenty of old runs, a policy that would remove them — and a run that fails before its manifest.
    for (let d = 0; d < 5; d++) await seedRun(new Date(Date.UTC(1980, 0, 1 + d, 0, 23)))
    await saveBackupRetention(env.SETTINGS, { keepDaily: 1, keepMonthly: 0 })
    try {
      const guarded = guardedEnv()
      const failing = new Proxy(guarded.env.BACKUPS!, {
        get(target, prop) {
          if (prop === 'put') {
            return async (key: string, value: string, options?: R2PutOptions) => {
              if (key.endsWith('/manifest.json')) throw new Error('bucket unavailable')
              return target.put(key, value, options)
            }
          }
          const value = Reflect.get(target, prop) as unknown
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
        },
      })
      const result = await runBackup({ ...guarded.env, BACKUPS: failing }, new Date(Date.UTC(1980, 0, 10, 0, 23)))
      expect(result.status).toBe('failed')
      expect(guarded.deleted).toEqual([])
      expect(guarded.forbidden).toEqual([])
    } finally {
      await saveBackupRetention(env.SETTINGS, { keepDaily: 30, keepMonthly: 12 })
    }
  })
})

describe('retention settings and the admin view', () => {
  it('admins read and change the policy (validated, audited); the list shows what the last run removed', async () => {
    const admin = await seedMember('admin')
    const editor = await seedMember('editor')
    expect((await call(app, 'PUT', '/api/admin/backups/retention', { user: editor, body: { keepDaily: 10, keepMonthly: 6 } })).status).toBe(403)
    for (const bad of [{ keepDaily: 0, keepMonthly: 12 }, { keepDaily: 30, keepMonthly: -1 }, { keepDaily: 1.5, keepMonthly: 2 }, { keepDaily: 400, keepMonthly: 2 }, { keepDaily: 30 }]) {
      const res = await call(app, 'PUT', '/api/admin/backups/retention', { user: admin, body: bad })
      expect(res.status).toBe(400)
      expect((await json<{ error: string }>(res)).error).toBe('invalid_request')
    }
    const saved = await json<BackupRetentionResponse>(await call(app, 'PUT', '/api/admin/backups/retention', { user: admin, body: { keepDaily: 10, keepMonthly: 6 } }))
    expect(saved.retention).toEqual({ keepDaily: 10, keepMonthly: 6 })
    const audit = await env.DB.prepare(`SELECT actor_id, details_json FROM audit_log WHERE action = 'settings.backup_retention' ORDER BY id DESC LIMIT 1`).first<{ actor_id: string; details_json: string }>()
    expect(audit?.actor_id).toBe(admin.id)
    expect(JSON.parse(audit!.details_json)).toEqual({ keepDaily: 10, keepMonthly: 6 })

    await runBackup(env as Env)
    const body = await json<BackupRunsResponse>(await call(app, 'GET', '/api/admin/backups', { user: admin }))
    expect(body.retention).toEqual({ keepDaily: 10, keepMonthly: 6 })
    expect(body.lastPrune).toMatchObject({ runsKept: expect.any(Number), message: null })
    expect(body.runs[0]).toHaveProperty('prunedAt')
    await call(app, 'PUT', '/api/admin/backups/retention', { user: admin, body: { keepDaily: 30, keepMonthly: 12 } })
  })
})
