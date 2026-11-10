// Attachments end to end on local Miniflare against the fake Basecamp
// (spec §10, §5.2, §8 table, §8.2, §16 scenarios 8, 20, 24): upload from the
// platform, the size limit, the download proxy and its permissions, removal
// after confirmation, files found in Basecamp, subtasks, failures, viewers.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { AttachmentSettingsResponse, TaskAttachmentsResponse, UploadAttachmentResponse, WorkbookSyncResponse } from '@naf-sheets/shared'
import { splitDescription } from '@naf-sheets/sync-engine'
import { isArabic } from '../helpers'
import {
  call,
  deliver,
  drainOutbound,
  edit,
  harness,
  json,
  linkUser,
  readSheetView,
  reconcile,
  seedMember,
  setupLinked,
  subtaskByTitle,
  todoByTitle,
} from '../sync/harness'
import type { Linked } from '../sync/harness'
import { attachmentRows, bytesOf, r2Keys, storedNotes, upload } from './helpers'

async function addMember(workbookId: string, userId: string, role: 'editor' | 'viewer', by: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO workbook_members (workbook_id, user_id, role, added_by, added_at) VALUES (?1, ?2, ?3, ?4, ?5)`).bind(workbookId, userId, role, by, new Date().toISOString()).run()
}

/** A linked to-do with notes, a due date and an external assignee (so its description has a managed block). */
async function todoWithBlock(): Promise<{ l: Linked; uid: string; title: string; agency: string }> {
  const h = harness()
  const title = 'إطلاق الحملة'
  const l = await setupLinked(h, { rows: [{ title, assignees: 'أحمد المالك', due: '2026-12-01', notes: 'راجع المسودة قبل الخميس' }], service: true })
  // D1 is shared by the tests of this file: a name of its own, or the cell's name would be ambiguous.
  const agency = `وكالة المدى ${crypto.randomUUID().slice(0, 6)}`
  await env.DB.prepare(`INSERT INTO external_contacts (id, name, organization, created_by, created_at) VALUES (?1, ?2, 'المدى للتصميم', ?3, ?4)`)
    .bind(`ext-${crypto.randomUUID()}`, agency, l.owner.id, new Date().toISOString())
    .run()
  await edit(l, (v) => v.set(v.row(title), 'B', `أحمد المالك، ${agency}`))
  await drainOutbound(h)
  const view = await readSheetView(l)
  expect(splitDescription(todoByTitle(h, title).description).block).toContain(agency)
  return { l, uid: view.uid(title), title, agency }
}

const list = async (l: Linked, uid: string, user: { id: string } = l.owner) =>
  json<TaskAttachmentsResponse>(await call(l.h.app, 'GET', `/api/workbooks/${l.wbId}/tasks/${uid}/attachments`, { user, env: l.h.env }))

describe('upload from the platform (§10)', () => {
  it('file → R2 → Basecamp with the person’s token → bc-attachment in the description, sent in full; the person’s text and the block are kept', async () => {
    const { l, uid, title, agency } = await todoWithBlock()
    const h = l.h
    const todo = todoByTitle(h, title)
    // Something changed in Basecamp since the last sync: the PUT must carry it, not clear it (§9.2.4).
    const subscriber = h.fake.person('مشترك في الإنجاز')
    todo.completionSubscriberIds = [subscriber.id]
    todo.startsOn = '2026-11-20'
    todo.updatedAt = h.fake.tick()
    const before = todo.description
    const { human, block } = splitDescription(before)
    expect(human).toContain('راجع المسودة')
    expect(block).toContain(agency)
    const writesBefore = h.fake.writes().length

    const bytes = bytesOf('%PDF-1.7 خطة الحملة')
    const res = await upload(l, uid, 'خطة الحملة.pdf', bytes)
    expect(res.status).toBe(201)
    const body = await json<UploadAttachmentResponse>(res)
    expect(body.attachment).toMatchObject({ filename: 'خطة الحملة.pdf', size: bytes.byteLength, mime: 'application/pdf', origin: 'local', state: 'attached', message: null, taskUid: uid })
    expect(body.attachment.downloadPath).toBe(`/api/workbooks/${l.wbId}/attachments/${body.attachment.id}/download`)
    expect(body.attachments.map((a) => a.id)).toEqual([body.attachment.id])

    // Basecamp received the raw bytes with the file's own type and length, from the person's token.
    expect(h.fake.uploads).toHaveLength(1)
    const sent = h.fake.uploads[0]
    expect(sent?.token).toBe(l.token)
    expect(sent?.name).toBe('خطة الحملة.pdf')
    expect(sent?.contentType).toBe('application/pdf')
    expect(sent?.contentLength).toBe(String(bytes.byteLength))
    expect([...(sent?.bytes ?? [])]).toEqual([...bytes])
    const sgid = [...h.fake.blobs.values()].find((b) => b.filename === 'خطة الحملة.pdf')?.sgid as string

    // Exactly one to-do write: the full PUT, every field, the file at the end of the person's part.
    const writes = h.fake.writes().slice(writesBefore).filter((c) => c.path !== '/attachments.json')
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual([`PUT /todos/${todo.id}.json`])
    const put = writes[0]
    expect(put?.token).toBe(l.token)
    expect(Object.keys(put?.body as object).sort()).toEqual(['assignee_ids', 'completion_subscriber_ids', 'content', 'description', 'due_on', 'notify', 'starts_on'])
    expect(put?.body).toMatchObject({
      content: title,
      description: `${human}<bc-attachment sgid="${sgid}"></bc-attachment>${block}`,
      assignee_ids: [l.ownerPerson.id],
      completion_subscriber_ids: [subscriber.id],
      due_on: '2026-12-01',
      starts_on: '2026-11-20',
      notify: false,
    })

    // The platform's copy in R2, byte for byte.
    const rows = await attachmentRows(uid)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ origin: 'local', state: 'attached', r2_stored: 1, bc_sgid: sgid, created_by: l.owner.id, removed_at: null })
    const object = await env.ATTACHMENTS.get(rows[0]?.r2_key as string)
    expect([...new Uint8Array(await (object as R2ObjectBody).arrayBuffer())]).toEqual([...bytes])
    expect(object?.httpMetadata?.contentType).toBe('application/pdf')

    // The sheet: the attachments cell shows the name; the notes cell keeps its text and learns the file.
    const view = await readSheetView(l)
    const row = view.row(title)
    expect(view.text(row, 'F')).toBe('خطة الحملة.pdf')
    expect(view.text(row, 'G')).toBe('راجع المسودة قبل الخميس')
    expect(storedNotes(view.cells[row]?.[6])).toBe(`${human}<bc-attachment sgid="${sgid}"></bc-attachment>`)

    // §16 scenario 9 / 8: a later edit of the row keeps the text, the file and the block.
    await edit(l, (v) => v.set(v.row(title), 'D', '2026-12-05'))
    await drainOutbound(h)
    expect(todo.dueOn).toBe('2026-12-05')
    expect(todo.description).toBe(`${human}<bc-attachment sgid="${sgid}"></bc-attachment>${block}`)
    expect(todo.completionSubscriberIds).toEqual([subscriber.id])
  })

  it('a to-do without notes or block: the description becomes the file alone, and a later edit keeps it', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'مهمة بلا وصف' }], service: true })
    const uid = (await readSheetView(l)).uid('مهمة بلا وصف')
    expect((await upload(l, uid, 'a.png', bytesOf('png'), { contentType: 'image/png' })).status).toBe(201)
    const todo = todoByTitle(h, 'مهمة بلا وصف')
    const sgid = (await attachmentRows(uid))[0]?.bc_sgid as string
    expect(todo.description).toBe(`<bc-attachment sgid="${sgid}"></bc-attachment>`)
    await edit(l, (v) => v.set(v.row('مهمة بلا وصف'), 'A', 'مهمة معدّلة'))
    await drainOutbound(h)
    expect(todo.content).toBe('مهمة معدّلة')
    expect(todo.description).toBe(`<bc-attachment sgid="${sgid}"></bc-attachment>`)
  })
})

describe('the size limit (§10)', () => {
  it('is a setting (admin only), refused before a byte is read, with an Arabic message; nothing is stored or sent', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أ' }], service: true })
    const uid = (await readSheetView(l)).uid('أ')
    const admin = l.admin as { id: string }
    // Default 100 MB.
    expect(await json<AttachmentSettingsResponse>(await call(h.app, 'GET', '/api/attachment-settings', { user: l.owner, env: h.env }))).toEqual({ maxBytes: 100 * 1024 * 1024, subtaskMode: 'local' })
    const refused = await call(h.app, 'PUT', '/api/admin/attachment-settings', { user: l.owner, env: h.env, body: { maxBytes: 1024 } })
    expect(refused.status).toBe(403)
    expect(isArabic((await json<{ message: string }>(refused)).message)).toBe(true)
    expect((await call(h.app, 'PUT', '/api/admin/attachment-settings', { user: admin, env: h.env, body: { maxBytes: 0 } })).status).toBe(400)
    expect((await call(h.app, 'PUT', '/api/admin/attachment-settings', { user: admin, env: h.env, body: { maxBytes: 200 * 1024 * 1024 } })).status).toBe(400)
    const set = await call(h.app, 'PUT', '/api/admin/attachment-settings', { user: admin, env: h.env, body: { maxBytes: 1024 } })
    expect(await json<AttachmentSettingsResponse>(set)).toEqual({ maxBytes: 1024, subtaskMode: 'local' })
    expect((await list(l, uid)).settings.maxBytes).toBe(1024)

    const big = new Uint8Array(2048)
    const res = await upload(l, uid, 'كبير.bin', big)
    expect(res.status).toBe(413)
    const err = await json<{ error: string; message: string }>(res)
    expect(err.error).toBe('attachment_too_large')
    expect(err.message).toContain('1 كيلوبايت')
    expect(isArabic(err.message)).toBe(true)
    // Exactly at the limit is fine.
    expect((await upload(l, uid, 'حد.bin', new Uint8Array(1024), { contentType: 'application/octet-stream' })).status).toBe(201)
    expect(await r2Keys(l.wbId)).toHaveLength(1)
    expect(await attachmentRows(uid)).toHaveLength(1)
    expect(h.fake.uploads).toHaveLength(1)
  })

  it('a request without Content-Length, an empty file, or an unusable name is refused with its own message', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أ' }], service: true })
    const uid = (await readSheetView(l)).uid('أ')
    const noLength = await upload(l, uid, 'a.pdf', bytesOf('abc'), { length: null, stream: true })
    expect(noLength.status).toBe(411)
    expect((await json<{ error: string }>(noLength)).error).toBe('attachment_length_required')
    const empty = await upload(l, uid, 'a.pdf', new Uint8Array(0))
    expect((await json<{ error: string }>(empty)).error).toBe('attachment_empty')
    for (const name of ['', '   ', '..', 'x'.repeat(256)]) {
      const bad = await upload(l, uid, name, bytesOf('abc'))
      expect(bad.status, name).toBe(400)
      expect((await json<{ error: string }>(bad)).error).toBe('attachment_invalid_name')
    }
    expect(await r2Keys(l.wbId)).toEqual([])
    expect(h.fake.uploads).toEqual([])
  })

  it('cleans a name: path separators and bidi overrides cannot disguise it', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أ' }], service: true })
    const uid = (await readSheetView(l)).uid('أ')
    const res = await upload(l, uid, '../تقرير‮fdp.exe', bytesOf('x'), { contentType: 'text/html; charset=utf-8' })
    const { attachment } = await json<UploadAttachmentResponse>(res)
    expect(attachment.filename).toBe('.._تقريرfdp.exe')
    expect(attachment.mime).toBe('text/html')
  })
})

describe('the download proxy and its permissions (§10, §14)', () => {
  it('serves the platform’s copy to anyone who may open the workbook, as an attachment; others get 404', async () => {
    const { l, uid } = await todoWithBlock()
    const h = l.h
    const bytes = bytesOf('<script>alert(1)</script>')
    const { attachment } = await json<UploadAttachmentResponse>(await upload(l, uid, 'صفحة.html', bytes, { contentType: 'text/html' }))
    const viewer = await seedMember('editor')
    await addMember(l.wbId, viewer.id, 'viewer', l.owner.id)
    for (const user of [l.owner, viewer, l.admin as { id: string }]) {
      const res = await call(h.app, 'GET', attachment.downloadPath, { user, env: h.env })
      expect(res.status).toBe(200)
      expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...bytes])
      expect(res.headers.get('content-type')).toBe('text/html')
      expect(res.headers.get('content-disposition')).toBe(`attachment; filename="____.html"; filename*=UTF-8''${encodeURIComponent('صفحة.html')}`)
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('content-security-policy')).toContain('sandbox')
    }
    const outsider = await seedMember('editor')
    expect((await call(h.app, 'GET', attachment.downloadPath, { user: outsider, env: h.env })).status).toBe(404)
    expect((await call(h.app, 'GET', `/api/workbooks/${l.wbId}/attachments/not-a-file/download`, { user: l.owner, env: h.env })).status).toBe(404)
    // Only the Basecamp upload itself reached Basecamp: the copy is the platform's.
    expect(h.fake.calls.filter((c) => c.path.includes('/blobs/'))).toEqual([])
  })

  it('a file that came from Basecamp is read from Basecamp with the caller’s own token; without a link: 403 with the link', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'ب' }], service: true })
    const todo = todoByTitle(h, 'ب')
    const blob = h.fake.addBlob('تقرير الربع.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytesOf('xlsx-bytes'))
    todo.description = `<div>المرفق أدناه</div>${h.fake.attachmentHtml(blob)}`
    todo.updatedAt = h.fake.tick()
    await deliver(l, 'todo_description_changed', { id: todo.id, type: 'Todo' })
    const uid = (await readSheetView(l)).uid('ب')
    const [file] = (await list(l, uid)).attachments
    expect(file).toMatchObject({ filename: 'تقرير الربع.xlsx', origin: 'basecamp', state: 'attached', size: 10 })
    const viewer = await seedMember('editor')
    await addMember(l.wbId, viewer.id, 'viewer', l.owner.id)
    const notLinked = await call(h.app, 'GET', file?.downloadPath as string, { user: viewer, env: h.env })
    expect(notLinked.status).toBe(403)
    const err = await json<{ error: string; link?: string; message: string }>(notLinked)
    expect(err.error).toBe('basecamp_not_linked')
    expect(err.link).toBe('/auth/basecamp/start')
    const viewerToken = await linkUser(h, viewer.id, h.fake.person('قارئة'))
    const res = await call(h.app, 'GET', file?.downloadPath as string, { user: viewer, env: h.env })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('xlsx-bytes')
    const storage = h.fake.calls.filter((c) => c.path.includes('/blobs/'))
    expect(storage.map((c) => c.token)).toEqual([viewerToken])
    // Gone from Basecamp's storage: a clear 404.
    h.fake.blobs.delete(blob.sgid)
    const gone = await call(h.app, 'GET', file?.downloadPath as string, { user: viewer, env: h.env })
    expect(gone.status).toBe(404)
    expect(isArabic((await json<{ message: string }>(gone)).message)).toBe(true)
  })
})

describe('removing a chip (§10)', () => {
  it('needs the confirmation; then the file leaves the description in Basecamp (sent in full), the R2 copy stays 30 days, audited', async () => {
    const { l, uid, title } = await todoWithBlock()
    const h = l.h
    const todo = todoByTitle(h, title)
    const { human, block } = splitDescription(todo.description)
    const first = await json<UploadAttachmentResponse>(await upload(l, uid, 'أول.pdf', bytesOf('1')))
    const second = await json<UploadAttachmentResponse>(await upload(l, uid, 'ثانٍ.pdf', bytesOf('22')))
    const [a, b] = await attachmentRows(uid)
    expect(todo.description).toBe(`${human}<bc-attachment sgid="${a?.bc_sgid}"></bc-attachment><bc-attachment sgid="${b?.bc_sgid}"></bc-attachment>${block}`)
    const path = `/api/workbooks/${l.wbId}/attachments/${first.attachment.id}/remove`
    const writes = h.fake.writes().length

    for (const body of [undefined, {}, { confirmed: false }, { confirmed: 'yes' }]) {
      const res = await call(h.app, 'POST', path, { user: l.owner, env: h.env, body })
      expect(res.status).toBe(body === undefined ? 400 : 400)
      expect((await json<{ error: string }>(res)).error).toBe(body === undefined ? 'invalid_json' : 'attachment_not_confirmed')
    }
    expect(h.fake.writes().length).toBe(writes)

    const res = await call(h.app, 'POST', path, { user: l.owner, env: h.env, body: { confirmed: true } })
    expect(res.status).toBe(200)
    const after = await json<TaskAttachmentsResponse>(res)
    expect(after.attachments.map((x) => x.id)).toEqual([second.attachment.id])
    const put = h.fake.callsTo('PUT', new RegExp(`^/todos/${todo.id}\\.json$`)).at(-1)
    expect(put?.token).toBe(l.token)
    expect((put?.body as { description: string }).description).toBe(`${human}<bc-attachment sgid="${b?.bc_sgid}"></bc-attachment>${block}`)
    expect(todo.description).toBe(`${human}<bc-attachment sgid="${b?.bc_sgid}"></bc-attachment>${block}`)

    const [removed] = await attachmentRows(uid)
    expect(removed?.removed_at).not.toBeNull()
    expect(removed?.removed_by).toBe(l.owner.id)
    expect(Date.parse(removed?.purge_after as string) - Date.parse(removed?.removed_at as string)).toBe(30 * 24 * 3600_000)
    expect(await env.ATTACHMENTS.head(removed?.r2_key as string)).not.toBeNull()
    const audit = await env.DB.prepare(`SELECT actor_id, details_json FROM audit_log WHERE action = 'attachment.remove' AND entity_id = ?1`).bind(first.attachment.id).first<{ actor_id: string; details_json: string }>()
    expect(audit?.actor_id).toBe(l.owner.id)
    expect(JSON.parse(audit?.details_json ?? '{}')).toMatchObject({ filename: 'أول.pdf', r2Kept: true })
    const view = await readSheetView(l)
    expect(view.text(view.row(title), 'F')).toBe('ثانٍ.pdf')
    // Removed chips cannot be downloaded or removed again.
    expect((await call(h.app, 'GET', first.attachment.downloadPath, { user: l.owner, env: h.env })).status).toBe(404)
    expect((await call(h.app, 'POST', path, { user: l.owner, env: h.env, body: { confirmed: true } })).status).toBe(404)
  })

  it('a refusal from Basecamp keeps the chip and says why', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'ج' }], service: true })
    const uid = (await readSheetView(l)).uid('ج')
    const { attachment } = await json<UploadAttachmentResponse>(await upload(l, uid, 'a.pdf', bytesOf('a')))
    const todo = todoByTitle(h, 'ج')
    h.fake.fail((c) => c.method === 'PUT' && c.path === `/todos/${todo.id}.json`, 403)
    const res = await call(h.app, 'POST', `/api/workbooks/${l.wbId}/attachments/${attachment.id}/remove`, { user: l.owner, env: h.env, body: { confirmed: true } })
    expect(res.status).toBe(403)
    const err = await json<{ error: string; message: string }>(res)
    expect(err.error).toBe('basecamp_access_denied')
    expect(isArabic(err.message)).toBe(true)
    expect((await attachmentRows(uid))[0]?.removed_at).toBeNull()
    expect(todo.description).toContain((await attachmentRows(uid))[0]?.bc_sgid as string)
  })
})

describe('files found in Basecamp (§10 inbound)', () => {
  it('a file a person attached in Basecamp becomes a chip (webhook); removed there, the chip goes (reconciliation)', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'د', notes: 'ملاحظة' }], service: true })
    const todo = todoByTitle(h, 'د')
    const blob = h.fake.addBlob('صورة الغلاف.png', 'image/png', bytesOf('png-bytes'))
    const human = `<div>ملاحظة</div>${h.fake.attachmentHtml(blob)}`
    todo.description = human
    todo.updatedAt = h.fake.tick()
    await deliver(l, 'todo_description_changed', { id: todo.id, type: 'Todo' })
    const view = await readSheetView(l)
    const uid = view.uid('د')
    const rows = await attachmentRows(uid)
    expect(rows).toEqual([
      expect.objectContaining({ origin: 'basecamp', state: 'attached', filename: 'صورة الغلاف.png', size: 9, mime: 'image/png', bc_sgid: blob.sgid, bc_blob_url: h.fake.storageUrl(blob), r2_stored: 0, created_by: null }),
    ])
    expect(view.text(view.row('د'), 'F')).toBe('صورة الغلاف.png')
    // The file's caption is not notes text; the stored HTML keeps it.
    expect(view.text(view.row('د'), 'G')).toBe('ملاحظة')
    expect(storedNotes(view.cells[view.row('د')]?.[6])).toBe(human)
    // Nothing was written to Basecamp for it.
    expect(h.fake.writes().filter((c) => c.path === `/todos/${todo.id}.json`)).toEqual([])
    // The same file read again is not a second chip.
    todo.updatedAt = h.fake.tick()
    await reconcile(h)
    expect(await attachmentRows(uid)).toHaveLength(1)

    todo.description = '<div>ملاحظة</div>'
    todo.updatedAt = h.fake.tick()
    await reconcile(h)
    const [gone] = await attachmentRows(uid)
    expect(gone?.removed_at).not.toBeNull()
    expect(gone?.removed_by).toBeNull()
    const after = await readSheetView(l)
    expect(after.text(after.row('د'), 'F')).toBe('')
  })
})

describe('subtasks (§8 table: no attachments in Basecamp)', () => {
  it('a subtask’s file stays in the platform with a notice; nothing reaches Basecamp', async () => {
    const h = harness()
    const l = await setupLinked(h, { hierarchy: { mode: 'indent' }, rows: [{ title: 'الأم' }, { title: 'فرعية', indent: true }], service: true })
    const uid = (await readSheetView(l)).uid('فرعية')
    subtaskByTitle(h, 'فرعية')
    const calls = h.fake.calls.length
    const res = await upload(l, uid, 'مسودة.docx', bytesOf('docx'), { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
    expect(res.status).toBe(201)
    const { attachment } = await json<UploadAttachmentResponse>(res)
    expect(attachment).toMatchObject({ state: 'local_only', origin: 'local' })
    expect(h.fake.calls.length).toBe(calls)
    const listed = await list(l, uid)
    expect(listed.level).toBe(1)
    expect(listed.canEdit).toBe(true)
    expect(isArabic(listed.notice)).toBe(true)
    expect(listed.notice).toContain('المهام الفرعية')
    const view = await readSheetView(l)
    expect(view.text(view.row('فرعية'), 'F')).toBe('مسودة.docx')
    // Removing it needs no Basecamp call either.
    const removed = await call(h.app, 'POST', `/api/workbooks/${l.wbId}/attachments/${attachment.id}/remove`, { user: l.owner, env: h.env, body: { confirmed: true } })
    expect(removed.status).toBe(200)
    expect(h.fake.calls.length).toBe(calls)
  })
})

describe('when Basecamp cannot take the file', () => {
  it('a to-do not in Basecamp yet is refused before anything is stored', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'جديدة' }], service: true, noDrain: true })
    const uid = (await readSheetView(l)).uid('جديدة')
    const res = await upload(l, uid, 'a.pdf', bytesOf('a'))
    expect(res.status).toBe(409)
    expect((await json<{ error: string }>(res)).error).toBe('task_not_in_basecamp')
    expect(await r2Keys(l.wbId)).toEqual([])
    expect((await list(l, uid)).canEdit).toBe(false)
  })

  it('a Basecamp refusal keeps the file in the platform as failed, with the reason; «إعادة المحاولة» sends it', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'هـ' }], service: true })
    const uid = (await readSheetView(l)).uid('هـ')
    h.fake.fail((c) => c.path === '/attachments.json', 403)
    const res = await upload(l, uid, 'a.pdf', bytesOf('abc'))
    expect(res.status).toBe(201)
    const { attachment } = await json<UploadAttachmentResponse>(res)
    expect(attachment.state).toBe('failed')
    expect(isArabic(attachment.message)).toBe(true)
    expect(attachment.message).toContain('إعادة المحاولة')
    expect(await r2Keys(l.wbId)).toHaveLength(1)
    const todo = todoByTitle(h, 'هـ')
    expect(todo.description).toBe('')
    const retried = await call(h.app, 'POST', `/api/workbooks/${l.wbId}/attachments/${attachment.id}/retry`, { user: l.owner, env: h.env })
    expect(retried.status).toBe(200)
    expect((await json<UploadAttachmentResponse>(retried)).attachment).toMatchObject({ state: 'attached', message: null })
    expect(todo.description).toContain((await attachmentRows(uid))[0]?.bc_sgid as string)
    // Nothing to retry any more.
    expect((await call(h.app, 'POST', `/api/workbooks/${l.wbId}/attachments/${attachment.id}/retry`, { user: l.owner, env: h.env })).status).toBe(409)
  })

  it('an editor who never linked Basecamp is refused with the link, and nothing is stored', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'و' }], service: true })
    const editor = await seedMember('editor')
    await addMember(l.wbId, editor.id, 'editor', l.owner.id)
    const uid = (await readSheetView(l)).uid('و')
    const res = await upload(l, uid, 'a.pdf', bytesOf('a'), { user: editor })
    expect(res.status).toBe(403)
    expect(await json<{ error: string; link: string }>(res)).toMatchObject({ error: 'basecamp_not_linked', link: '/auth/basecamp/start' })
    expect(await r2Keys(l.wbId)).toEqual([])
  })
})

describe('viewers are read-only on every attachment write (§3, CLAUDE.md §2)', () => {
  it('a workbook viewer and a platform viewer get 403 on upload, remove and retry; nothing is stored or sent', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'ي' }], service: true })
    const uid = (await readSheetView(l)).uid('ي')
    const { attachment } = await json<UploadAttachmentResponse>(await upload(l, uid, 'a.pdf', bytesOf('a')))
    const keys = await r2Keys(l.wbId)
    const calls = h.fake.calls.length
    const workbookViewer = await seedMember('editor')
    await addMember(l.wbId, workbookViewer.id, 'viewer', l.owner.id)
    await linkUser(h, workbookViewer.id, h.fake.person('قارئ الملف'))
    // A platform viewer is capped at viewer even on a workbook where they are an editor.
    const platformViewer = await seedMember('viewer')
    await addMember(l.wbId, platformViewer.id, 'editor', l.owner.id)
    for (const viewer of [workbookViewer, platformViewer]) {
      const writes: Array<Promise<Response>> = [
        upload(l, uid, 'b.pdf', bytesOf('b'), { user: viewer }),
        call(h.app, 'POST', `/api/workbooks/${l.wbId}/attachments/${attachment.id}/remove`, { user: viewer, env: h.env, body: { confirmed: true } }),
        call(h.app, 'POST', `/api/workbooks/${l.wbId}/attachments/${attachment.id}/retry`, { user: viewer, env: h.env }),
        call(h.app, 'PUT', '/api/admin/attachment-settings', { user: viewer, env: h.env, body: { maxBytes: 10 } }),
      ]
      for (const res of await Promise.all(writes)) {
        expect(res.status).toBe(403)
        const err = await json<{ error: string; message: string }>(res)
        expect(err.error).toBe('forbidden')
        expect(isArabic(err.message)).toBe(true)
      }
      // Reading stays open.
      const listed = await list(l, uid, viewer)
      expect(listed.canEdit).toBe(false)
      expect(listed.attachments).toHaveLength(1)
      expect((await call(h.app, 'GET', attachment.downloadPath, { user: viewer, env: h.env })).status).toBe(200)
    }
    expect(await r2Keys(l.wbId)).toEqual(keys)
    expect(h.fake.calls.length).toBe(calls)
    expect((await attachmentRows(uid))[0]?.removed_at).toBeNull()
  })
})

describe('the notes cell after an upload (§8.2, sheet-model OPEN #8)', () => {
  it('editing or clearing the notes text keeps the file in Basecamp', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'ك', notes: 'نص أول' }], service: true })
    const uid = (await readSheetView(l)).uid('ك')
    await upload(l, uid, 'a.pdf', bytesOf('a'))
    const sgid = (await attachmentRows(uid))[0]?.bc_sgid as string
    const todo = todoByTitle(h, 'ك')
    const file = `<bc-attachment sgid="${sgid}"></bc-attachment>`
    await edit(l, (v) => v.set(v.row('ك'), 'G', 'نص معدّل'))
    await drainOutbound(h)
    expect(todo.description).toBe(`<div>نص معدّل</div>${file}`)
    await edit(l, (v) => v.set(v.row('ك'), 'G', null))
    await drainOutbound(h)
    expect(todo.description).toBe(file)
    const view = await readSheetView(l)
    expect(view.text(view.row('ك'), 'F')).toBe('a.pdf')
  })
})

describe('counts in GET …/sync', () => {
  it('each row reports its files', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'ز' }, { title: 'ح' }], service: true })
    const uid = (await readSheetView(l)).uid('ز')
    await upload(l, uid, 'a.pdf', bytesOf('a'))
    await upload(l, uid, 'b.pdf', bytesOf('b'))
    const sync = await json<WorkbookSyncResponse>(await call(h.app, 'GET', `/api/workbooks/${l.wbId}/sync`, { user: l.owner, env: h.env }))
    expect(sync.tasks.find((t) => t.uid === uid)?.attachmentsCount).toBe(2)
    expect(sync.tasks.find((t) => t.uid !== uid)?.attachmentsCount).toBe(0)
  })
})
