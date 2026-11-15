// The workbook editor's Durable Object class, kept as a stub after the move to
// the station (docs/station-plan.md §8). Removing the class from wrangler.toml
// would need a `deleted_classes` migration, which deletes every room's stored
// data; that needs the owner's explicit decision, so the class stays, serves
// nothing, and its storage is left untouched.

import { DurableObject } from 'cloudflare:workers'
import type { Env } from './env'

export class WorkbookRoom extends DurableObject<Env> {
  override async fetch(): Promise<Response> {
    return new Response(JSON.stringify({ ok: false, error: 'gone', message: 'محرّر الجداول أُزيل من المنصة؛ الربط الآن بين ملفات Google Sheets وBasecamp مباشرة.' }), {
      status: 410,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }

  override async alarm(): Promise<void> {
    // A persist alarm left by the old room: nothing to do any more.
  }
}
