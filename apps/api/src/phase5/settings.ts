// Attachment settings (spec §10 «يُضبط في الإعدادات (افتراضي 100MB)», §12.1
// item 8), kept in KV `SETTINGS` as one small JSON value.
//
// OPEN (P6): the largest limit accepted is 100 MB: the Worker cannot take a
// larger request body on the Free and Pro plans (Cloudflare's published
// limit, not re-checked here). A higher limit needs another upload path
// (direct upload to R2), an owner decision.

import { ATTACHMENT_DEFAULT_MAX_BYTES } from '@naf-sheets/shared'
import type { AttachmentSettings } from '@naf-sheets/shared'

const KEY = 'settings:attachments'

export function validMaxBytes(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= ATTACHMENT_DEFAULT_MAX_BYTES
}

/** The settings in force; the defaults when none were saved or the saved value is unreadable. */
export async function attachmentSettings(kv: KVNamespace): Promise<AttachmentSettings> {
  let maxBytes = ATTACHMENT_DEFAULT_MAX_BYTES
  try {
    const raw = await kv.get(KEY)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { maxBytes?: unknown }
      if (validMaxBytes(parsed.maxBytes)) maxBytes = parsed.maxBytes
    }
  } catch {
    // An unreadable value: the defaults apply.
  }
  // OPEN (P3): a subtask's files stay in the platform; attaching them to the parent is undecided (§17-5).
  return { maxBytes, subtaskMode: 'local' }
}

export async function saveAttachmentSettings(kv: KVNamespace, maxBytes: number): Promise<AttachmentSettings> {
  await kv.put(KEY, JSON.stringify({ maxBytes }))
  return attachmentSettings(kv)
}
