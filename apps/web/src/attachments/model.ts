// What the attachment cell editor (spec §5.2, §10) and the comments of the
// details panel (§12.1 item 5) decide, as pure functions (unit-tested in
// Node; the components only render them).

import { COMMENT_MAX_LENGTH } from '@naf-sheets/shared'
import type { AttachmentInfo, AttachmentState } from '@naf-sheets/shared'
import { formatCount } from '../lib/format'
import { t } from '../strings'

/** "100 ميغابايت", "1.5 كيلوبايت", "900 بايت": Latin digits (spec §12.2). The caller wraps it in <bdi>. */
export function formatBytes(bytes: number): string {
  const mib = 1024 * 1024
  const one = (v: number) => (Number.isInteger(v) ? formatCount(v) : v.toFixed(1))
  if (bytes >= mib) return `${one(bytes / mib)} ميغابايت`
  if (bytes >= 1024) return `${one(bytes / 1024)} كيلوبايت`
  return `${formatCount(Math.max(0, Math.round(bytes)))} بايت`
}

/**
 * Why a file chosen or dropped is not sent, or null. Checked in the browser
 * so nothing too large leaves it; the API refuses the same files (413) anyway.
 */
export function checkFile(file: { name: string; size: number }, maxBytes: number): string | null {
  if (file.size > maxBytes) return t.attachments.tooLarge(file.name, formatBytes(maxBytes))
  if (file.size === 0) return t.attachments.empty0(file.name)
  return null
}

/** One file on its way up (the editor's list under the chips). */
export interface UploadItem {
  key: string
  name: string
  size: number
  loaded: number
  phase: 'uploading' | 'error'
  /** Arabic, for `error`. */
  message: string | null
}

/** Whole percent sent, 0…100. */
export function uploadPercent(item: Pick<UploadItem, 'loaded' | 'size'>): number {
  if (item.size <= 0) return 100
  return Math.max(0, Math.min(100, Math.round((item.loaded / item.size) * 100)))
}

/** Badge tone of a file's state (paired with a label and an icon, never colour alone). */
export function stateTone(state: AttachmentState): 'success' | 'info' | 'neutral' | 'danger' {
  switch (state) {
    case 'attached':
      return 'success'
    case 'uploading':
      return 'info'
    case 'local_only':
      return 'neutral'
    case 'failed':
      return 'danger'
  }
}

/** The confirmation sentence: a file in Basecamp leaves the to-do's description there too. */
export function removalSentence(file: Pick<AttachmentInfo, 'filename' | 'state'>): string {
  return file.state === 'attached' || file.state === 'uploading' ? t.attachments.confirmBody(file.filename) : t.attachments.confirmBodyLocal(file.filename)
}

/** The next file to focus after one was removed: the one after it, else the one before, else none. */
export function focusAfterRemoval(ids: readonly string[], removed: string): string | null {
  const at = ids.indexOf(removed)
  if (at < 0) return ids[0] ?? null
  return ids[at + 1] ?? ids[at - 1] ?? null
}

/** Why a comment is not sent, or null (the API checks the same rule). */
export function commentProblem(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed === '') return t.comments.emptyText
  if ([...trimmed].length > COMMENT_MAX_LENGTH) return t.comments.tooLong(COMMENT_MAX_LENGTH)
  return null
}

/** Files of a DataTransfer or an <input type=file>, as an array. */
export function filesOf(list: { length: number; item(i: number): File | null } | null | undefined): File[] {
  const out: File[] = []
  if (!list) return out
  for (let i = 0; i < list.length; i++) {
    const f = list.item(i)
    if (f) out.push(f)
  }
  return out
}

/** Whether a drag carries files (and not, say, text from the grid). */
export function dragHasFiles(types: readonly string[] | DOMStringList | null | undefined): boolean {
  if (!types) return false
  return Array.from(types as ArrayLike<string>).includes('Files')
}
