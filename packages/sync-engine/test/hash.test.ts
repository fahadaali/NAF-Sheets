import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  baseAfterSubtaskWrite,
  baseAfterTodoWrite,
  baseFromRemote,
  baseWith,
  hashSyncedFields,
  isEcho,
  sha256Hex,
  syncedFieldsOfBase,
  syncedFieldsOfRemote,
  utf8Encode,
  type SyncedFields,
} from '../src'
import { AHMED, BADR, DANA, JUMANA, LIST, OTHER_LIST, remoteSubtask, remoteTodo, T2 } from './fixtures'

const nodeSha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
  })

  it('matches node:crypto on Arabic, astral characters and every padding boundary', () => {
    const samples = ['بيانات من منصة الاتصال المؤسسي', 'مرحبا \u{1F44B} ok', '\u{1F600}é中']
    for (let n = 50; n <= 130; n++) samples.push('ن'.repeat(n), 'a'.repeat(n))
    for (const s of samples) expect(sha256Hex(s)).toBe(nodeSha(s))
  })

  it('encodes UTF-8 like the platform and replaces lone surrogates', () => {
    expect([...utf8Encode('a\u00e9\u20ac\u{1F600}')]).toEqual([...Buffer.from('a\u00e9\u20ac\u{1F600}', 'utf8')])
    expect([...utf8Encode('\ud800')]).toEqual([0xef, 0xbf, 0xbd])
  })
})

const fields = (overrides: Partial<SyncedFields> = {}): SyncedFields => ({
  bcType: 'todo',
  title: 'إطلاق الحملة',
  bcAssigneeIds: [AHMED, BADR],
  dueOn: '2026-12-01',
  startsOn: null,
  completed: false,
  notesHtml: '<div>نص</div>',
  managedBlockHtml: null,
  position: 1,
  ...overrides,
})

describe('hashSyncedFields', () => {
  it('is deterministic and versioned', () => {
    expect(hashSyncedFields(fields())).toBe(hashSyncedFields(fields()))
    expect(hashSyncedFields(fields())).toMatch(/^v1:[0-9a-f]{64}$/)
  })

  it('ignores assignee order and duplicates, title padding and HTML whitespace', () => {
    const h = hashSyncedFields(fields())
    expect(hashSyncedFields(fields({ bcAssigneeIds: [BADR, AHMED, BADR] }))).toBe(h)
    expect(hashSyncedFields(fields({ title: '  إطلاق الحملة ' }))).toBe(h)
    expect(hashSyncedFields(fields({ notesHtml: '<div>\n  نص\n</div>' }))).toBe(h)
  })

  it('changes with every synced field', () => {
    const h = hashSyncedFields(fields())
    const variants: Partial<SyncedFields>[] = [
      { title: 'عنوان آخر' },
      { bcAssigneeIds: [AHMED] },
      { dueOn: '2026-12-02' },
      { startsOn: '2026-11-01' },
      { completed: true },
      { notesHtml: '<div>نص آخر</div>' },
      { managedBlockHtml: '<hr><div><strong>بيانات من منصة الاتصال المؤسسي</strong><br>س</div>' },
      { position: 2 },
    ]
    for (const v of variants) expect(hashSyncedFields(fields(v))).not.toBe(h)
  })

  it('compares the managed block by its text, not its markup', () => {
    const block = '<hr><div><strong>بيانات من منصة الاتصال المؤسسي</strong><br>مسؤولون خارجيون: سارة</div>'
    const reflowed = '<hr/>\n<div>\n<strong>بيانات من منصة الاتصال المؤسسي</strong><br/>مسؤولون خارجيون:  سارة\n</div>'
    expect(hashSyncedFields(fields({ managedBlockHtml: reflowed }))).toBe(hashSyncedFields(fields({ managedBlockHtml: block })))
  })

  it('ignores fields subtasks do not have', () => {
    const sub = fields({ bcType: 'subtask', notesHtml: null, startsOn: null })
    expect(hashSyncedFields({ ...sub, startsOn: '2026-01-01', notesHtml: '<div>x</div>' })).toBe(hashSyncedFields(sub))
  })
})

describe('bases and echo suppression', () => {
  it('a base read from a record hashes its own fields and recognises the same record', () => {
    const remote = remoteTodo()
    const base = baseFromRemote('u', remote)
    expect(base.hash).toBe(hashSyncedFields(syncedFieldsOfBase(base)))
    expect(base.hash).toBe(hashSyncedFields(syncedFieldsOfRemote(remote)))
    expect(isEcho({ ...remote, updatedAt: T2 }, base)).toBe(true)
    expect(isEcho({ ...remote, dueOn: '2027-01-01' }, base)).toBe(false)
  })

  it('a base after a write keeps what was sent; a reflowed echo of it still matches', () => {
    const write = {
      content: 'إطلاق الحملة',
      descriptionHtml: '<div>نص</div><hr><div><strong>بيانات من منصة الاتصال المؤسسي</strong><br>المتابع الداخلي: فهد</div>',
      assigneeIds: [BADR, AHMED],
      completionSubscriberIds: [DANA],
      dueOn: '2026-12-01',
      startsOn: null,
      notify: false,
    }
    const response = remoteTodo({
      descriptionHtml: '<div>\nنص\n</div>\n<hr />\n<div><strong>بيانات من منصة الاتصال المؤسسي</strong><br />المتابع الداخلي: فهد</div>',
      assigneeIds: [AHMED, BADR],
      startsOn: null,
      updatedAt: T2,
    })
    const base = baseAfterTodoWrite('u', response, write)
    expect(base.notesHtml).toBe('<div>نص</div>')
    expect(base.bcAssigneeIds).toEqual([AHMED, BADR])
    expect(base.remoteUpdatedAt).toBe(T2)
    expect(isEcho(response, base)).toBe(true)
  })

  it('a subtask base after a patch takes sent fields over the response', () => {
    const response = remoteSubtask({ title: 'قديم', dueOn: '2026-11-20' })
    const base = baseAfterSubtaskWrite('u', response, { dueOn: null })
    expect(base.dueOn).toBeNull()
    expect(base.title).toBe('قديم')
    expect(base.startsOn).toBeNull()
    expect(base.notesHtml).toBeNull()
  })

  it('baseWith updates completion or position and the hash with it', () => {
    const base = baseFromRemote('u', remoteSubtask())
    const done = baseWith(base, { completed: true })
    expect(done.completed).toBe(true)
    expect(done.hash).not.toBe(base.hash)
    expect(done.hash).toBe(hashSyncedFields(syncedFieldsOfBase(done)))
  })

  it('a to-do base keeps its list and completion subscribers (not hashed); a subtask base has none', () => {
    const remote = remoteTodo({ completionSubscriberIds: [DANA, JUMANA] })
    const base = baseFromRemote('u', remote)
    expect(base).toMatchObject({ listId: LIST, completionSubscriberIds: [DANA, JUMANA] })
    remote.completionSubscriberIds.push(AHMED)
    expect(base.completionSubscriberIds).toEqual([DANA, JUMANA])
    expect(isEcho({ ...remote, completionSubscriberIds: [], listId: OTHER_LIST }, base)).toBe(true)
    expect(baseFromRemote('s', remoteSubtask())).toMatchObject({ listId: null, completionSubscriberIds: [] })
  })

  it('a base after a to-do write takes list and subscribers from Basecamp’s response', () => {
    const write = { content: 'x', descriptionHtml: '', assigneeIds: [], completionSubscriberIds: [DANA], dueOn: null, startsOn: null, notify: false }
    const base = baseAfterTodoWrite('u', remoteTodo({ listId: OTHER_LIST, completionSubscriberIds: [DANA, JUMANA] }), write)
    expect(base).toMatchObject({ listId: OTHER_LIST, completionSubscriberIds: [DANA, JUMANA] })
  })

  it('baseWith records a move to another list without touching the hash', () => {
    const base = baseFromRemote('u', remoteTodo())
    const moved = baseWith(base, { position: 3, listId: OTHER_LIST })
    expect(moved).toMatchObject({ position: 3, listId: OTHER_LIST, completionSubscriberIds: base.completionSubscriberIds })
    expect(baseWith(moved, { position: 1 }).hash).toBe(base.hash)
    expect(baseWith(base, { completed: true }).listId).toBe(LIST)
  })
})

describe('positions Basecamp did not send (single-record GET)', () => {
  it('a record without a position is an echo of a base with any position', () => {
    const base = baseFromRemote('u', remoteTodo({ position: 4 }))
    expect(syncedFieldsOfRemote(remoteTodo({ position: null })).position).toBeNull()
    expect(isEcho(remoteTodo({ position: null, updatedAt: T2 }), base)).toBe(true)
    expect(isEcho(remoteTodo({ position: null, dueOn: '2027-01-01' }), base)).toBe(false)
    expect(isEcho(remoteTodo({ position: 5 }), base)).toBe(false)
  })

  it('a base built from such a record keeps the last known position, and never invents one', () => {
    expect(baseFromRemote('u', remoteTodo({ position: null }), 4).position).toBe(4)
    expect(baseFromRemote('u', remoteTodo({ position: 2 }), 4).position).toBe(2)
    expect(() => baseFromRemote('u', remoteTodo({ position: null }))).toThrow(/position/)
    expect(() => baseFromRemote('u', remoteSubtask({ position: null }))).toThrow(/position/)
  })

  it('bases after writes whose response has no position use the last known one', () => {
    const write = { content: 'x', descriptionHtml: '', assigneeIds: [], completionSubscriberIds: [], dueOn: null, startsOn: null, notify: false }
    expect(baseAfterTodoWrite('u', remoteTodo({ position: null }), write, 3).position).toBe(3)
    expect(() => baseAfterTodoWrite('u', remoteTodo({ position: null }), write)).toThrow(/position/)
    expect(baseAfterSubtaskWrite('u', remoteSubtask({ position: null }), { title: 't' }, 2).position).toBe(2)
    expect(() => baseAfterSubtaskWrite('u', remoteSubtask({ position: null }), { title: 't' })).toThrow(/position/)
  })
})
