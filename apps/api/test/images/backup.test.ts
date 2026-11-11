// The daily backup copies every picture (src/phase7/backup.ts copyImages):
// once, create-only, and the retention policy never removes it.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { Env } from '../../src/env'
import { runBackup } from '../../src/phase7'
import { createWorkbook, json, seedMember, TEST_USER_HEADER, testApp } from '../helpers'
import { PNG_1PX } from './png'

const app = testApp()

describe('backups of pictures', () => {
  it('copies each picture into images/… of the backup bucket once; the next run finds it there', async () => {
    const owner = await seedMember('editor')
    const wb = await createWorkbook(app, owner)
    const res = await app.request(`/api/workbooks/${wb}/images`, { method: 'POST', headers: { [TEST_USER_HEADER]: owner.id, 'content-length': String(PNG_1PX.byteLength) }, body: PNG_1PX }, env)
    const { imageId } = await json<{ imageId: string }>(res)
    const first = await runBackup(env as Env)
    expect(first.status).toBe('succeeded')
    expect(first.details?.imagesCopied).toBeGreaterThanOrEqual(1)
    const copy = await env.BACKUPS!.get(`images/workbooks/${wb}/images/${imageId}`)
    expect(copy).not.toBeNull()
    expect(new Uint8Array(await copy!.arrayBuffer())).toEqual(PNG_1PX)
    expect(copy!.httpMetadata?.contentType).toBe('image/png')
    const second = await runBackup(env as Env, new Date(Date.now() + 1000))
    expect(second.status).toBe('succeeded')
    expect(second.details?.imagesPresent).toBeGreaterThanOrEqual(1)
    expect(await env.BACKUPS!.head(`images/workbooks/${wb}/images/${imageId}`)).not.toBeNull()
  })
})
