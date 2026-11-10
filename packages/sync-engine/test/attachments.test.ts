// Files in a to-do's description (phase 5, spec §10, §8.2): found, added and
// removed in the person's part only, everything else kept byte for byte.

import { describe, expect, it } from 'vitest'
import {
  appendAttachment,
  attachmentElementHtml,
  attachmentElementsOf,
  attachmentSgids,
  buildManagedBlock,
  composeDescription,
  findAttachmentElements,
  removeAttachment,
  splitDescription,
  withoutAttachments,
} from '../src'

// The shape Basecamp is expected to return (rich_text.md); attribute names
// other than `sgid` are not documented and only read as a fallback name.
const RETURNED = '<bc-attachment sgid="BAh7-1==--aa" content-type="application/pdf" filename="خطة &amp; ميزانية.pdf"><figure><figcaption>خطة</figcaption></figure></bc-attachment>'
const HUMAN = '<div>راجع <strong>المسودة</strong> قبل الخميس</div>'

describe('finding files', () => {
  it('finds each element with its sgid and filename, in order, with exact offsets', () => {
    const html = `${HUMAN}${RETURNED}<div>بعد</div><bc-attachment sgid='s-2'/>`
    const found = findAttachmentElements(html)
    expect(found.map((e) => [e.sgid, e.filename])).toEqual([
      ['BAh7-1==--aa', 'خطة & ميزانية.pdf'],
      ['s-2', null],
    ])
    for (const e of found) expect(html.slice(e.start, e.end)).toBe(e.html)
    expect(attachmentSgids(`${html}${RETURNED}`)).toEqual(['BAh7-1==--aa', 's-2'])
    expect(findAttachmentElements(null)).toEqual([])
  })

  it('a quoted attribute may hold ">" without ending the tag', () => {
    const html = '<bc-attachment sgid="a>b" caption="x > y"></bc-attachment>'
    expect(attachmentSgids(html)).toEqual(['a>b'])
  })
})

describe('adding a file (upload from the platform)', () => {
  it('appends the documented element at the end of the person part; the managed block stays last and untouched', () => {
    const block = buildManagedBlock({ externals: [{ name: 'وكالة المدى', organization: null }], followers: [], freeColumns: [] })
    const description = composeDescription(HUMAN, block)
    const { human, block: kept } = splitDescription(description)
    const next = composeDescription(appendAttachment(human, 'sg-new'), kept)
    expect(next).toBe(`${HUMAN}<bc-attachment sgid="sg-new"></bc-attachment>${block}`)
    expect(splitDescription(next).block).toBe(block)
    expect(splitDescription(next).human.startsWith(HUMAN)).toBe(true)
  })

  it('does not add a file twice, and escapes the attribute', () => {
    const once = appendAttachment(HUMAN, 'sg-1')
    expect(appendAttachment(once, 'sg-1')).toBe(once)
    expect(attachmentElementHtml('a"b<c')).toBe('<bc-attachment sgid="a&quot;b&lt;c"></bc-attachment>')
    expect(attachmentSgids(attachmentElementHtml('a"b<c'))).toEqual(['a"b<c'])
    expect(() => attachmentElementHtml(' ')).toThrow(TypeError)
    expect(appendAttachment(null, 's')).toBe('<bc-attachment sgid="s"></bc-attachment>')
  })
})

describe('removing a file (a chip removed after confirmation)', () => {
  it('removes only that file, every copy of it, and keeps every other byte', () => {
    const html = `${HUMAN}\n${RETURNED}\n<div>ملاحظة</div><bc-attachment sgid="keep"></bc-attachment>${RETURNED}`
    const out = removeAttachment(html, 'BAh7-1==--aa')
    expect(out.removed).toBe(2)
    expect(out.html).toBe(`${HUMAN}\n\n<div>ملاحظة</div><bc-attachment sgid="keep"></bc-attachment>`)
    expect(removeAttachment(html, 'absent')).toEqual({ html, removed: 0 })
  })
})

describe('the text around the files', () => {
  it('withoutAttachments keeps the text; attachmentElementsOf keeps only the files', () => {
    const html = `${HUMAN}${RETURNED}<bc-attachment sgid="s2"></bc-attachment>`
    expect(withoutAttachments(html)).toBe(HUMAN)
    expect(attachmentElementsOf(html)).toBe(`${RETURNED}<bc-attachment sgid="s2"></bc-attachment>`)
    expect(attachmentElementsOf(HUMAN)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// The engine with files in the description (spec §8.2, §10, §16 scenarios 8 and 24)
// ---------------------------------------------------------------------------

import { baseAfterTodoWrite, baseFromRemote, diffTask, MANAGED_BLOCK_TITLE } from '../src'
import type { OutboundAction } from '@naf-sheets/shared'
import { external, HUMAN_NOTES, localTodo, person, AHMED, SARA, remoteTodo, T2, T3, todoCtx } from './fixtures'

const blockOf = (...lines: string[]): string => `<hr><div><strong>${MANAGED_BLOCK_TITLE}</strong><br>${lines.join('<br>')}</div>`
const updateOf = (actions: OutboundAction[]) => actions.find((a): a is Extract<OutboundAction, { type: 'update_todo' }> => a.type === 'update_todo')

describe('the sync engine with files in the description', () => {
  const FILE = '<bc-attachment sgid="sg-up"></bc-attachment>'

  it('a file added in Basecamp (the platform\'s own write, or a person\'s) comes in as notes and sends nothing', () => {
    const local = localTodo({ bcId: 7001 })
    const synced = remoteTodo()
    const base = baseFromRemote('uid-todo', synced)
    const withFile = remoteTodo({ descriptionHtml: appendAttachment(HUMAN_NOTES, 'sg-up'), updatedAt: T2 })
    const r = diffTask(local, base, withFile, todoCtx())
    expect(r.outbound).toEqual([])
    expect(r.inbound).toEqual([{ type: 'update_row', uid: 'uid-todo', fields: { notesHtml: HUMAN_NOTES + FILE } }])
  })

  it('scenario 8: a free column changed after an upload rewrites the block only; the text and both files are kept', () => {
    const local = localTodo({ bcId: 7001, notesHtml: HUMAN_NOTES + FILE, freeColumnsForDescription: { الميزانية: '9000' } })
    const before = remoteTodo({ descriptionHtml: HUMAN_NOTES + FILE + blockOf('الميزانية: 5000') })
    const base = baseFromRemote('uid-todo', { ...before, descriptionHtml: HUMAN_NOTES + FILE + blockOf('الميزانية: 5000') })
    const r = diffTask({ ...local, localChangedAt: T3 }, base, before, todoCtx())
    expect(updateOf(r.outbound)?.write.descriptionHtml).toBe(HUMAN_NOTES + FILE + blockOf('الميزانية: 9000'))
  })

  it('scenario 24 with a file: the block edited by hand is rewritten, the file stays where the person part has it', () => {
    const local = localTodo({ bcId: 7001, notesHtml: HUMAN_NOTES + FILE, assignees: [person(AHMED), external(SARA)] })
    const platformBlock = blockOf('مسؤولون خارجيون: سارة المطيري (وكالة الإعلام)')
    const synced = remoteTodo({ descriptionHtml: HUMAN_NOTES + FILE + platformBlock })
    const base = baseFromRemote('uid-todo', synced)
    const edited = remoteTodo({ descriptionHtml: HUMAN_NOTES + FILE + blockOf('مسؤولون خارجيون: شخص آخر'), updatedAt: T2 })
    const r = diffTask(local, base, edited, todoCtx())
    const write = updateOf(r.outbound)?.write
    expect(write?.descriptionHtml).toBe(HUMAN_NOTES + FILE + platformBlock)
    // And its echo is not a loop.
    const echo = remoteTodo({ descriptionHtml: write?.descriptionHtml ?? '', updatedAt: T3 })
    expect(diffTask(local, baseAfterTodoWrite('uid-todo', echo, write!), echo, todoCtx()).outbound).toEqual([])
  })
})
