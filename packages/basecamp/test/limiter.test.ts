// Shared rate limiter (spec §9.2.9: a safe limit such as 4 requests/second,
// shared by every operation). Deterministic with a fake clock.

import { describe, expect, it } from 'vitest'
import { createBasecampClient } from '../src/client'
import { createTokenBucketLimiter } from '../src/limiter'
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
