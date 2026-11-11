// Pictures over and in cells: upload, serving, roles and limits
// (src/images/routes.ts; contract packages/shared/src/api-images.ts).

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { IMAGE_MAX_BYTES, parseImagePath } from '@naf-sheets/shared'
import { PNG_1PX } from './png'
import { call, createWorkbook, json, seedMember, testApp, TEST_USER_HEADER } from '../helpers'

const app = testApp()


async function upload(workbookId: string, user: { id: string }, bytes: Uint8Array, headers: Record<string, string> = {}, name = 'شعار.png') {
  const h = new Headers({ [TEST_USER_HEADER]: user.id, 'content-type': 'image/png', 'content-length': String(bytes.byteLength), ...headers })
  return app.request(`/api/workbooks/${workbookId}/images?name=${encodeURIComponent(name)}`, { method: 'POST', headers: h, body: bytes }, env)
}

describe('POST /api/workbooks/:id/images', () => {
  it('stores a PNG in R2 and answers its same-origin URL; the owner reads it back with safe headers', async () => {
    const owner = await seedMember('editor')
    const wb = await createWorkbook(app, owner)
    const res = await upload(wb, owner, PNG_1PX)
    expect(res.status).toBe(201)
    const body = await json<{ imageId: string; url: string; contentType: string; size: number }>(res)
    expect(body).toMatchObject({ contentType: 'image/png', size: PNG_1PX.byteLength })
    expect(parseImagePath(body.url)).toEqual({ workbookId: wb, imageId: body.imageId })
    const object = await env.ATTACHMENTS.head(`workbooks/${wb}/images/${body.imageId}`)
    expect(object?.customMetadata).toMatchObject({ workbookId: wb, uploadedBy: owner.id, origin: 'editor' })

    const got = await call(app, 'GET', body.url, { user: owner })
    expect(got.status).toBe(200)
    expect(got.headers.get('content-type')).toBe('image/png')
    expect(got.headers.get('x-content-type-options')).toBe('nosniff')
    expect(got.headers.get('content-security-policy')).toContain('sandbox')
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG_1PX)

    const { results } = await env.DB.prepare(`SELECT action, entity_id FROM audit_log WHERE workbook_id = ?1 AND action = 'image.upload'`).bind(wb).all()
    expect(results).toEqual([{ action: 'image.upload', entity_id: body.imageId }])
  })

  it('recognises the type from the bytes: SVG and HTML are refused whatever their declared type', async () => {
    const owner = await seedMember('editor')
    const wb = await createWorkbook(app, owner)
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    const res = await upload(wb, owner, svg, { 'content-type': 'image/svg+xml' }, 'x.svg')
    expect(res.status).toBe(415)
    expect(await json(res)).toMatchObject({ error: 'image_type_not_allowed' })
    expect((await json<{ message: string }>(await upload(wb, owner, new TextEncoder().encode('<html>'), { 'content-type': 'image/png' }))).message).toMatch(/PNG/)
    const listed = await env.ATTACHMENTS.list({ prefix: `workbooks/${wb}/images/` })
    expect(listed.objects).toEqual([])
  })

  it('needs a length, refuses empty and oversized pictures before storing anything', async () => {
    const owner = await seedMember('editor')
    const wb = await createWorkbook(app, owner)
    const big = await upload(wb, owner, PNG_1PX, { 'content-length': String(IMAGE_MAX_BYTES + 1) })
    expect(big.status).toBe(413)
    expect(await json(big)).toMatchObject({ error: 'image_too_large' })
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(PNG_1PX); c.close() } })
    const noLength = await app.request(`/api/workbooks/${wb}/images`, { method: 'POST', headers: { [TEST_USER_HEADER]: owner.id }, body: stream, duplex: 'half' } as RequestInit, env)
    expect(noLength.status).toBe(411)
    const empty = await upload(wb, owner, new Uint8Array(0))
    expect(empty.status).toBe(400)
    expect(await json(empty)).toMatchObject({ error: 'image_empty' })
    expect((await env.ATTACHMENTS.list({ prefix: `workbooks/${wb}/images/` })).objects).toEqual([])
  })

  it('a viewer cannot add a picture but can see one; an outsider gets 404 for both', async () => {
    const owner = await seedMember('editor')
    const viewer = await seedMember('editor')
    const outsider = await seedMember('editor')
    const wb = await createWorkbook(app, owner)
    expect((await call(app, 'PUT', `/api/workbooks/${wb}/members`, { user: owner, body: { members: [{ userId: viewer.id, role: 'viewer' }] } })).status).toBe(200)
    const refused = await upload(wb, viewer, PNG_1PX)
    expect(refused.status).toBe(403)
    expect(await json(refused)).toMatchObject({ error: 'forbidden' })
    const { url } = await json<{ url: string }>(await upload(wb, owner, PNG_1PX))
    expect((await call(app, 'GET', url, { user: viewer })).status).toBe(200)
    const hidden = await call(app, 'GET', url, { user: outsider })
    expect(hidden.status).toBe(404)
    expect(await json(hidden)).toMatchObject({ error: 'image_not_found' })
    expect((await upload(wb, outsider, PNG_1PX)).status).toBe(404)
  })

  it('a picture is read only through its own workbook', async () => {
    const owner = await seedMember('editor')
    const a = await createWorkbook(app, owner)
    const b = await createWorkbook(app, owner)
    const { imageId } = await json<{ imageId: string }>(await upload(a, owner, PNG_1PX))
    expect((await call(app, 'GET', `/api/workbooks/${b}/images/${imageId}`, { user: owner })).status).toBe(404)
    expect((await call(app, 'GET', `/api/workbooks/${a}/images/not-an-id`, { user: owner })).status).toBe(404)
  })
})
