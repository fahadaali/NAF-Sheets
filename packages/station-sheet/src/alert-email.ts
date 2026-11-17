// Emails to the admin when sync stops for some rows (docs/station-plan.md §6.2).
//
// Pure: the API keeps one record per open problem (D1 `alerts`, unique `key`),
// asks `dueForEmail` which records to send now, sends `composeAlertEmail`'s
// message through `resendRequest`, then stamps `emailedAt`. A problem is
// emailed once until it is resolved; problems that appear within the batch
// window go out together. Nothing is emailed when a problem is resolved.

import type { IsoDateTime } from '@naf-sheets/shared'

export type StationAlert =
  /** A name in «المسميات» has no Basecamp person. `suggestion`: the person the title had before. */
  | {
      kind: 'name_unmapped'
      linkId: string
      linkTitle: string
      tab: string
      role: string
      name: string
      rows: number
      /** 1-based sheet rows held for it. */
      rowNumbers?: number[]
      suggestion?: { bcPersonId: number; personName: string; previousName: string }
    }
  | { kind: 'not_project_member'; linkId: string; linkTitle: string; personName: string; bcPersonId: number; projectName: string; rows: number }
  /** Rows held back for one reason in one tab (unknown title, title without a name, unreadable date …). */
  | {
      kind: 'rows_held'
      linkId: string
      linkTitle: string
      tab: string
      code: string
      /** What the rows share (a title, a name, a cell text); with `code`, the problem's identity. */
      subject?: string
      reason: string
      rows: number
      /** 1-based sheet rows concerned. */
      rowNumbers?: number[]
    }
  /**
   * A title written twice in the roles tab with different names: the first is
   * used. Nothing stops, but the admin should say which one is right.
   */
  | { kind: 'roles_conflict'; linkId: string; linkTitle: string; tab: string; role: string; names: string[] }
  /** A whole tab stopped: fixed column missing or renamed. */
  | { kind: 'tab_stopped'; linkId: string; linkTitle: string; tab: string; reason: string }
  /** The whole link stopped: file unshared or deleted, Basecamp refused the sync account. */
  | { kind: 'link_stopped'; linkId: string; linkTitle: string; reason: string }

export interface AlertRecord {
  key: string
  alert: StationAlert
  firstSeen: IsoDateTime
  emailedAt: IsoDateTime | null
  resolvedAt: IsoDateTime | null
}

/** Problems appearing within this window share one email. */
export const BATCH_WINDOW_MS = 2 * 60_000

/** One key per problem: the same problem seen again is the same record. */
export function alertKey(alert: StationAlert): string {
  switch (alert.kind) {
    case 'name_unmapped':
      return `name_unmapped:${alert.name}`
    case 'not_project_member':
      return `not_project_member:${alert.linkId}:${alert.bcPersonId}`
    case 'rows_held':
      return `rows_held:${alert.linkId}:${alert.tab}:${alert.code}:${alert.subject ?? ''}`
    case 'roles_conflict':
      return `roles_conflict:${alert.linkId}:${alert.role}`
    case 'tab_stopped':
      return `tab_stopped:${alert.linkId}:${alert.tab}`
    case 'link_stopped':
      return `link_stopped:${alert.linkId}`
  }
}

/**
 * Records to email now: every open, not yet emailed record, once the oldest
 * of them has waited the batch window. Empty while the window is open.
 */
export function dueForEmail(records: readonly AlertRecord[], now: IsoDateTime): AlertRecord[] {
  const pending = records.filter((r) => r.emailedAt === null && r.resolvedAt === null)
  if (pending.length === 0) return []
  const oldest = Math.min(...pending.map((r) => Date.parse(r.firstSeen)))
  return Date.parse(now) - oldest >= BATCH_WINDOW_MS ? pending : []
}

export interface AlertEmail {
  subject: string
  html: string
  text: string
}

export interface ComposeOptions {
  /** Public origin of the platform, e.g. https://sheets.naflaw.sa (no trailing slash). */
  origin: string
}

interface Item {
  title: string
  detail: string
  action: { label: string; url: string }
  extra?: { label: string; url: string }
}

function itemOf(alert: StationAlert, origin: string): Item {
  const link = `${origin}/links/${encodeURIComponent(alert.linkId)}`
  switch (alert.kind) {
    case 'name_unmapped': {
      const names = `${origin}/names?name=${encodeURIComponent(alert.name)}`
      const item: Item = {
        title: `اسم غير مربوط: «${alert.name}»`,
        detail: `ظهر أمام المسمى «${alert.role}» في تبويب «${alert.tab}» من «${alert.linkTitle}»، ولا يقابله شخص في Basecamp. توقفت مزامنة ${rowsText(alert.rows)} حتى يُربط${rowList(alert.rowNumbers)}.`,
        action: { label: 'اربط الاسم', url: names },
      }
      if (alert.suggestion) {
        const s = alert.suggestion
        item.detail += ` كان هذا المسمى لـ«${s.previousName}» المربوط بـ«${s.personName}».`
        item.extra = { label: `هل هو ${s.personName}؟ تأكيد`, url: `${names}&suggest=${s.bcPersonId}` }
      }
      return item
    }
    case 'not_project_member':
      return {
        title: `«${alert.personName}» ليس عضواً في المشروع`,
        detail: `مسند إليه ${rowsText(alert.rows)} في «${alert.linkTitle}»، وليس عضواً في مشروع «${alert.projectName}» في Basecamp. أضفه إلى المشروع لتُستأنف مزامنتها.`,
        action: { label: 'افتح الربط', url: link },
      }
    case 'rows_held':
      return {
        title: `توقفت مزامنة ${rowsText(alert.rows)} في تبويب «${alert.tab}»`,
        detail: `في «${alert.linkTitle}»: ${alert.reason}${rowList(alert.rowNumbers)}`,
        action: { label: 'افتح الربط', url: link },
      }
    case 'roles_conflict':
      return {
        title: `المسمى «${alert.role}» مكتوب بأكثر من اسم`,
        detail: `في تبويب «${alert.tab}» من «${alert.linkTitle}»: ${alert.names.map((n) => `«${n}»`).join(' و')}. يُعمل بالأول حتى يُحذف المكرر أو يوحَّد الاسم.`,
        action: { label: 'افتح الربط', url: link },
      }
    case 'tab_stopped':
      return {
        title: `توقفت مزامنة تبويب «${alert.tab}»`,
        detail: `في «${alert.linkTitle}»: ${alert.reason}`,
        action: { label: 'افتح الربط', url: link },
      }
    case 'link_stopped':
      return {
        title: `توقفت مزامنة «${alert.linkTitle}» كلها`,
        detail: alert.reason,
        action: { label: 'افتح الربط', url: link },
      }
  }
}

/** « (الصفوف 4، 9، 12)» — at most ten, then «…». */
export function rowList(rows: readonly number[] | undefined): string {
  if (!rows || rows.length === 0) return ''
  const shown = rows.slice(0, 10).join('، ')
  return ` (${rows.length === 1 ? 'الصف' : 'الصفوف'} ${shown}${rows.length > 10 ? '، …' : ''})`
}

function rowsText(n: number): string {
  if (n === 1) return 'صف واحد'
  if (n === 2) return 'صفين'
  if (n >= 3 && n <= 10) return `${n} صفوف`
  return `${n} صفاً`
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function composeAlertEmail(alerts: readonly StationAlert[], options: ComposeOptions): AlertEmail {
  const items = alerts.map((a) => itemOf(a, options.origin))
  const subject =
    items.length === 1 ? `NAF Sheets — ${items[0]!.title}` : `NAF Sheets — ${items.length} مشكلات أوقفت المزامنة`
  const button = (b: { label: string; url: string }, primary: boolean): string =>
    `<a href="${escapeHtml(b.url)}" style="display:inline-block;padding:8px 16px;margin-inline-end:8px;border-radius:6px;text-decoration:none;${
      primary ? 'background:#1f2937;color:#ffffff;' : 'background:#ffffff;color:#1f2937;border:1px solid #1f2937;'
    }">${escapeHtml(b.label)}</a>`
  const blocks = items
    .map(
      (i) => `<div style="padding:16px 0;border-bottom:1px solid #e5e7eb;">
<h2 style="font-size:16px;margin:0 0 8px;">${escapeHtml(i.title)}</h2>
<p style="margin:0 0 12px;line-height:1.7;">${escapeHtml(i.detail)}</p>
${i.extra ? button(i.extra, true) + button(i.action, false) : button(i.action, true)}
</div>`,
    )
    .join('\n')
  const html = `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#f9fafb;color:#1f2937;font-family:Tahoma,Arial,sans-serif;direction:rtl;text-align:right;">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:24px;">
<p style="margin:0 0 8px;line-height:1.7;">توقفت مزامنة بعض المهام بين Google Sheets وBasecamp. بقية المهام تعمل كالمعتاد.</p>
${blocks}
<p style="margin:16px 0 0;font-size:12px;color:#6b7280;">لن يتكرر هذا التنبيه حتى تُحل المشكلة.</p>
</div></body></html>`
  const text = [
    'توقفت مزامنة بعض المهام بين Google Sheets وBasecamp. بقية المهام تعمل كالمعتاد.',
    '',
    ...items.flatMap((i) => [
      `• ${i.title}`,
      `  ${i.detail}`,
      ...(i.extra ? [`  ${i.extra.label}: ${i.extra.url}`] : []),
      `  ${i.action.label}: ${i.action.url}`,
      '',
    ]),
    'لن يتكرر هذا التنبيه حتى تُحل المشكلة.',
  ].join('\n')
  return { subject, html, text }
}

export const ALERT_SENDER = 'NAF Sheets <sheets@naflaw.sa>'

/**
 * The Resend API call (POST /emails). `idempotencyKey` (e.g. the batch's keys
 * hashed) makes a retried send not deliver twice.
 */
export function resendRequest(
  email: AlertEmail,
  options: { apiKey: string; to: readonly string[]; idempotencyKey: string; from?: string },
): Request {
  return new Request('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': options.idempotencyKey,
    },
    body: JSON.stringify({
      from: options.from ?? ALERT_SENDER,
      to: [...options.to],
      subject: email.subject,
      html: email.html,
      text: email.text,
    }),
  })
}
