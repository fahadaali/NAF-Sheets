// What a row holds in the sheet, as one hash. Detection compares it with the
// fingerprint stored at the previous save (`tasks.local_hash`): only a row
// whose content really changed gets a new `last_local_change_at`, which
// last-writer-wins compares with Basecamp's `updated_at` (spec §9.1).

import type { Assignee, LocalTask } from '@naf-sheets/shared'
import { normalizeHtml, sha256Hex } from '@naf-sheets/sync-engine'

function assigneeText(a: Assignee): string {
  return a.kind === 'external' ? `external:${a.externalContactId}:${a.source}:${a.notifyEmail ? 1 : 0}` : `${a.kind}:${a.bcPersonId}:${a.source}`
}

export function localFingerprint(task: LocalTask): string {
  const canonical = JSON.stringify([
    task.sheetId,
    task.level,
    task.parentUid,
    task.position,
    task.title.trim(),
    task.assignees.map(assigneeText).sort(),
    task.dueOn,
    task.startsOn,
    task.completed,
    normalizeHtml(task.notesHtml),
    Object.entries(task.freeColumnsForDescription).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ])
  return `f1:${sha256Hex(canonical)}`
}
