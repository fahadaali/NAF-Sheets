// Comments in the task details panel (spec §12.1 item 5, §8 table, §9.3.5
// `comment_created`, §9.4): read and added with the person's own token, the
// row's counter kept by webhooks and reconciliation, subtasks show their
// to-do's comments, viewers read only.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { CreateCommentResponse, TaskCommentsResponse, WorkbookSyncResponse } from '@naf-sheets/shared'
import { isArabic } from '../helpers'
import { call, harness, json, linkUser, readSheetView, reconcile, runInbound, seedMember, setupLinked, syncLog, todoByTitle } from '../sync/harness'
import type { Linked } from '../sync/harness'

async function addMember(workbookId: string, userId: string, role: 'editor' | 'viewer', by: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO workbook_members (workbook_id, user_id, role, added_by, added_at) VALUES (?1, ?2, ?3, ?4, ?5)`).bind(workbookId, userId, role, by, new Date().toISOString()).run()
}

const commentsOf = async (l: Linked, uid: string, user: { id: string } = l.owner) => call(l.h.app, 'GET', `/api/workbooks/${l.wbId}/tasks/${uid}/comments`, { user, env: l.h.env })
const addComment = async (l: Linked, uid: string, content: unknown, user: { id: string } = l.owner) =>
  call(l.h.app, 'POST', `/api/workbooks/${l.wbId}/tasks/${uid}/comments`, { user, env: l.h.env, body: { content } })
const countOf = async (l: Linked, uid: string): Promise<number | null | undefined> => {
  const sync = await json<WorkbookSyncResponse>(await call(l.h.app, 'GET', `/api/workbooks/${l.wbId}/sync`, { user: l.owner, env: l.h.env }))
  return sync.tasks.find((t) => t.uid === uid)?.commentsCount
}

/** A comment event as Basecamp would POST it to the webhook (recording = the comment). */
async function commentWebhook(l: Linked, kind: string, commentId: number, bucketId = l.project.id) {
  const hook = await env.DB.prepare(`SELECT bc_webhook_id FROM bc_webhooks WHERE bc_project_id = ?1 AND replaced_at IS NULL`).bind(l.project.id).first<{ bc_webhook_id: number }>()
  return runInbound(l.h, [
    {
      kind: 'basecamp_webhook',
      bcWebhookId: hook?.bc_webhook_id as number,
      bcProjectId: l.project.id,
      receivedAt: new Date().toISOString(),
      body: l.h.fake.delivery(kind, { id: commentId, type: 'Comment', bucketId }),
    },
  ])
}

describe('reading and adding comments with the person’s own token', () => {
  it('lists a to-do’s comments as plain text, oldest first, and stores the counter', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'إطلاق' }], service: true })
    const todo = todoByTitle(h, 'إطلاق')
    h.fake.addComment(todo.id, '<div>أول تعليق<br>بسطرين</div>', l.ownerPerson.id)
    h.fake.addComment(todo.id, '<div>ثانٍ <strong>مهم</strong> &amp; عاجل</div>')
    const uid = (await readSheetView(l)).uid('إطلاق')
    const res = await commentsOf(l, uid)
    expect(res.status).toBe(200)
    const body = await json<TaskCommentsResponse>(res)
    expect(body).toMatchObject({ taskUid: uid, targetUid: uid, onParent: false, commentsCount: 2, canComment: true })
    expect(body.comments.map((c) => c.text)).toEqual(['أول تعليق\nبسطرين', 'ثانٍ مهم & عاجل'])
    expect(body.comments[0]?.creatorName).toBe('أحمد المالك')
    expect(body.comments[0]?.appUrl).toMatch(/^https:\/\/3\.basecamp\.com\//)
    expect(body.bcUrl).toBe(`https://3.basecamp.com/${h.fake.accountId}/buckets/${l.project.id}/todos/${todo.id}`)
    const read = h.fake.callsTo('GET', new RegExp(`^/recordings/${todo.id}/comments\\.json$`))
    expect(read.map((c) => c.token)).toEqual([l.token])
    expect(await countOf(l, uid)).toBe(2)
  })

  it('adds a comment as the person (escaped rich text), counts it, and logs only its id', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'نشر' }], service: true })
    const todo = todoByTitle(h, 'نشر')
    const uid = (await readSheetView(l)).uid('نشر')
    const res = await addComment(l, uid, '  تمت المراجعة <b>نهائياً</b>\nأرسلوا الملف  ')
    expect(res.status).toBe(201)
    const body = await json<CreateCommentResponse>(res)
    expect(body.commentsCount).toBe(1)
    expect(body.comment.text).toBe('تمت المراجعة <b>نهائياً</b>\nأرسلوا الملف')
    const post = h.fake.callsTo('POST', new RegExp(`^/recordings/${todo.id}/comments\\.json$`)).at(-1)
    expect(post?.token).toBe(l.token)
    expect(post?.body).toEqual({ content: '<div>تمت المراجعة &lt;b&gt;نهائياً&lt;/b&gt;<br>أرسلوا الملف</div>' })
    expect(h.fake.commentsOf(todo.id).map((c) => c.creatorId)).toEqual([l.ownerPerson.id])
    expect(await countOf(l, uid)).toBe(1)
    const log = await syncLog(l.wbId, 'create_comment')
    expect(log).toHaveLength(1)
    expect(log[0]?.actor).toBe(l.owner.id)
    expect(JSON.parse(log[0]?.new_value ?? '{}')).toEqual({ commentId: body.comment.id })
  })

  it('refuses an empty or over-long comment with an Arabic message, sending nothing', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أ' }], service: true })
    const uid = (await readSheetView(l)).uid('أ')
    for (const content of ['', '   ', 'x'.repeat(10_001), 42]) {
      const res = await addComment(l, uid, content)
      expect(res.status).toBe(400)
      const err = await json<{ error: string; message: string }>(res)
      expect(err.error).toBe('comment_invalid')
      expect(isArabic(err.message)).toBe(true)
    }
    expect(h.fake.calls.filter((c) => c.path.includes('/comments'))).toEqual([])
  })
})

describe('subtask rows: comments are on the parent (§8 table)', () => {
  it('a subtask shows its to-do’s comments, and a comment added there goes to the to-do', async () => {
    const h = harness()
    const l = await setupLinked(h, { hierarchy: { mode: 'indent' }, rows: [{ title: 'الأم' }, { title: 'فرعية', indent: true }], service: true })
    const parent = todoByTitle(h, 'الأم')
    h.fake.addComment(parent.id, '<div>على الأم</div>')
    const view = await readSheetView(l)
    const sub = view.uid('فرعية')
    const body = await json<TaskCommentsResponse>(await commentsOf(l, sub))
    expect(body).toMatchObject({ taskUid: sub, targetUid: view.uid('الأم'), onParent: true, commentsCount: 1 })
    expect(body.comments.map((c) => c.text)).toEqual(['على الأم'])
    expect((await addComment(l, sub, 'من صف المهمة الفرعية')).status).toBe(201)
    expect(h.fake.commentsOf(parent.id).map((c) => c.content)).toEqual(['<div>على الأم</div>', '<div>من صف المهمة الفرعية</div>'])
    // The counter lives on the to-do's row; the subtask's row reports none of its own.
    expect(await countOf(l, view.uid('الأم'))).toBe(2)
    expect(await countOf(l, sub)).toBeNull()
  })
})

describe('the row’s counter: comment_created webhook and reconciliation', () => {
  it('comment_created reads the comment, then its to-do, with the service token; the counter follows', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'حملة' }], service: true })
    const todo = todoByTitle(h, 'حملة')
    const uid = (await readSheetView(l)).uid('حملة')
    const c = h.fake.addComment(todo.id, '<div>جديد</div>', 77)
    await commentWebhook(l, 'comment_created', c.id)
    expect(await countOf(l, uid)).toBe(1)
    const reads = h.fake.calls.filter((x) => x.path === `/comments/${c.id}.json` || x.path === `/todos/${todo.id}.json`)
    expect(reads.length).toBeGreaterThanOrEqual(2)
    expect(new Set(reads.map((x) => x.token)).has(l.token)).toBe(false)
    // A second comment, its event: 2. Nothing was written to Basecamp.
    await commentWebhook(l, 'comment_created', h.fake.addComment(todo.id, '<div>ثانٍ</div>').id)
    expect(await countOf(l, uid)).toBe(2)
    expect(h.fake.writes().filter((x) => x.path.startsWith(`/todos/${todo.id}`))).toEqual([])
  })

  it('an event from another project, an unknown comment, or a comment on something else is ignored and logged', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'ر' }], service: true })
    const todo = todoByTitle(h, 'ر')
    const uid = (await readSheetView(l)).uid('ر')
    const c = h.fake.addComment(todo.id, '<div>x</div>')
    c.bucketId = 999
    await commentWebhook(l, 'comment_created', c.id)
    await commentWebhook(l, 'comment_created', 123456789)
    expect(await countOf(l, uid)).not.toBe(1)
    const ignored = (await syncLog(l.wbId)).filter((r) => r.action === 'webhook:comment_created').map((r) => r.error)
    expect(ignored).toEqual(['bucket_mismatch', 'comment_gone'])
  })

  it('reconciliation updates the counter even when the to-do’s updated_at did not move', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'س' }], service: true })
    const todo = todoByTitle(h, 'س')
    const uid = (await readSheetView(l)).uid('س')
    await reconcile(h)
    const updatedAt = todo.updatedAt
    h.fake.addComment(todo.id, '<div>بلا webhook</div>')
    todo.updatedAt = updatedAt
    await reconcile(h)
    expect(await countOf(l, uid)).toBe(1)
  })
})

describe('permissions', () => {
  it('a viewer reads (with their own Basecamp link) and cannot add; without a link the read says how to link', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'ص' }], service: true })
    const todo = todoByTitle(h, 'ص')
    h.fake.addComment(todo.id, '<div>تعليق</div>')
    const uid = (await readSheetView(l)).uid('ص')
    const viewer = await seedMember('editor')
    await addMember(l.wbId, viewer.id, 'viewer', l.owner.id)
    const unlinked = await commentsOf(l, uid, viewer)
    expect(unlinked.status).toBe(403)
    expect(await json<{ error: string; link: string }>(unlinked)).toMatchObject({ error: 'basecamp_not_linked', link: '/auth/basecamp/start' })
    const viewerPerson = h.fake.person('قارئ')
    h.fake.projects.get(l.project.id)?.peopleIds.add(viewerPerson.id)
    const viewerToken = await linkUser(h, viewer.id, viewerPerson)
    const read = await json<TaskCommentsResponse>(await commentsOf(l, uid, viewer))
    expect(read).toMatchObject({ commentsCount: 1, canComment: false })
    expect(h.fake.callsTo('GET', /\/comments\.json$/).at(-1)?.token).toBe(viewerToken)
    const before = h.fake.calls.length
    const refused = await addComment(l, uid, 'لا', viewer)
    expect(refused.status).toBe(403)
    expect(isArabic((await json<{ message: string }>(refused)).message)).toBe(true)
    expect(h.fake.calls.length).toBe(before)
  })

  it('someone outside the workbook gets 404; a person without access in Basecamp gets an Arabic 403', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'ض' }], service: true })
    const uid = (await readSheetView(l)).uid('ض')
    const outsider = await seedMember('editor')
    expect((await commentsOf(l, uid, outsider)).status).toBe(404)
    // An editor of the workbook who is not in the Basecamp project.
    const editor = await seedMember('editor')
    await addMember(l.wbId, editor.id, 'editor', l.owner.id)
    await linkUser(h, editor.id, h.fake.person('خارج المشروع'))
    const res = await commentsOf(l, uid, editor)
    expect(res.status).toBe(403)
    const err = await json<{ error: string; message: string }>(res)
    expect(err.error).toBe('basecamp_access_denied')
    expect(isArabic(err.message)).toBe(true)
  })
})
