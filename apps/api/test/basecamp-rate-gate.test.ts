// The platform-wide Basecamp rate limit (spec §9.2.9): one Durable Object hands
// out every slot, 45 in any 10 s, so isolates together never exceed Basecamp's
// documented 50 per 10 s.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { gateLimiter } from '../src/basecamp-rate-gate'
import type { GateNamespace } from '../src/basecamp-rate-gate'

/** The real gate class, under a name of the test's own (the platform's gate stays untouched). */
function testGate(): GateNamespace {
  const ns = env.BASECAMP_RATE_GATE!
  const name = `test-${crypto.randomUUID()}`
  return { idFromName: () => ns.idFromName(name), get: (id) => ns.get(id) }
}

describe('BasecampRateGate', () => {
  it('two isolates drawing from one gate get 45 slots at once, then wait for the window — never 90', async () => {
    const gate = testGate()
    const waits: number[] = []
    const isolate = () => gateLimiter(gate, { sleep: async (ms) => void waits.push(ms) })
    const a = isolate()
    const b = isolate()
    for (let i = 0; i < 30; i++) {
      await a.acquire()
      await b.acquire()
    }
    // 60 requests asked; the 45 first go now, the 15 others wait about 10 s.
    expect(waits.length).toBe(15)
    for (const w of waits) {
      expect(w).toBeGreaterThan(9_000)
      expect(w).toBeLessThanOrEqual(10_000)
    }
  })

  it('a 429 pauses the gate for every isolate', async () => {
    const gate = testGate()
    const waits: number[] = []
    const a = gateLimiter(gate, { sleep: async (ms) => void waits.push(ms) })
    const b = gateLimiter(gate, { sleep: async (ms) => void waits.push(ms) })
    a.pauseFor?.(30_000)
    // pause is sent without waiting; a first reservation after it is held.
    await new Promise((r) => setTimeout(r, 20))
    await b.acquire()
    expect(waits[0]).toBeGreaterThan(29_000)
  })

  it('falls back to the isolate’s own limiter when the gate does not answer', async () => {
    let local = 0
    const broken: GateNamespace = {
      idFromName: () => ({}) as DurableObjectId,
      get: () => ({
        reserve: async () => {
          throw new Error('gate down')
        },
        pause: async () => {},
      }),
    }
    const limiter = gateLimiter(broken, { fallback: { acquire: async () => void local++ } })
    await limiter.acquire()
    await limiter.acquire()
    expect(local).toBe(2)
  })
})
