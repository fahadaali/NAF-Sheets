// The platform's appearance «المظهر» (apps/api OPEN_QUESTIONS.md D8): palette
// overrides of apps/web/src/styles/theme.css, stored in KV settings.
//   GET /api/appearance         everyone signed in
//   PUT /api/admin/appearance   platform admins

import { Hono } from 'hono'
import type { AppearanceResponse } from '@naf-sheets/shared'
import { normalizePalette } from '@naf-sheets/shared'
import { auditStatement } from '../audit'
import type { AppEnv } from '../auth'
import { callerOf, isPlainObject, nowIso, readJson } from '../request'
import { readAppearance, writeAppearance } from './store'

const ADMIN_ONLY = 'تعديل مظهر المنصة مقصور على مسؤول المنصة. اطلب التغيير من مسؤول المنصة.'
const INVALID_PALETTE = 'ألوان المظهر غير صالحة، فلم يُحفظ شيء: كل لون بصيغة #RRGGBB (ستة أرقام ست عشرية)، ولأسماء الألوان المعروفة فقط. صحّح القيم ثم احفظ.'

export function appearanceRoutes(): { read: Hono<AppEnv>; admin: Hono<AppEnv> } {
  const read = new Hono<AppEnv>()
  read.get('/', async (c) => {
    callerOf(c)
    return c.json<AppearanceResponse>(await readAppearance(c.env.SETTINGS))
  })

  const admin = new Hono<AppEnv>()
  admin.put('/', async (c) => {
    const caller = callerOf(c)
    if (caller.role !== 'admin') return c.json({ ok: false, error: 'forbidden', message: ADMIN_ONLY }, 403)
    const body = await readJson(c)
    const palette = isPlainObject(body) ? normalizePalette(body.palette) : null
    if (!palette) return c.json({ ok: false, error: 'invalid_palette', message: INVALID_PALETTE }, 400)
    const at = nowIso()
    const saved = await writeAppearance(c.env.SETTINGS, palette, caller.id, at)
    await auditStatement(c.env.DB, { actorId: caller.id, action: 'settings.appearance', entityType: 'settings', entityId: 'appearance', workbookId: null, details: { palette } }, at).run()
    return c.json<AppearanceResponse>(saved)
  })
  return { read, admin }
}
