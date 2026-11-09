// Phase 0 live Basecamp test (spec §15, phase 0, third item).
//
// Creates a to-do list, a to-do with a managed description block, and two
// subtasks in a TEST project; registers a webhook pointing at the recorder;
// then lets a human make changes in the Basecamp UI while this script records
// which webhook `kind` (if any) arrives for each change.
//
// It never deletes or trashes anything. Everything it created is listed in the
// state file so a person can clean up by hand.
//
// Usage (see README.md for the full walkthrough):
//   node live-test.mjs setup
//   node live-test.mjs check-block      managed block survives Basecamp's sanitiser?
//   node live-test.mjs check-put        PUT /todos with all fields keeps assignees + description?
//   node live-test.mjs mark "<action>"  before each change you make in the Basecamp UI
//   node live-test.mjs events           pull deliveries from the recorder
//   node live-test.mjs report           write live-test-report.md
//
// Environment:
//   BC_TOKEN, BC_ACCOUNT_ID, BC_PROJECT_ID   test account + project (never production)
//   BC_ASSIGNEE_ID                           a person in that project
//   RECORDER_URL, RECORDER_SECRET, READ_TOKEN
//   BC_API_BASE                              optional; defaults to https://3.basecampapi.com

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const STATE_FILE = process.env.STATE_FILE ?? '.live-test-state.json'
const REPORT_FILE = process.env.REPORT_FILE ?? 'live-test-report.md'
// Mandatory on every request (spec §9.2.10); without it Basecamp answers 400.
const USER_AGENT = 'NAF Comms (info@naflaw.sa)'
const WEBHOOK_TYPES = ['Todo', 'Todolist', 'Kanban::Step', 'Comment', 'Upload']
const BLOCK_TITLE = 'بيانات من منصة الاتصال المؤسسي'

export const MANUAL_STEPS = [
  'تغيير تاريخ استحقاق المهمة',
  'تغيير تاريخ استحقاق المهمة الفرعية الأولى',
  'إسناد المهمة الفرعية الأولى لشخص آخر',
  'إنجاز المهمة الفرعية الأولى',
  'إلغاء إنجاز المهمة الفرعية الأولى',
  'إعادة ترتيب المهام الفرعية (الثانية قبل الأولى)',
  'حذف المهمة الفرعية الثانية',
]

// ---------- pure helpers (unit-tested) ----------

/** The managed block exactly as the platform would write it (§8.2). */
export function managedBlockHtml(lines) {
  const body = lines.map(escapeHtml).join('<br>')
  return `<hr><div><strong>${BLOCK_TITLE}</strong><br>${body}</div>`
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Whitespace-insensitive comparison: Basecamp may reflow markup but must not drop or reorder it. */
export function normaliseHtml(html) {
  return String(html ?? '').replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim()
}

/** Reduce a raw webhook delivery to the fields the report needs. */
export function summariseDelivery(delivery) {
  let body
  try {
    body = JSON.parse(delivery.raw)
  } catch {
    return null
  }
  return {
    id: body.id,
    kind: body.kind,
    createdAt: body.created_at ?? delivery.receivedAt,
    receivedAt: delivery.receivedAt,
    recordingType: body.recording?.type,
    recordingId: body.recording?.id,
    bucketId: body.recording?.bucket?.id,
    title: body.recording?.title,
    details: body.details ?? null,
  }
}

/**
 * Attribute each event to the most recent marker before it. Events are matched
 * on Basecamp's own `created_at`, so recorder delay does not shift them into
 * the next action's window.
 */
export function buildReport(markers, events) {
  const sorted = [...markers].sort((a, b) => a.at.localeCompare(b.at))
  const rows = sorted.map((m, i) => {
    const end = sorted[i + 1]?.at ?? '9999'
    const hits = events.filter((e) => e.createdAt >= m.at && e.createdAt < end)
    return { action: m.label, at: m.at, kinds: [...new Set(hits.map((e) => `${e.kind} (${e.recordingType})`))] }
  })
  const lines = [
    '| الإجراء في واجهة Basecamp | الوقت | ما وصل من Webhook |',
    '|---|---|---|',
    ...rows.map((r) => `| ${r.action} | ${r.at} | ${r.kinds.length ? r.kinds.map((k) => `\`${k}\``).join('، ') : '**لم يصل شيء**'} |`),
  ]
  return { rows, markdown: lines.join('\n') }
}

// ---------- Basecamp client (spike-grade) ----------

function env(name, { optional = false } = {}) {
  const v = process.env[name]
  if (!v && !optional) throw new Error(`متغيّر البيئة ${name} غير مضبوط`)
  return v
}

async function bc(method, path, body) {
  const base = (process.env.BC_API_BASE ?? 'https://3.basecampapi.com').replace(/\/$/, '')
  const url = path.startsWith('http') ? path : `${base}/${env('BC_ACCOUNT_ID')}${path}`
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${env('BC_TOKEN')}`,
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') ?? '5')
      await new Promise((r) => setTimeout(r, wait * 1000))
      continue
    }
    if (res.status >= 500) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000))
      continue
    }
    if (!res.ok) {
      const reason = res.headers.get('reason')
      throw new Error(`${method} ${path} → ${res.status}${reason ? ` (Reason: ${reason})` : ''}: ${(await res.text()).slice(0, 300)}`)
    }
    return res.status === 204 ? null : res.json()
  }
  throw new Error(`${method} ${path}: استُنفدت المحاولات`)
}

// ---------- state ----------

function loadState() {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { created: [], markers: [], events: [] }
}
function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2))
}

// ---------- commands ----------

async function setup() {
  const state = loadState()
  if (state.todoId) throw new Error(`الإعداد تمّ سابقاً (المهمة ${state.todoId}). احذف ${STATE_FILE} يدوياً لبدء جولة جديدة.`)
  const projectId = env('BC_PROJECT_ID')
  const assigneeId = Number(env('BC_ASSIGNEE_ID'))

  const project = await bc('GET', `/projects/${projectId}.json`)
  const todoset = project.dock?.find((d) => d.name === 'todoset')
  if (!todoset?.enabled) throw new Error('أداة المهام (todoset) غير مفعّلة في هذا المشروع')

  const stamp = new Date().toISOString().slice(0, 16)
  const list = await bc('POST', `/todosets/${todoset.id}/todolists.json`, { name: `اختبار المرحلة 0 — ${stamp}` })
  state.created.push({ type: 'Todolist', id: list.id, url: list.app_url })

  const webhook = await bc('POST', `/buckets/${projectId}/webhooks.json`, {
    payload_url: `${env('RECORDER_URL').replace(/\/$/, '')}/webhooks/basecamp/${env('RECORDER_SECRET')}`,
    types: WEBHOOK_TYPES,
  })
  state.created.push({ type: 'Webhook', id: webhook.id })

  const humanPart = '<div>وصف كتبه شخص: هذا النص يجب أن يبقى كما هو حرفياً.</div>'
  const block = managedBlockHtml(['مسؤولون خارجيون: جهة اختبار (شركة اختبار)', 'المتابع الداخلي: —'])
  const todo = await bc('POST', `/todolists/${list.id}/todos.json`, {
    content: 'مهمة اختبار المرحلة 0',
    description: humanPart + block,
    assignee_ids: [assigneeId],
    due_on: '2026-12-01',
    starts_on: '2026-11-20',
    notify: false,
  })
  state.created.push({ type: 'Todo', id: todo.id, url: todo.app_url })

  const sub1 = await bc('POST', `/recordings/${todo.id}/subtasks.json`, { title: 'مهمة فرعية أولى', due_on: '2026-11-25', assignee_ids: [assigneeId] })
  const sub2 = await bc('POST', `/recordings/${todo.id}/subtasks.json`, { title: 'مهمة فرعية ثانية', due_on: '2026-11-26' })
  state.created.push({ type: 'Kanban::Step', id: sub1.id }, { type: 'Kanban::Step', id: sub2.id })

  Object.assign(state, {
    projectId: Number(projectId),
    todolistId: list.id,
    webhookId: webhook.id,
    todoId: todo.id,
    subtaskIds: [sub1.id, sub2.id],
    sentDescription: humanPart + block,
  })
  saveState(state)

  console.log(`أُنشئت القائمة والمهمة وفرعيتان. افتح المهمة في Basecamp:\n  ${todo.app_url}\n`)
  console.log('قبل كل خطوة في واجهة Basecamp سجّل علامة، ثم نفّذ الخطوة وانتظر دقيقة:')
  MANUAL_STEPS.forEach((s, i) => console.log(`  ${i + 1}. node live-test.mjs mark "${s}"`))
  console.log('\nثم: node live-test.mjs events && node live-test.mjs report')
}

async function checkBlock() {
  const state = loadState()
  const todo = await bc('GET', `/todos/${state.todoId}.json`)
  const sent = normaliseHtml(state.sentDescription)
  const got = normaliseHtml(todo.description)
  const blockSent = sent.slice(sent.indexOf('<hr'))
  const intact = got.includes(blockSent)
  console.log(intact ? 'الكتلة المُدارة سليمة بعد الحفظ في Basecamp.' : 'الكتلة المُدارة تغيّرت بعد الحفظ:')
  if (!intact) console.log(`  أُرسل:  ${blockSent}\n  رجع:    ${got}`)
  state.checkBlock = { intact, sent: state.sentDescription, returned: todo.description, at: new Date().toISOString() }
  saveState(state)
}

async function checkPut() {
  // Scenario 9: change only the due date, sending every field so nothing is cleared.
  const state = loadState()
  const before = await bc('GET', `/todos/${state.todoId}.json`)
  const newDue = before.due_on === '2026-12-02' ? '2026-12-03' : '2026-12-02'
  await bc('PUT', `/todos/${state.todoId}.json`, {
    content: before.content,
    description: before.description,
    assignee_ids: before.assignees.map((p) => p.id),
    completion_subscriber_ids: before.completion_subscribers.map((p) => p.id),
    due_on: newDue,
    starts_on: before.starts_on,
    notify: false,
  })
  const after = await bc('GET', `/todos/${state.todoId}.json`)
  const ids = (t) => JSON.stringify(t.assignees.map((p) => p.id).sort())
  const checks = {
    dueChanged: after.due_on === newDue,
    assigneesKept: ids(before) === ids(after),
    descriptionKept: normaliseHtml(before.description) === normaliseHtml(after.description),
    startsKept: before.starts_on === after.starts_on,
  }
  console.log(checks)
  state.checkPut = { ...checks, at: new Date().toISOString() }
  saveState(state)
}

function mark(label) {
  if (!label) throw new Error('اكتب وصف الخطوة: node live-test.mjs mark "<الخطوة>"')
  const state = loadState()
  const at = new Date().toISOString()
  state.markers.push({ label, at })
  saveState(state)
  console.log(`سُجّلت العلامة «${label}» عند ${at}. نفّذ الخطوة الآن في Basecamp.`)
}

async function events() {
  const state = loadState()
  const res = await fetch(`${env('RECORDER_URL').replace(/\/$/, '')}/events`, {
    headers: { Authorization: `Bearer ${env('READ_TOKEN')}` },
  })
  if (!res.ok) throw new Error(`المسجّل ردّ ${res.status}`)
  const deliveries = await res.json()
  const known = new Set(state.events.map((e) => e.id))
  for (const d of deliveries) {
    const e = summariseDelivery(d)
    if (!e || known.has(e.id) || e.bucketId !== state.projectId) continue
    state.events.push(e)
    known.add(e.id)
  }
  saveState(state)
  for (const e of state.events) console.log(`${e.createdAt}  ${e.kind}  ${e.recordingType}#${e.recordingId}`)
}

function report() {
  const state = loadState()
  const { markdown } = buildReport(state.markers, state.events)
  const extra = [
    '',
    `- سلامة الكتلة المُدارة: ${state.checkBlock ? (state.checkBlock.intact ? 'سليمة' : 'تغيّرت — انظر ملف الحالة') : 'لم يُفحص'}`,
    `- PUT بكل الحقول (السيناريو 9): ${state.checkPut ? JSON.stringify(state.checkPut) : 'لم يُفحص'}`,
    '',
    'عناصر أنشأها الاختبار (تُحذف يدوياً بعد الاعتماد):',
    ...state.created.map((c) => `- ${c.type} ${c.id}${c.url ? ` — ${c.url}` : ''}`),
  ]
  writeFileSync(REPORT_FILE, `# نتيجة الاختبار الحي لـ Basecamp\n\n${markdown}\n${extra.join('\n')}\n`)
  console.log(`كُتب ${REPORT_FILE}`)
}

const commands = { setup, 'check-block': checkBlock, 'check-put': checkPut, mark, events, report }

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...args] = process.argv.slice(2)
  const fn = commands[cmd]
  if (!fn) {
    console.log(`الأوامر: ${Object.keys(commands).join(' | ')}`)
    process.exit(1)
  }
  Promise.resolve(fn(...args)).catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
