// The platform-wide Basecamp rate limit (spec §9.2.9; owner decision 2026-11-10).
//
// Basecamp documents about 50 requests per 10 s per IP. The Worker runs in
// many isolates at once (queue consumers, the cron, request handlers), and a
// limiter held in one isolate cannot bound the others: two isolates each at
// 45 per 10 s would send 90. So every Basecamp request of the platform takes
// its slot from one Durable Object, `BasecampRateGate`, which keeps the
// window (`reserveSlot` of @naf-sheets/basecamp: at most 45 grants in any
// 10 s, bursts allowed) and hands out slots in order. The caller sleeps until
// its slot; the gate itself never waits.
//
// A 429 with Retry-After pauses the gate for everyone (`pause`).
//
// If the gate cannot be reached (a Durable Object outage), the isolate falls
// back to its own window limiter rather than failing the request; the
// platform-wide bound then holds per isolate only, as before this gate.
// The window lives in memory: the object is evicted only after it was idle,
// which (idle ≥ the 10 s window) leaves nothing to remember.
// OPEN: an eviction forced while requests flow (a deploy) starts an empty
// window; up to one extra burst is possible then (OPEN_QUESTIONS.md L6).

import { DurableObject } from 'cloudflare:workers'
import { BASECAMP_SAFE_LIMIT, createBasecampLimiter, defaultSleep, newWindowState, pauseWindow, reserveSlot } from '@naf-sheets/basecamp'
import type { RateLimiter } from '@naf-sheets/basecamp'

/** One gate for the whole platform: Basecamp's limit is per IP, and the Worker's IPs are not fixed. */
export const GATE_NAME = 'basecamp'

export class BasecampRateGate extends DurableObject {
  private readonly window = newWindowState()

  /** Milliseconds the caller waits before sending its request. */
  async reserve(): Promise<number> {
    const now = Date.now()
    return reserveSlot(this.window, now, BASECAMP_SAFE_LIMIT.requests, BASECAMP_SAFE_LIMIT.windowMs) - now
  }

  /** After a 429: nobody sends before `ms` from now, then requests are paced. */
  async pause(ms: number): Promise<void> {
    if (typeof ms !== 'number' || !(ms > 0) || !Number.isFinite(ms)) return
    pauseWindow(this.window, Date.now(), Math.min(ms, 3_600_000), BASECAMP_SAFE_LIMIT.requests, BASECAMP_SAFE_LIMIT.windowMs)
  }
}

export interface GateNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): { reserve(): Promise<number>; pause(ms: number): Promise<void> }
}

/**
 * A `RateLimiter` that takes every slot from the gate. Falls back to
 * `fallback` (the isolate's own window) when the gate does not answer.
 */
export function gateLimiter(namespace: GateNamespace, options: { sleep?: (ms: number) => Promise<void>; fallback?: RateLimiter } = {}): RateLimiter {
  const sleep = options.sleep ?? defaultSleep
  const fallback = options.fallback ?? createBasecampLimiter()
  const stub = () => namespace.get(namespace.idFromName(GATE_NAME))
  return {
    async acquire(): Promise<void> {
      let wait: number
      try {
        wait = await stub().reserve()
      } catch (error) {
        console.error(`basecamp rate gate unreachable (${error instanceof Error ? error.name : 'unknown'}); using the isolate's limiter`)
        return fallback.acquire()
      }
      if (wait > 0) await sleep(wait)
    },
    pauseFor(ms: number): void {
      fallback.pauseFor?.(ms)
      stub()
        .pause(ms)
        .catch(() => undefined)
    },
  }
}
