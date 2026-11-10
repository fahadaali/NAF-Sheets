import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { readSnapshot } from '../../src/snapshot'
import { updateLatestSnapshot } from '../../src/sync/workbook-writer'
import { call, createWorkbook, json, seedMember, testApp } from '../helpers'

const app = testApp()

type Snap = { id: string; name: string; marker?: number }

async function version(id: string): Promise<number> {
  const row = await env.DB.prepare('SELECT current_snapshot_version AS v FROM workbooks WHERE id = ?1').bind(id).first<{ v: number }>()
  return row?.v ?? -1
}

async function setup() {
  const owner = await seedMember('editor')
  const id = await createWorkbook(app, owner)
  return { owner, id }
}

describe('updateLatestSnapshot', () => {
  it('applies the change to the latest snapshot and commits version N+1 in R2 and D1', async () => {
    const { owner, id } = await setup()
    const out = await updateLatestSnapshot(env, id, owner.id, (snapshot, base) => ({
      snapshot: { ...(snapshot as Snap), marker: base },
      result: 'done',
    }))
    expect(out).toEqual({ status: 'written', version: 2, result: 'done' })
    expect(await version(id)).toBe(2)
    expect(((await readSnapshot(env, id, 2)) as Snap).marker).toBe(1)
    // The browser reads the server write like any other version.
    const res = await call(app, 'GET', `/api/workbooks/${id}`, { user: owner })
    expect(await json<{ version: number }>(res)).toMatchObject({ version: 2 })
  })

  it('writes nothing when the change returns no snapshot', async () => {
    const { owner, id } = await setup()
    const out = await updateLatestSnapshot(env, id, owner.id, () => ({ snapshot: null, result: 0 }))
    expect(out).toEqual({ status: 'unchanged', version: 1, result: 0 })
    expect(await version(id)).toBe(1)
    expect(await env.SNAPSHOTS.head(`workbooks/${id}/snapshots/2.json`)).toBeNull()
  })

  it('re-runs the change on a fresh read when a browser save wins the race, keeping both edits', async () => {
    const { owner, id } = await setup()
    let runs = 0
    const out = await updateLatestSnapshot(env, id, owner.id, async (snapshot, base) => {
      runs++
      if (runs === 1) {
        // A browser saves version 2 while this change is being computed.
        const res = await call(app, 'PUT', `/api/workbooks/${id}/snapshot`, {
          user: owner,
          body: { baseVersion: base, snapshot: { ...(snapshot as Snap), name: 'من المتصفح' } },
        })
        expect(res.status).toBe(200)
      }
      return { snapshot: { ...(snapshot as Snap), marker: base }, result: runs }
    })
    expect(out).toEqual({ status: 'written', version: 3, result: 2 })
    const latest = (await readSnapshot(env, id, 3)) as Snap
    expect(latest).toMatchObject({ name: 'من المتصفح', marker: 2 })
  })

  it('reports not_found for an unknown or archived workbook and never calls the change', async () => {
    const { owner, id } = await setup()
    let called = false
    const change = () => {
      called = true
      return { snapshot: {}, result: null }
    }
    expect(await updateLatestSnapshot(env, 'no-such-workbook', owner.id, change)).toEqual({ status: 'not_found' })
    await env.DB.prepare('UPDATE workbooks SET archived_at = ?1 WHERE id = ?2').bind(new Date().toISOString(), id).run()
    expect(await updateLatestSnapshot(env, id, owner.id, change)).toEqual({ status: 'not_found' })
    expect(called).toBe(false)
  })

  it('gives up as contended after losing every attempt, leaving the winner intact', async () => {
    const { owner, id } = await setup()
    const out = await updateLatestSnapshot(
      env,
      id,
      owner.id,
      async (snapshot, base) => {
        const res = await call(app, 'PUT', `/api/workbooks/${id}/snapshot`, { user: owner, body: { baseVersion: base, snapshot } })
        expect(res.status).toBe(200)
        return { snapshot: { ...(snapshot as Snap), marker: -1 }, result: null }
      },
      { attempts: 2 },
    )
    expect(out).toEqual({ status: 'contended' })
    expect(await version(id)).toBe(3)
    expect(((await readSnapshot(env, id, 3)) as Snap).marker).toBeUndefined()
  })
})
