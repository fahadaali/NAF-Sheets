import { describe, expect, it } from 'vitest'
import {
  buildManagedBlock,
  composeDescription,
  managedBlockForTask,
  MANAGED_BLOCK_TITLE,
  sameHtml,
  sameManagedBlock,
  splitDescription,
} from '../src'
import { directory, external, FAHAD, follower, HUMAN_NOTES, KHALID, localSubtask, localTodo, person, AHMED, SARA, tagNames } from './fixtures'

const ALLOWED_TAGS = ['br', 'div', 'hr', 'strong']

describe('buildManagedBlock', () => {
  it('writes the fixed title, externals, follower and free columns with allowed tags only', () => {
    const html = buildManagedBlock({
      externals: [
        { name: 'سارة المطيري', organization: 'وكالة الإعلام' },
        { name: 'خالد', organization: null },
      ],
      followers: ['فهد'],
      freeColumns: [{ header: 'الميزانية', value: '5000' }],
    })
    expect(html).toBe(
      `<hr><div><strong>${MANAGED_BLOCK_TITLE}</strong><br>` +
        'مسؤولون خارجيون: سارة المطيري (وكالة الإعلام)، خالد<br>' +
        'المتابع الداخلي: فهد<br>' +
        'الميزانية: 5000</div>',
    )
    expect(tagNames(html ?? '')).toEqual(ALLOWED_TAGS)
  })

  it('escapes every piece of text and turns line breaks in a value into <br>', () => {
    const html = buildManagedBlock({
      externals: [{ name: '<script>alert(1)</script>', organization: 'A & B' }],
      followers: [],
      freeColumns: [{ header: 'ملاحظة <b>', value: 'سطر 1\nسطر <2>' }],
    })
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; (A &amp; B)')
    expect(html).toContain('ملاحظة &lt;b&gt;: سطر 1<br>سطر &lt;2&gt;')
    expect(tagNames(html ?? '').every((t) => ALLOWED_TAGS.includes(t))).toBe(true)
  })

  it('is null when there is nothing to say, and skips empty free columns', () => {
    expect(buildManagedBlock({ externals: [], followers: [], freeColumns: [{ header: 'س', value: '  ' }] })).toBeNull()
  })
})

describe('managedBlockForTask', () => {
  it('lists manual externals and followers by name, plus free columns', () => {
    const block = managedBlockForTask(
      localTodo({
        assignees: [person(AHMED), external(SARA), follower(FAHAD)],
        freeColumnsForDescription: { القناة: 'X' },
      }),
      directory,
    )
    expect(block.missing).toEqual([])
    expect(block.html).toContain('مسؤولون خارجيون: سارة المطيري (وكالة الإعلام)')
    expect(block.html).toContain('المتابع الداخلي: فهد')
    expect(block.html).toContain('القناة: X')
  })

  it('reports names the directory does not have', () => {
    const block = managedBlockForTask(localTodo({ assignees: [external('ext-unknown'), follower(999)] }), directory)
    expect(block.missing).toEqual(['external:ext-unknown', 'person:999'])
  })

  it('leaves out assignees derived automatically from subtasks (§8.1 "locally")', () => {
    const block = managedBlockForTask(localTodo({ assignees: [external(KHALID, 'auto'), follower(FAHAD, 'auto')] }), directory)
    expect(block.html).toBeNull()
  })

  it('is always null for a subtask (no description in Basecamp)', () => {
    expect(managedBlockForTask(localSubtask({ assignees: [external(SARA), follower(FAHAD)] }), directory).html).toBeNull()
  })
})

const BLOCK = `<hr><div><strong>${MANAGED_BLOCK_TITLE}</strong><br>مسؤولون خارجيون: سارة</div>`

describe('splitDescription / composeDescription', () => {
  it('returns the whole description as human when there is no block', () => {
    expect(splitDescription(HUMAN_NOTES)).toEqual({ human: HUMAN_NOTES, block: null })
    expect(splitDescription(null)).toEqual({ human: '', block: null })
  })

  it('separates the human part byte for byte and round-trips', () => {
    const description = HUMAN_NOTES + BLOCK
    const { human, block } = splitDescription(description)
    expect(human).toBe(HUMAN_NOTES)
    expect(block).toBe(BLOCK)
    expect(composeDescription(human, block)).toBe(description)
  })

  it('finds a block Basecamp reflowed or rewrote (<hr />, spaces, attributes)', () => {
    const reflowed = `\n<hr />\n<div class="x">\n  <strong>${MANAGED_BLOCK_TITLE}</strong><br/>مسؤولون خارجيون: سارة\n</div>`
    const { human, block } = splitDescription(HUMAN_NOTES + reflowed)
    expect(human).toBe(HUMAN_NOTES + '\n')
    expect(sameManagedBlock(block, BLOCK)).toBe(true)
  })

  it('finds the block by its title even if the rule was removed', () => {
    const { human, block } = splitDescription(`<div>أ</div><div><strong>${MANAGED_BLOCK_TITLE}</strong><br>س</div>`)
    expect(human).toBe('<div>أ</div>')
    expect(block?.startsWith('<div><strong>')).toBe(true)
  })

  it('takes the last title, so a quoted copy higher up stays human', () => {
    const human = `<div>نسخة: <strong>${MANAGED_BLOCK_TITLE}</strong></div>`
    expect(splitDescription(human + BLOCK)).toEqual({ human, block: BLOCK })
  })

  it('composes block-only and human-only descriptions', () => {
    expect(composeDescription(null, BLOCK)).toBe(BLOCK)
    expect(composeDescription(HUMAN_NOTES, null)).toBe(HUMAN_NOTES)
  })
})

describe('comparison', () => {
  it('sameHtml ignores whitespace and void-tag spelling only', () => {
    expect(sameHtml('<div>أ</div>\n<div>ب</div>', '<div>أ</div><div>ب</div>')).toBe(true)
    expect(sameHtml('أ<br/>ب', 'أ<br>ب')).toBe(true)
    expect(sameHtml('<div>أ</div>', '<div>ب</div>')).toBe(false)
    expect(sameHtml(null, '')).toBe(true)
  })

  it('sameManagedBlock sees a person changing the words, not a sanitiser changing markup', () => {
    expect(sameManagedBlock(BLOCK, BLOCK.replace('<strong>', '<strong class="a">'))).toBe(true)
    expect(sameManagedBlock(BLOCK, BLOCK.replace('سارة', 'سارة وخالد'))).toBe(false)
    expect(sameManagedBlock(null, '')).toBe(true)
  })
})
