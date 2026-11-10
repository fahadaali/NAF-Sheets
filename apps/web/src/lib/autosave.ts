// Debounced snapshot autosave with optimistic concurrency.
//
// Every save sends `baseVersion` = the version this editor last loaded or
// saved. The API refuses a stale base with 409 `version_conflict` and writes
// nothing. A conflict is terminal here: no retry, no further save, nothing is
// ever overwritten silently: the user reloads. Realtime collaboration
// (spec §11, phase 6, decision §17-2) will replace whole-snapshot saving.
//
// Pure logic: the snapshot source, the transport and the clock are injected,
// so it is unit-tested without a browser or Univer.

export type SavePhase = 'saved' | 'pending' | 'saving' | 'error' | 'conflict'

export interface SaveStatus {
  phase: SavePhase
  /** Version of the last snapshot this editor loaded or saved. */
  version: number
  /** Arabic message for `error` and `conflict`. */
  message: string | null
}

export type SaveErrorKind = 'conflict' | 'retryable' | 'fatal'

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  now(): number
}

/** Global timers, looked up at call time (so fake timers in tests apply). */
export const systemClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
}

export interface AutosaveOptions {
  initialVersion: number
  /** Store `snapshot` on top of `baseVersion`; resolves with the new version. */
  save(baseVersion: number, snapshot: unknown): Promise<number>
  /** Read the current workbook state. Called synchronously when a save starts. */
  getSnapshot(): unknown
  classifyError(error: unknown): { kind: SaveErrorKind; message: string }
  onStatus?(status: SaveStatus): void
  /** Quiet time after the last change before saving. */
  debounceMs?: number
  /** Longest a change may wait while edits keep coming. */
  maxWaitMs?: number
  /** Delays between automatic retries of retryable failures; the last one repeats. */
  retryDelaysMs?: readonly number[]
  clock?: Clock
}

export const AUTOSAVE_DEFAULTS = {
  debounceMs: 1500,
  maxWaitMs: 10_000,
  retryDelaysMs: [2_000, 5_000, 15_000, 30_000],
} as const

export class Autosave {
  private readonly options: AutosaveOptions
  private readonly clock: Clock
  private readonly debounceMs: number
  private readonly maxWaitMs: number
  private readonly retryDelaysMs: readonly number[]

  private current: SaveStatus
  /** Changes exist that no successful save has carried yet. */
  private dirty = false
  /** When the oldest unsaved change happened (for `maxWaitMs`). */
  private firstDirtyAt: number | null = null
  private timer: unknown = null
  private inFlight: Promise<void> | null = null
  private retryIndex = 0
  private closed = false

  constructor(options: AutosaveOptions) {
    this.options = options
    this.clock = options.clock ?? systemClock
    this.debounceMs = options.debounceMs ?? AUTOSAVE_DEFAULTS.debounceMs
    this.maxWaitMs = options.maxWaitMs ?? AUTOSAVE_DEFAULTS.maxWaitMs
    this.retryDelaysMs = options.retryDelaysMs?.length ? options.retryDelaysMs : AUTOSAVE_DEFAULTS.retryDelaysMs
    this.current = { phase: 'saved', version: options.initialVersion, message: null }
  }

  get status(): SaveStatus {
    return this.current
  }

  /** True while something the user did is not stored yet. */
  get hasUnsavedChanges(): boolean {
    return this.dirty || this.inFlight !== null
  }

  /** Record a change; a save follows after the debounce. */
  markChanged(): void {
    if (this.closed || this.current.phase === 'conflict') return
    this.dirty = true
    const now = this.clock.now()
    if (this.firstDirtyAt === null) this.firstDirtyAt = now
    // A save in flight picks the change up when it finishes.
    if (this.inFlight) return
    this.retryIndex = 0
    const wait = Math.max(0, Math.min(this.debounceMs, this.firstDirtyAt + this.maxWaitMs - now))
    this.schedule(wait)
    // An error stays visible until the next attempt starts.
    if (this.current.phase !== 'error') this.setStatus({ phase: 'pending', message: null })
  }

  /** Save now (retry button). Waits for a save already in flight first. */
  async saveNow(): Promise<void> {
    if (this.closed || this.current.phase === 'conflict') return
    this.clearTimer()
    if (this.inFlight) await this.inFlight
    await this.run()
  }

  /**
   * Stop autosaving and store what is unsaved. The snapshot is read
   * synchronously, so the caller may tear the editor down right after calling.
   */
  async finalize(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.clearTimer()
    if (!this.dirty || this.current.phase === 'conflict') {
      if (this.inFlight) await this.inFlight
      return
    }
    let snapshot: unknown
    try {
      snapshot = this.takeSnapshot()
    } catch {
      return
    }
    if (this.inFlight) await this.inFlight
    // `takeSnapshot` cleared `dirty`; a failed in-flight save sets it again,
    // and the snapshot taken above already contains that save's changes.
    if (this.inConflict()) return
    await this.send(snapshot)
  }

  private async run(): Promise<void> {
    if (this.inFlight || !this.dirty || this.current.phase === 'conflict') return
    let snapshot: unknown
    try {
      snapshot = this.takeSnapshot()
    } catch (error) {
      this.dirty = true
      this.setStatus({ phase: 'error', message: this.options.classifyError(error).message })
      return
    }
    await this.send(snapshot)
    // Changes made while that save was in flight.
    if (!this.closed && this.dirty && this.current.phase === 'pending' && this.timer === null) this.schedule(this.debounceMs)
  }

  /** Read through a method: the phase changes across awaits. */
  private inConflict(): boolean {
    return this.current.phase === 'conflict'
  }

  private takeSnapshot(): unknown {
    const snapshot = this.options.getSnapshot()
    this.dirty = false
    this.firstDirtyAt = null
    return snapshot
  }

  private async send(snapshot: unknown): Promise<void> {
    this.clearTimer()
    this.setStatus({ phase: 'saving', message: null })
    const flight = (async () => {
      try {
        const version = await this.options.save(this.current.version, snapshot)
        this.retryIndex = 0
        this.setStatus({ phase: this.dirty ? 'pending' : 'saved', version, message: null })
      } catch (error) {
        // Nothing was stored: the changes in that snapshot are still unsaved.
        this.dirty = true
        if (this.firstDirtyAt === null) this.firstDirtyAt = this.clock.now()
        const { kind, message } = this.options.classifyError(error)
        if (kind === 'conflict') {
          this.clearTimer()
          this.setStatus({ phase: 'conflict', message })
          return
        }
        this.setStatus({ phase: 'error', message })
        if (kind === 'retryable' && !this.closed) {
          const delay = this.retryDelaysMs[Math.min(this.retryIndex, this.retryDelaysMs.length - 1)] ?? this.debounceMs
          this.retryIndex++
          this.schedule(delay)
        }
      }
    })()
    this.inFlight = flight
    try {
      await flight
    } finally {
      this.inFlight = null
    }
  }

  private schedule(ms: number): void {
    this.clearTimer()
    this.timer = this.clock.setTimeout(() => {
      this.timer = null
      void this.run()
    }, ms)
  }

  private clearTimer(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
  }

  private setStatus(patch: Partial<SaveStatus>): void {
    this.current = { ...this.current, ...patch }
    this.options.onStatus?.(this.current)
  }
}
