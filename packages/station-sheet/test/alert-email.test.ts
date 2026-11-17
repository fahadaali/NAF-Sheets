import { describe, expect, it } from 'vitest'
import { alertKey, composeAlertEmail, dueForEmail, resendRequest, type AlertRecord, type StationAlert } from '../src'

const ORIGIN = 'https://sheets.naflaw.sa'
const renamed: StationAlert = {
  kind: 'name_unmapped',
  linkId: 'l1',
  linkTitle: 'الاتصال المؤسسي والتسويق',
  tab: 'السوشل ميديا',
  role: 'مسؤول السوشل ميديا',
  name: 'عمر العمار',
  rows: 14,
  suggestion: { bcPersonId: 52761043, personName: 'عمر أبو عمار', previousName: 'أبو عمار' },
}
const unshared: StationAlert = { kind: 'link_stopped', linkId: 'l1', linkTitle: 'الاتصال المؤسسي والتسويق', reason: 'أُلغيت مشاركة الملف مع حساب المزامنة. شاركه معه كمحرّر.' }

const record = (alert: StationAlert, firstSeen: string, extra: Partial<AlertRecord> = {}): AlertRecord => ({
  key: alertKey(alert),
  alert,
  firstSeen,
  emailedAt: null,
  resolvedAt: null,
  ...extra,
})

describe('alertKey', () => {
  it('is the same for the same problem, so it is emailed once', () => {
    expect(alertKey(renamed)).toBe(alertKey({ ...renamed, rows: 15, tab: 'عام' }))
    expect(alertKey(renamed)).not.toBe(alertKey({ ...renamed, name: 'غيره' }))
  })
})

describe('dueForEmail', () => {
  it('waits for the batch window, then sends everything pending together', () => {
    const records = [record(renamed, '2026-11-15T10:00:00Z'), record(unshared, '2026-11-15T10:01:00Z')]
    expect(dueForEmail(records, '2026-11-15T10:01:30Z')).toEqual([])
    expect(dueForEmail(records, '2026-11-15T10:02:00Z').map((r) => r.alert.kind)).toEqual(['name_unmapped', 'link_stopped'])
  })

  it('never re-sends an emailed or resolved problem', () => {
    const records = [
      record(renamed, '2026-11-15T09:00:00Z', { emailedAt: '2026-11-15T09:02:00Z' }),
      record(unshared, '2026-11-15T09:00:00Z', { resolvedAt: '2026-11-15T09:01:00Z' }),
    ]
    expect(dueForEmail(records, '2026-11-15T12:00:00Z')).toEqual([])
  })
})

describe('composeAlertEmail', () => {
  it('writes one RTL Arabic email with a confirm button for the suggested person', () => {
    const email = composeAlertEmail([renamed], { origin: ORIGIN })
    expect(email.subject).toBe('NAF Sheets — اسم غير مربوط: «عمر العمار»')
    expect(email.html).toContain('dir="rtl"')
    expect(email.html).toContain('14 صفاً')
    expect(email.html).toContain('هل هو عمر أبو عمار؟ تأكيد')
    expect(email.html).toContain(`${ORIGIN}/names?name=${encodeURIComponent('عمر العمار')}&amp;suggest=52761043`)
    expect(email.text).toContain(`${ORIGIN}/names?name=${encodeURIComponent('عمر العمار')}&suggest=52761043`)
  })

  it('counts several problems in the subject and escapes sheet text', () => {
    const email = composeAlertEmail([{ ...renamed, name: '<b>x</b>', suggestion: undefined }, unshared], { origin: ORIGIN })
    expect(email.subject).toBe('NAF Sheets — 2 مشكلات أوقفت المزامنة')
    expect(email.html).not.toContain('<b>x</b>')
    expect(email.html).toContain('&lt;b&gt;x&lt;/b&gt;')
  })

  it('lists the held rows of an unmapped name, and explains a title written with two names', () => {
    const conflict: StationAlert = { kind: 'roles_conflict', linkId: 'l1', linkTitle: 'الاتصال المؤسسي والتسويق', tab: 'المسميات', role: 'الاعتمادات', names: ['فهد العتيبي', 'عمر العمار'] }
    const email = composeAlertEmail([{ ...renamed, suggestion: undefined, rowNumbers: [4, 9] }, conflict], { origin: ORIGIN })
    expect(email.text).toContain('(الصفوف 4، 9)')
    expect(email.text).toContain('المسمى «الاعتمادات» مكتوب بأكثر من اسم')
    expect(email.text).toContain('«فهد العتيبي» و«عمر العمار»')
    expect(alertKey(conflict)).toBe('roles_conflict:l1:الاعتمادات')
  })
})

describe('resendRequest', () => {
  it('posts from sheets@naflaw.sa with an idempotency key', async () => {
    const req = resendRequest(composeAlertEmail([unshared], { origin: ORIGIN }), { apiKey: 'test-key', to: ['admin@example.com'], idempotencyKey: 'k1' })
    expect(req.url).toBe('https://api.resend.com/emails')
    expect(req.headers.get('Authorization')).toBe('Bearer test-key')
    expect(req.headers.get('Idempotency-Key')).toBe('k1')
    const body = (await req.json()) as { from: string; to: string[] }
    expect(body.from).toBe('NAF Sheets <sheets@naflaw.sa>')
    expect(body.to).toEqual(['admin@example.com'])
  })
})
