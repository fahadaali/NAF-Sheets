// Shared rate limiter (spec §9.2.9). Production: 45 requests in any 10 s
// (owner decision 2026-11-10); the flat token bucket is kept and tested too.
// Deterministic with a fake clock.

import { describe, expect, it } from 'vitest'
import { createBasecampClient } from '../src/client'
import { BASECAMP_DOCUMENTED_LIMIT, createBasecampLimiter, createTokenBucketLimiter, createWindowLimiter, newWindowState, pauseWindow, reserveSlot } from '../src/limiter'
import { ACCOUNT, fakeClock, fakeFetch, rawTodo, reply, TOKEN } from './helpers'

async function grantTimes(limiter: { acquire(): Promise<void> }, clock: { now(): number }, n: number, start: number): Promise<number[]> {
  const times: number[] = []
  await Promise.all(
    Array.from({ length: n }, async () => {
      await limiter.acquire()
      times.push(clock.now() - start)
    }),
  )
  return times
}

describe('token bucket', () => {
  it('defaults to 4 per second: a burst of 4, then one every 250 ms', async () => {
    const clock = fakeClock()
    const limiter = createTokenBucketLimiter({ now: clock.now, sleep: clock.sleep })
    expect(await grantTimes(limiter, clock, 10, clock.now())).toEqual([0, 0, 0, 0, 250, 500, 750, 1000, 1250, 1500])
  })

  it('never exceeds the Basecamp limit of 50 per 10 s, even when hammered', async () => {
    const clock = fakeClock()
    const limiter = createTokenBucketLimiter({ now: clock.now, sleep: clock.sleep })
    const times = await grantTimes(limiter, clock, 200, clock.now())
    for (const t of times) {
      const inWindow = times.filter((u) => u >= t && u < t + 10_000).length
      expect(inWindow).toBeLessThanOrEqual(50)
    }
  })

  it('spaces evenly with capacity 1', async () => {
    const clock = fakeClock()
    const limiter = createTokenBucketLimiter({ ratePerSecond: 4, capacity: 1, now: clock.now, sleep: clock.sleep })
    expect(await grantTimes(limiter, clock, 5, clock.now())).toEqual([0, 250, 500, 750, 1000])
  })

  it('refills while idle, up to the capacity only', async () => {
    const clock = fakeClock()
    const limiter = createTokenBucketLimiter({ now: clock.now, sleep: clock.sleep })
    await grantTimes(limiter, clock, 4, clock.now())
    clock.t += 60_000
    const start = clock.now()
    expect(await grantTimes(limiter, clock, 6, start)).toEqual([0, 0, 0, 0, 250, 500])
  })

  it('serves callers in order', async () => {
    const clock = fakeClock()
    const limiter = createTokenBucketLimiter({ ratePerSecond: 2, capacity: 1, now: clock.now, sleep: clock.sleep })
    const order: number[] = []
    await Promise.all([1, 2, 3, 4].map(async (n) => {
      await limiter.acquire()
      order.push(n)
    }))
    expect(order).toEqual([1, 2, 3, 4])
  })

  it('pauseFor holds every caller, then restarts with an empty bucket', async () => {
    const clock = fakeClock()
    const limiter = createTokenBucketLimiter({ now: clock.now, sleep: clock.sleep })
    const start = clock.now()
    limiter.pauseFor?.(3000)
    expect(await grantTimes(limiter, clock, 3, start)).toEqual([3250, 3500, 3750])
  })

  it('validates its options', () => {
    expect(() => createTokenBucketLimiter({ ratePerSecond: 0 })).toThrow(TypeError)
    expect(() => createTokenBucketLimiter({ ratePerSecond: Number.POSITIVE_INFINITY })).toThrow(TypeError)
    expect(() => createTokenBucketLimiter({ capacity: 0.5 })).toThrow(TypeError)
  })

  it('one limiter shared by two clients (two users\' tokens) paces their combined traffic', async () => {
    const clock = fakeClock()
    const limiter = createTokenBucketLimiter({ now: clock.now, sleep: clock.sleep })
    const sentAt: number[] = []
    const make = () => {
      const { fetch } = fakeFetch(() => {
        sentAt.push(clock.now())
        return reply(200, rawTodo(1))
      })
      return createBasecampClient({ accountId: ACCOUNT, fetch, limiter, sleep: clock.sleep, now: clock.now })
    }
    const a = make()
    const b = make()
    const start = clock.now()
    await Promise.all([1, 2, 3].flatMap(() => [a.todos.get(TOKEN, 1), b.todos.get('other-user-token', 1)]))
    expect(sentAt.map((t) => t - start)).toEqual([0, 0, 0, 0, 250, 500])
  })

  it('a 429 pauses the shared limiter for everyone', async () => {
    const clock = fakeClock()
    const limiter = createTokenBucketLimiter({ now: clock.now, sleep: clock.sleep })
    const sentAt: number[] = []
    const { fetch } = fakeFetch((_call, i) => {
      sentAt.push(clock.now())
      return i === 0 ? reply(429, undefined, { 'Retry-After': '2' }) : reply(200, rawTodo(1))
    })
    const client = createBasecampClient({ accountId: ACCOUNT, fetch, limiter, sleep: clock.sleep, now: clock.now })
    const start = clock.now()
    await client.todos.get(TOKEN, 1)
    // Retry after Retry-After, then the restarted (empty) bucket's first token.
    expect(sentAt.map((t) => t - start)).toEqual([0, 2250])
  })
})

/** The most grants in any half-open window of `windowMs`. */
function busiestWindow(times: number[], windowMs: number): number {
  let most = 0
  for (const t of times) most = Math.max(most, times.filter((u) => u >= t && u < t + windowMs).length)
  return most
}

describe('window limiter (production: 45 in any 10 s)', () => {
  it('lets a burst of 45 go at once, then waits for the window', async () => {
    const clock = fakeClock()
    const limiter = createBasecampLimiter({ now: clock.now, sleep: clock.sleep })
    const times = await grantTimes(limiter, clock, 47, clock.now())
    expect(times.slice(0, 45)).toEqual(Array(45).fill(0))
    expect(times.slice(45)).toEqual([10_000, 10_000])
  })

  it('never exceeds the documented 50 per 10 s — nor its own 45 — whatever the arrival pattern', async () => {
    for (const pattern of ['hammer', 'trickle', 'bursts'] as const) {
      const clock = fakeClock()
      const limiter = createBasecampLimiter({ now: clock.now, sleep: clock.sleep })
      const start = clock.now()
      const times: number[] = []
      for (let i = 0; i < 400; i++) {
        if (pattern === 'trickle') clock.t += 137
        if (pattern === 'bursts' && i % 60 === 0) clock.t += 7_300
        if (pattern === 'hammer') {
          times.push(...(await grantTimes(limiter, clock, 1, start)))
          continue
        }
        await limiter.acquire()
        times.push(clock.now() - start)
      }
      expect(busiestWindow(times, BASECAMP_DOCUMENTED_LIMIT.windowMs)).toBeLessThanOrEqual(45)
      expect(busiestWindow(times, BASECAMP_DOCUMENTED_LIMIT.windowMs)).toBeLessThan(BASECAMP_DOCUMENTED_LIMIT.requests)
    }
  })

  it('sustains 4.5 requests a second over a long run (the flat bucket gave 4)', async () => {
    const clock = fakeClock()
    const limiter = createBasecampLimiter({ now: clock.now, sleep: clock.sleep })
    const times = await grantTimes(limiter, clock, 450, clock.now())
    // 45 at 0, 45 at 10 s, … the 450th at 90 s: 450 requests in 90 s plus the first burst.
    expect(times[449]).toBe(90_000)
  })

  it('serves callers in order', async () => {
    const clock = fakeClock()
    const limiter = createWindowLimiter({ requests: 2, windowMs: 1000, now: clock.now, sleep: clock.sleep })
    const order: number[] = []
    await Promise.all([1, 2, 3, 4, 5].map(async (n) => {
      await limiter.acquire()
      order.push(n)
    }))
    expect(order).toEqual([1, 2, 3, 4, 5])
  })

  it('after a 429 pause, holds everyone, then paces the next requests instead of bursting', async () => {
    const clock = fakeClock()
    const limiter = createWindowLimiter({ requests: 10, windowMs: 10_000, now: clock.now, sleep: clock.sleep })
    const start = clock.now()
    limiter.pauseFor?.(3000)
    const times = await grantTimes(limiter, clock, 4, start)
    expect(times).toEqual([3000, 4000, 5000, 6000])
    expect(busiestWindow(times, 10_000)).toBeLessThanOrEqual(10)
  })

  it('a pause never loosens the window: grants already made still count', async () => {
    const clock = fakeClock()
    const limiter = createWindowLimiter({ requests: 5, windowMs: 10_000, now: clock.now, sleep: clock.sleep })
    const start = clock.now()
    const first = await grantTimes(limiter, clock, 5, start)
    limiter.pauseFor?.(1000)
    const after = await grantTimes(limiter, clock, 5, start)
    expect(busiestWindow([...first, ...after], 10_000)).toBeLessThanOrEqual(5)
    expect(after[0]).toBeGreaterThanOrEqual(10_000)
  })

  it('a 429 with Retry-After through the client pauses the shared window limiter', async () => {
    const clock = fakeClock()
    const limiter = createBasecampLimiter({ now: clock.now, sleep: clock.sleep })
    const sentAt: number[] = []
    const { fetch } = fakeFetch((_call, i) => {
      sentAt.push(clock.now())
      return i === 0 ? reply(429, undefined, { 'Retry-After': '2' }) : reply(200, rawTodo(1))
    })
    const client = createBasecampClient({ accountId: ACCOUNT, fetch, limiter, sleep: clock.sleep, now: clock.now })
    const start = clock.now()
    await client.todos.get(TOKEN, 1)
    await client.todos.get(TOKEN, 1)
    // Retry-After honoured (no request before 2 s), then paced one every 10 s / 45
    // (the request already sent at 0 still counts, so the first slot after the pause is skipped).
    const gap = Math.ceil(10_000 / 45)
    expect(sentAt.map((t) => t - start)).toEqual([0, 2000 + gap, 2000 + Math.ceil((2 * 10_000) / 45)])
  })

  it('validates its options', () => {
    expect(() => createWindowLimiter({ requests: 0 })).toThrow(TypeError)
    expect(() => createWindowLimiter({ requests: 1.5 })).toThrow(TypeError)
    expect(() => createWindowLimiter({ windowMs: 0 })).toThrow(TypeError)
  })
})

describe('reserveSlot (the shared gate’s bookkeeping)', () => {
  it('hands out future slots in order: callers from many isolates asking at once never exceed 45 in any 10 s', () => {
    const state = newWindowState()
    const slots: number[] = []
    // 300 requests from "isolates" arriving at random moments over 20 s.
    let t = 0
    for (let i = 0; i < 300; i++) {
      t += (i * 7919) % 97
      slots.push(reserveSlot(state, t, 45, 10_000))
    }
    for (let i = 1; i < slots.length; i++) expect(slots[i]).toBeGreaterThanOrEqual(slots[i - 1]!)
    expect(busiestWindow(slots, 10_000)).toBeLessThanOrEqual(45)
    for (let i = 0; i < slots.length; i++) expect(slots[i]).toBeGreaterThanOrEqual(0)
  })

  it('a pause holds every later slot and keeps the window', () => {
    const state = newWindowState()
    expect(reserveSlot(state, 0, 3, 1000)).toBe(0)
    pauseWindow(state, 0, 5000, 3, 1000)
    const after = [reserveSlot(state, 1, 3, 1000), reserveSlot(state, 1, 3, 1000), reserveSlot(state, 1, 3, 1000)]
    expect(after[0]).toBeGreaterThanOrEqual(5000)
    expect(busiestWindow([0, ...after], 1000)).toBeLessThanOrEqual(3)
  })
})
