// Tests for the Phase 0 Basecamp kit. No network: Basecamp and the recorder
// are replaced by a local HTTP server that implements only what the kit calls,
// with the semantics the official docs state (PUT /todos clears omitted fields).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { buildReport, managedBlockHtml, normaliseHtml, summariseDelivery } from '../live-test.mjs'
import recorder from '../recorder/src/index.js'

const run = promisify(execFile)
const SCRIPT = new URL('../live-test.mjs', import.meta.url).pathname

function memoryKv() {
  const m = new Map()
  return {
    put: async (k, v) => void m.set(k, v),
    get: async (k) => m.get(k) ?? null,
    list: async ({ prefix }) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
  }
}

test('managed block escapes text and carries the fixed title', () => {
  const html = managedBlockHtml(['مسؤول <خارجي> & شركة'])
  assert.match(html, /^<hr><div><strong>بيانات من منصة الاتصال المؤسسي<\/strong><br>/)
  assert.ok(html.includes('مسؤول &lt;خارجي&gt; &amp; شركة'))
})

test('normaliseHtml ignores reflowed whitespace only', () => {
  assert.equal(normaliseHtml('<div>\n  أ\n</div>\n<hr>'), normaliseHtml('<div> أ </div><hr>'))
  assert.notEqual(normaliseHtml('<div>أ</div>'), normaliseHtml('<p>أ</p>'))
})

test('summariseDelivery tolerates malformed bodies', () => {
  assert.equal(summariseDelivery({ raw: 'not json', receivedAt: 'x' }), null)
  const e = summariseDelivery({ receivedAt: 'r', raw: JSON.stringify({ id: 1, kind: 'todo_created', created_at: 'c', recording: { type: 'Todo', id: 9, bucket: { id: 5 } } }) })
  assert.deepEqual([e.kind, e.recordingType, e.bucketId, e.createdAt], ['todo_created', 'Todo', 5, 'c'])
})

test('buildReport attributes events to the preceding marker and flags silence', () => {
  const markers = [
    { label: 'تغيير تاريخ المهمة', at: '2026-11-09T10:00:00Z' },
    { label: 'إنجاز الفرعية', at: '2026-11-09T10:05:00Z' },
  ]
  const events = [
    { kind: 'todo_content_updated', recordingType: 'Todo', createdAt: '2026-11-09T10:01:00Z' },
    { kind: 'todo_content_updated', recordingType: 'Todo', createdAt: '2026-11-09T10:02:00Z' },
  ]
  const { rows, markdown } = buildReport(markers, events)
  assert.deepEqual(rows[0].kinds, ['todo_content_updated (Todo)'])
  assert.deepEqual(rows[1].kinds, [])
  assert.match(markdown, /لم يصل شيء/)
})

test('recorder stores deliveries only on the right secret and serves them with the read token', async () => {
  const env = { RECORDER_SECRET: 's3cret', READ_TOKEN: 'rt', EVENTS: memoryKv() }
  const post = (secret) => recorder.fetch(new Request(`https://r.example/webhooks/basecamp/${secret}`, { method: 'POST', body: '{"id":1}' }), env)
  assert.equal((await post('wrong')).status, 404)
  assert.equal((await post('s3cret')).status, 200)
  assert.equal((await recorder.fetch(new Request('https://r.example/events'), env)).status, 401)
  const res = await recorder.fetch(new Request('https://r.example/events', { headers: { Authorization: 'Bearer rt' } }), env)
  const events = await res.json()
  assert.equal(events.length, 1)
  assert.equal(events[0].raw, '{"id":1}')
})

// ---------- end-to-end against a mock Basecamp ----------

function mockBasecamp() {
  const seen = []
  const todos = new Map()
  let nextId = 100
  const recorderEnv = { RECORDER_SECRET: 'sec', READ_TOKEN: 'rt', EVENTS: memoryKv() }
  const people = { 7: { id: 7, name: 'أ' } }

  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    const body = raw ? JSON.parse(raw) : null
    seen.push({ method: req.method, url: req.url, ua: req.headers['user-agent'], ct: req.headers['content-type'] })
    const send = (status, json) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(json === undefined ? '' : JSON.stringify(json))
    }

    // Recorder routes, served by the real recorder handler.
    if (req.url.startsWith('/webhooks/') || req.url.startsWith('/events')) {
      const r = await recorder.fetch(new Request(`http://x${req.url}`, { method: req.method, headers: req.headers, body: raw || undefined }), recorderEnv)
      res.writeHead(r.status, { 'content-type': 'application/json' })
      return res.end(await r.text())
    }

    if (req.headers['user-agent'] !== 'NAF Comms (info@naflaw.sa)') return send(400, { error: 'user agent' })
    if (body && !String(req.headers['content-type']).startsWith('application/json')) return send(415, {})

    const path = req.url.replace(/^\/999/, '')
    let m
    if (req.method === 'GET' && path === '/projects/1.json') return send(200, { id: 1, dock: [{ name: 'todoset', id: 50, enabled: true }] })
    if (req.method === 'POST' && path === '/todosets/50/todolists.json') return send(201, { id: nextId++, app_url: 'https://bc/list' })
    if (req.method === 'POST' && path === '/buckets/1/webhooks.json') return send(201, { id: nextId++ })
    if (req.method === 'POST' && (m = path.match(/^\/todolists\/\d+\/todos\.json$/))) {
      const id = nextId++
      // Basecamp keeps allowed tags but the mock reflows whitespace, as a sanitiser might.
      todos.set(id, {
        id, content: body.content, description: body.description.replace('<hr>', '<hr>\n'), due_on: body.due_on, starts_on: body.starts_on,
        assignees: (body.assignee_ids ?? []).map((p) => people[p]), completion_subscribers: [], app_url: 'https://bc/todo',
      })
      return send(201, todos.get(id))
    }
    if (req.method === 'POST' && path.match(/^\/recordings\/\d+\/subtasks\.json$/)) return send(201, { id: nextId++, title: body.title })
    if ((m = path.match(/^\/todos\/(\d+)\.json$/))) {
      const t = todos.get(Number(m[1]))
      if (req.method === 'GET') return send(200, t)
      if (req.method === 'PUT') {
        // Documented semantics: omitted fields are cleared.
        Object.assign(t, {
          content: body.content, description: body.description ?? '', due_on: body.due_on ?? null, starts_on: body.starts_on ?? null,
          assignees: (body.assignee_ids ?? []).map((p) => people[p]),
        })
        return send(200, t)
      }
    }
    send(404, { error: `unmocked ${req.method} ${path}` })
  })
  return { server, seen }
}

test('live-test.mjs end to end against a mock Basecamp: setup, checks, mark, events, report', async () => {
  const { server, seen } = mockBasecamp()
  await new Promise((r) => server.listen(0, r))
  const base = `http://127.0.0.1:${server.address().port}`
  const dir = mkdtempSync(join(tmpdir(), 'bc-live-'))
  const envVars = {
    ...process.env,
    BC_API_BASE: base, BC_TOKEN: 't', BC_ACCOUNT_ID: '999', BC_PROJECT_ID: '1', BC_ASSIGNEE_ID: '7',
    RECORDER_URL: base, RECORDER_SECRET: 'sec', READ_TOKEN: 'rt',
    STATE_FILE: join(dir, 'state.json'), REPORT_FILE: join(dir, 'report.md'),
  }
  const cli = (...args) => run(process.execPath, [SCRIPT, ...args], { env: envVars })
  try {
    await cli('setup')
    await assert.rejects(cli('setup'), /الإعداد تمّ سابقاً/, 'second setup must refuse instead of creating duplicates')

    const block = await cli('check-block')
    assert.match(block.stdout, /سليمة/)

    const put = await cli('check-put')
    assert.match(put.stdout, /assigneesKept: true/)
    assert.match(put.stdout, /descriptionKept: true/)

    await cli('mark', 'تغيير تاريخ المهمة')
    // Simulate Basecamp delivering one event for the project and one for another project.
    const state = JSON.parse(readFileSync(envVars.STATE_FILE, 'utf8'))
    const deliver = (bucket, kind) => fetch(`${base}/webhooks/basecamp/sec`, {
      method: 'POST',
      body: JSON.stringify({ id: Math.random(), kind, created_at: new Date().toISOString(), recording: { type: 'Todo', id: state.todoId, bucket: { id: bucket } } }),
    })
    await deliver(1, 'todo_content_updated')
    await deliver(2, 'todo_created')
    await cli('events')
    await cli('report')

    const report = readFileSync(envVars.REPORT_FILE, 'utf8')
    assert.match(report, /تغيير تاريخ المهمة/)
    assert.match(report, /todo_content_updated \(Todo\)/)
    assert.doesNotMatch(report, /todo_created/, 'events from other projects must be ignored')

    assert.ok(seen.filter((s) => !s.url.startsWith('/webhooks') && !s.url.startsWith('/events')).every((s) => s.ua === 'NAF Comms (info@naflaw.sa)'))
    assert.ok(!seen.some((s) => s.method === 'DELETE'), 'the kit must never delete anything')
  } finally {
    server.close()
  }
})
