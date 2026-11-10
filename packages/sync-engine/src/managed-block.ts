// The managed block (spec §8.2): the one region of a to-do's description the
// platform owns. It sits at the very end, starts with a rule and a fixed bold
// title, and lists external assignees, the internal follower and the free
// columns marked "append to the description". Everything before it is the
// human part and is kept byte for byte.
//
// Only rich-text tags Basecamp allows are used: hr, div, strong, br
// (docs/phase-0-report.md §4.1). All text is HTML-escaped.

import type { Assignee, ExternalContact, LocalTask } from '@naf-sheets/shared'
import { escapeHtml, htmlToComparableText } from './html'

export const MANAGED_BLOCK_TITLE = 'بيانات من منصة الاتصال المؤسسي'
export const EXTERNALS_LABEL = 'مسؤولون خارجيون'
export const FOLLOWER_LABEL = 'المتابع الداخلي'
/** Arabic comma and a space, as in the spec's example line. */
export const LIST_SEPARATOR = '، '

export interface ManagedBlockContent {
  externals: ReadonlyArray<{ name: string; organization: string | null }>
  /** Display names of the internal followers. */
  followers: readonly string[]
  /** Free columns marked "append to the description", in column order. */
  freeColumns: ReadonlyArray<{ header: string; value: string }>
}

/** Names the block needs. Contacts by `ExternalContact.id`, people by Basecamp person id. */
export interface Directory {
  externalContacts: ReadonlyMap<string, ExternalContact>
  personNames: ReadonlyMap<number, string>
}

function textWithBreaks(value: string): string {
  return value
    .split(/\r\n|\r|\n/)
    .map((line) => escapeHtml(line))
    .join('<br>')
}

function externalLabel(e: { name: string; organization: string | null }): string {
  const name = e.name.trim()
  const org = e.organization?.trim() ?? ''
  return org === '' ? name : `${name} (${org})`
}

/** The block's HTML, or `null` when there is nothing to say (then no block is written). */
export function buildManagedBlock(content: ManagedBlockContent): string | null {
  const lines: string[] = []
  if (content.externals.length > 0) {
    lines.push(escapeHtml(`${EXTERNALS_LABEL}: ${content.externals.map(externalLabel).join(LIST_SEPARATOR)}`))
  }
  if (content.followers.length > 0) {
    // OPEN: the label is singular; the wording for several followers is undecided.
    lines.push(escapeHtml(`${FOLLOWER_LABEL}: ${content.followers.map((n) => n.trim()).join(LIST_SEPARATOR)}`))
  }
  for (const column of content.freeColumns) {
    if (column.value.trim() === '') continue
    lines.push(`${escapeHtml(column.header.replace(/\s+/g, ' ').trim())}: ${textWithBreaks(column.value)}`)
  }
  if (lines.length === 0) return null
  return `<hr><div><strong>${escapeHtml(MANAGED_BLOCK_TITLE)}</strong><br>${lines.join('<br>')}</div>`
}

export interface TaskBlock {
  html: string | null
  /** Ids the directory could not name (`external:<id>` / `person:<id>`). Non-empty → do not write the block. */
  missing: string[]
}

/**
 * Who goes into a to-do's block. Only assignees with `source: 'manual'` are
 * listed: on a parent in automatic mode, §8.1 says the subtasks' external
 * assignees are added to it "locally" (محلياً) and the followers in Basecamp's
 * assignee_ids, so the derived ones are not written into the parent's block.
 * OPEN: confirm that reading of §8.1 against §8.2 (see OPEN_QUESTIONS.md).
 */
export function managedBlockContentForTask(
  task: Pick<LocalTask, 'assignees' | 'freeColumnsForDescription'>,
  directory: Directory,
): { content: ManagedBlockContent; missing: string[] } {
  const missing: string[] = []
  const externals: Array<{ name: string; organization: string | null }> = []
  const followers: string[] = []
  const listed = task.assignees.filter((a: Assignee) => a.source === 'manual')
  for (const a of listed) {
    if (a.kind === 'external') {
      const contact = directory.externalContacts.get(a.externalContactId)
      if (contact) externals.push({ name: contact.name, organization: contact.organization })
      else missing.push(`external:${a.externalContactId}`)
    } else if (a.kind === 'follower') {
      const name = directory.personNames.get(a.bcPersonId)
      if (name !== undefined) followers.push(name)
      else missing.push(`person:${a.bcPersonId}`)
    }
  }
  const freeColumns = Object.entries(task.freeColumnsForDescription).map(([header, value]) => ({ header, value }))
  return { content: { externals, followers, freeColumns }, missing }
}

/** The block a to-do should carry now. Subtasks have no description (§8 table): always `null`. */
export function managedBlockForTask(
  task: Pick<LocalTask, 'level' | 'assignees' | 'freeColumnsForDescription'>,
  directory: Directory,
): TaskBlock {
  if (task.level !== 0) return { html: null, missing: [] }
  const { content, missing } = managedBlockContentForTask(task, directory)
  return { html: buildManagedBlock(content), missing }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const TITLE_PATTERN = new RegExp(`<strong\\b[^>]*>\\s*${escapeRegExp(escapeHtml(MANAGED_BLOCK_TITLE))}\\s*</strong>`, 'g')
/** Rule and opening div directly before the title, if Basecamp kept them. */
const LEAD_IN_PATTERN = /(?:<hr\b[^>]*>\s*)?(?:<div\b[^>]*>\s*)?$/

export interface SplitDescription {
  /** Everything before the block, byte for byte (attachments included). */
  human: string
  /** From the block's rule to the end, or `null` when there is no block. */
  block: string | null
}

/**
 * Separates the human part from the managed block. The block is found by its
 * bold title; the last occurrence wins, so a copy of the title higher up in
 * the human text stays human. Everything from the block's rule to the end is
 * platform-owned (§8.2: the block is always last).
 */
export function splitDescription(html: string | null | undefined): SplitDescription {
  const text = html ?? ''
  let titleAt = -1
  for (const match of text.matchAll(TITLE_PATTERN)) titleAt = match.index
  if (titleAt < 0) return { human: text, block: null }
  const before = text.slice(0, titleAt)
  const leadIn = LEAD_IN_PATTERN.exec(before)
  const start = leadIn ? leadIn.index : titleAt
  return { human: text.slice(0, start), block: text.slice(start) }
}

/** Human part, unchanged, followed by the block. */
export function composeDescription(human: string | null | undefined, block: string | null | undefined): string {
  return (human ?? '') + (block ?? '')
}

/**
 * Two blocks say the same thing. Compares visible text line by line, so a
 * sanitiser that rewrites markup or whitespace does not count as an edit and
 * cannot start a rewrite loop; a person changing the words does.
 */
export function sameManagedBlock(a: string | null | undefined, b: string | null | undefined): boolean {
  return htmlToComparableText(a) === htmlToComparableText(b)
}
