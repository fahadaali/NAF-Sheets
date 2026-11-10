import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Autosave } from '../../src/lib/autosave'
import type { AutosaveOptions, SaveErrorKind, SaveStatus } from '../../src/lib/autosave'

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`http ${status}`)
  }
}

const classify = (error: unknown): { kind: SaveErrorKind; message: string } => {
  const status = error instanceof HttpError ? error.status : -1
  if (status === 409) return { kind: 'conflict', message: 'تعارض' }
  if (status === 0 || status >= 500) return { kind: 'retryable', message: 'تعذّر الاتصال' }
  return { kind: 'fatal', message: 'مرفوض' }
}

/** A server that stores snapshots with optimistic concurrency, like PUT /api/workbooks/:id/snapshot. */
function setup(options: Partial<AutosaveOptions> & { serverVersion?: number } = {}) {
  let serverVersion = options.serverVersion ?? 7
  let content = 0
  const saves: Array<{ baseVersion: number; snapshot: unknown }> = []
  const statuses: SaveStatus[] = []
  let failNext: number[] = []
  let gate: Promise<void> | null = null

  const autosave = new Autosave({
    initialVersion: 7,
    getSnapshot: () => ({ content }),
    save: async (baseVersion, snapshot) => {
      saves.push({ baseVersion, snapshot })
      if (gate) await gate
      const status = failNext.shift()
      if (status !== undefined) throw new HttpError(status)
      if (baseVersion !== serverVersion) throw new HttpError(409)
      serverVersion += 1
      return serverVersion
    },
    classifyError: classify,
    onStatus: (s) => statuses.push(s),
    debounceMs: 1000,
    maxWaitMs: 5000,
    retryDelaysMs: [2000, 4000],
    ...options,
  })

  return {
    autosave,
    saves,
    statuses,
    edit: () => {
      content += 1
      autosave.markChanged()
    },
    failNextWith: (...codes: number[]) => {
      failNext = codes
    },
    hold: () => {
      let release!: () => void
      gate = new Promise<void>((r) => (release = r))
      return () => {
        gate = null
        release()
      }
    },
    setServerVersion: (v: number) => {
      serverVersion = v
    },
    get serverVersion() {
      return serverVersion
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('Autosave — debounce and versioning', () => {
  it('coalesces a burst of edits into one save after the quiet period', async () => {
    const s = setup()
    s.edit()
    await vi.advanceTimersByTimeAsync(500)
    s.edit()
    await vi.advanceTimersByTimeAsync(500)
    s.edit()
    expect(s.saves).toHaveLength(0)
    expect(s.autosave.status.phase).toBe('pending')
    await vi.advanceTimersByTimeAsync(999)
    expect(s.saves).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(s.saves).toEqual([{ baseVersion: 7, snapshot: { content: 3 } }])
    expect(s.autosave.status).toEqual({ phase: 'saved', version: 8, message: null })
    expect(s.autosave.hasUnsavedChanges).toBe(false)
  })

  it('sends the version returned by the previous save as the next baseVersion', async () => {
    const s = setup()
    s.edit()
    await vi.advanceTimersByTimeAsync(1000)
    s.edit()
    await vi.advanceTimersByTimeAsync(1000)
    s.edit()
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.saves.map((x) => x.baseVersion)).toEqual([7, 8, 9])
    expect(s.autosave.status.version).toBe(10)
  })

  it('does not wait longer than maxWaitMs while edits keep coming', async () => {
    const s = setup()
    for (let elapsed = 0; elapsed < 5000; elapsed += 500) {
      s.edit()
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(s.saves).toHaveLength(1)
    expect(s.saves[0]?.snapshot).toEqual({ content: 10 })
  })

  it('does nothing without a change', async () => {
    const s = setup()
    await vi.advanceTimersByTimeAsync(60_000)
    await s.autosave.saveNow()
    expect(s.saves).toHaveLength(0)
    expect(s.statuses).toHaveLength(0)
  })

  it('saves edits made during a save afterwards, on top of the new version', async () => {
    const s = setup()
    const release = s.hold()
    s.edit()
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.autosave.status.phase).toBe('saving')
    s.edit() // while the first PUT is in flight
    expect(s.saves).toHaveLength(1)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.autosave.status.phase).toBe('pending')
    expect(s.autosave.hasUnsavedChanges).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.saves).toEqual([
      { baseVersion: 7, snapshot: { content: 1 } },
      { baseVersion: 8, snapshot: { content: 2 } },
    ])
    expect(s.autosave.status).toMatchObject({ phase: 'saved', version: 9 })
  })
})

describe('Autosave — conflicts are never overwritten', () => {
  it('stops for good on 409: no retry, no further save, editor told why', async () => {
    const s = setup()
    s.setServerVersion(12) // someone else saved meanwhile
    s.edit()
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.saves).toEqual([{ baseVersion: 7, snapshot: { content: 1 } }])
    expect(s.autosave.status).toEqual({ phase: 'conflict', version: 7, message: 'تعارض' })
    expect(s.autosave.hasUnsavedChanges).toBe(true)

    s.edit()
    await vi.advanceTimersByTimeAsync(60_000)
    await s.autosave.saveNow()
    await s.autosave.finalize()
    expect(s.saves).toHaveLength(1)
    expect(s.serverVersion).toBe(12)
  })
})

describe('Autosave — failures', () => {
  it('retries transient failures with backoff, keeping the same baseVersion', async () => {
    const s = setup()
    s.failNextWith(503, 0)
    s.edit()
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.autosave.status).toMatchObject({ phase: 'error', message: 'تعذّر الاتصال' })
    await vi.advanceTimersByTimeAsync(1999)
    expect(s.saves).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(s.saves).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(4000)
    expect(s.saves.map((x) => x.baseVersion)).toEqual([7, 7, 7])
    expect(s.autosave.status).toMatchObject({ phase: 'saved', version: 8 })
  })

  it('waits for the user after a non-retryable failure, then saves on retry', async () => {
    const s = setup()
    s.failNextWith(403)
    s.edit()
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.autosave.status).toMatchObject({ phase: 'error', message: 'مرفوض' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(s.saves).toHaveLength(1)
    expect(s.autosave.hasUnsavedChanges).toBe(true)
    await s.autosave.saveNow()
    expect(s.saves).toHaveLength(2)
    expect(s.autosave.status).toMatchObject({ phase: 'saved', version: 8 })
  })

  it('keeps an error visible while a new change waits, then clears it on success', async () => {
    const s = setup()
    s.failNextWith(400)
    s.edit()
    await vi.advanceTimersByTimeAsync(1000)
    s.edit()
    expect(s.autosave.status.phase).toBe('error')
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.autosave.status).toMatchObject({ phase: 'saved', message: null })
    expect(s.saves.at(-1)).toEqual({ baseVersion: 7, snapshot: { content: 2 } })
  })
})

describe('Autosave — finalize (leaving the editor)', () => {
  it('saves pending changes at once and reads the snapshot synchronously', async () => {
    const s = setup()
    s.edit()
    const done = s.autosave.finalize()
    // The editor may be torn down right now: the snapshot is already taken.
    expect(s.saves).toEqual([{ baseVersion: 7, snapshot: { content: 1 } }])
    await done
    expect(s.autosave.status).toMatchObject({ phase: 'saved', version: 8 })
    s.edit()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(s.saves).toHaveLength(1)
  })

  it('queues the final snapshot behind a save in flight', async () => {
    const s = setup()
    const release = s.hold()
    s.edit()
    await vi.advanceTimersByTimeAsync(1000)
    s.edit()
    const done = s.autosave.finalize()
    release()
    await done
    expect(s.saves).toEqual([
      { baseVersion: 7, snapshot: { content: 1 } },
      { baseVersion: 8, snapshot: { content: 2 } },
    ])
  })

  it('does nothing when everything is saved', async () => {
    const s = setup()
    await s.autosave.finalize()
    expect(s.saves).toHaveLength(0)
  })
})
