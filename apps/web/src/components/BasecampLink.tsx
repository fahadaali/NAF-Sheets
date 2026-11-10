// The caller's own Basecamp account link (spec §3: every edit appears in
// Basecamp under its author; «اربط حسابك في Basecamp»). The link is made by a
// page navigation to /auth/basecamp/start (Launchpad), never by fetch.

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Ban, CircleCheck, Clock, LoaderCircle, Unlink } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { BasecampLinkResponse, BasecampLinkState } from '@naf-sheets/shared'
import { api, basecampStartUrl, currentPath, errorMessage, isAbortError } from '../lib/api'
import { Notice } from './Notice'
import { t } from '../strings'

export type LinkLoad = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; link: BasecampLinkResponse }

/** Only exactly `active` counts as linked; anything else (unknown states included) does not. */
export const isLinkActive = (load: LinkLoad): boolean => load.kind === 'ready' && load.link.state === 'active'

/** GET /api/basecamp/link. `enabled: false` leaves it loading without a request. */
export function useBasecampLink(enabled = true): { load: LinkLoad; reload: () => void; replace: (link: BasecampLinkResponse) => void } {
  const [load, setLoad] = useState<LinkLoad>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    setLoad({ kind: 'loading' })
    api.getBasecampLink(controller.signal).then(
      (link) => setLoad({ kind: 'ready', link }),
      (error: unknown) => {
        if (!isAbortError(error)) setLoad({ kind: 'error', message: errorMessage(error) })
      },
    )
    return () => controller.abort()
  }, [enabled, attempt])
  const reload = useCallback(() => setAttempt((n) => n + 1), [])
  const replace = useCallback((link: BasecampLinkResponse) => setLoad({ kind: 'ready', link }), [])
  return { load, reload, replace }
}

type InactiveState = Exclude<BasecampLinkState, 'active'>
const explain = (state: BasecampLinkState): string => t.basecamp.explain[(state === 'active' ? 'unlinked' : state) as InactiveState] ?? t.basecamp.explain.unlinked

/** «ربط الحساب» / «إعادة الربط»: a plain link to the OAuth start, coming back to this page. */
export function LinkAccountButton({ state, primary = true }: { state: BasecampLinkState; primary?: boolean }) {
  return (
    <a className={primary ? 'button button--primary button--small' : 'button button--small'} href={basecampStartUrl(currentPath())} data-testid="basecamp-link-start">
      {state === 'unlinked' ? t.basecamp.link : t.basecamp.relink}
    </a>
  )
}

/**
 * «اربط حسابك في Basecamp» when the link is not active. Loading shows
 * nothing; a failed check shows an error with retry only when `showErrors`.
 * OPEN: not dismissible; on the files screen it shows to every non-viewer and
 * a failed check stays silent there (OPEN_QUESTIONS.md #30).
 */
export function BasecampLinkBanner({
  load,
  onRetry,
  showErrors = false,
  children,
  testId = 'basecamp-banner',
}: {
  load: LinkLoad
  onRetry: () => void
  showErrors?: boolean
  /** Extra sentence for the screen it sits on (e.g. the editor's read-only synced sheets). */
  children?: ReactNode
  testId?: string
}) {
  if (load.kind === 'loading') return null
  if (load.kind === 'error') {
    if (!showErrors) return null
    return (
      <Notice
        tone="danger"
        testId={testId}
        actions={
          <button type="button" className="button button--small" onClick={onRetry}>
            {t.files.retry}
          </button>
        }
      >
        <p>{t.basecamp.loadFailed}</p>
        <p>{load.message}</p>
        {children}
      </Notice>
    )
  }
  if (load.link.state === 'active') return null
  return (
    <div data-link-state={load.link.state} className="banner-wrap">
      <Notice tone="warning" title={t.basecamp.bannerTitle} testId={testId} actions={<LinkAccountButton state={load.link.state} />}>
        <p>{explain(load.link.state)}</p>
        {children}
      </Notice>
    </div>
  )
}

const LOOK: Record<BasecampLinkState, { Icon: LucideIcon; tone: string }> = {
  active: { Icon: CircleCheck, tone: 'success' },
  unlinked: { Icon: Unlink, tone: 'neutral' },
  expired: { Icon: Clock, tone: 'warning' },
  revoked: { Icon: Ban, tone: 'neutral' },
}

export function LinkStateBadge({ state }: { state: BasecampLinkState }) {
  const look = LOOK[state] ?? LOOK.unlinked
  const { Icon } = look
  return (
    <span className={`badge badge--${look.tone}`} data-testid="basecamp-link-state" data-state={state}>
      <Icon className="icon" aria-hidden="true" />
      {t.basecamp.states[state] ?? t.basecamp.states.unlinked}
    </span>
  )
}

/** The settings screen's card: state, who it is linked as, link / relink / revoke. */
export function BasecampAccountCard() {
  const { load, reload, replace } = useBasecampLink()
  const [confirming, setConfirming] = useState(false)
  const [justRevoked, setJustRevoked] = useState(false)

  return (
    <section className="card" aria-labelledby="basecamp-account-heading" data-testid="basecamp-account">
      <div className="card__head">
        <h2 id="basecamp-account-heading">{t.settings.basecampSection}</h2>
        {load.kind === 'ready' ? <LinkStateBadge state={load.link.state} /> : null}
      </div>
      {load.kind === 'loading' ? (
        <p className="muted" role="status">
          <LoaderCircle className="icon spin inline-icon" aria-hidden="true" />
          {t.basecamp.loading}
        </p>
      ) : null}
      {load.kind === 'error' ? (
        <Notice
          tone="danger"
          actions={
            <button type="button" className="button button--small" onClick={reload}>
              {t.files.retry}
            </button>
          }
        >
          <p>{t.basecamp.loadFailed}</p>
          <p>{load.message}</p>
        </Notice>
      ) : null}
      {load.kind === 'ready' ? (
        <>
          {justRevoked ? (
            <Notice tone="info" testId="basecamp-revoked">
              <p>{t.basecamp.revoked}</p>
            </Notice>
          ) : null}
          {load.link.state === 'active' ? (
            <>
              <p>
                {load.link.name ? (
                  <>
                    {t.basecamp.linkedAs} <bdi>{load.link.name}</bdi>
                  </>
                ) : (
                  t.basecamp.linkedNoName
                )}
              </p>
              <div className="card__actions">
                <button type="button" className="button button--small" onClick={() => setConfirming(true)}>
                  {t.basecamp.revoke}
                </button>
              </div>
            </>
          ) : (
            <>
              <p data-testid="basecamp-explain">{explain(load.link.state)}</p>
              <div className="card__actions">
                <LinkAccountButton state={load.link.state} />
              </div>
            </>
          )}
        </>
      ) : null}
      <RevokeDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onRevoked={(state) => {
          setConfirming(false)
          setJustRevoked(true)
          if (load.kind === 'ready') replace({ ...load.link, state })
          else reload()
        }}
      />
    </section>
  )
}

/** Confirmation for «إلغاء الربط» (POST /api/basecamp/link/revoke). */
function RevokeDialog({ open, onClose, onRevoked }: { open: boolean; onClose: () => void; onRevoked: (state: 'revoked') => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const keepRef = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ids = useId()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      setError(null)
      dialog.showModal()
      // The safe choice has the focus.
      keepRef.current?.focus()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  const revoke = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.revokeBasecampLink()
      onRevoked(res.state)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={ref}
      className="dialog"
      role="alertdialog"
      aria-labelledby={`${ids}-title`}
      aria-describedby={`${ids}-body`}
      onClose={onClose}
      onCancel={(e) => {
        if (busy) e.preventDefault()
      }}
    >
      <div className="dialog__body">
        <h2 id={`${ids}-title`}>{t.basecamp.confirmTitle}</h2>
        <p id={`${ids}-body`}>{t.basecamp.confirmBody}</p>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog__actions">
          <button type="button" className="button button--danger" onClick={() => void revoke()} disabled={busy}>
            {busy ? <LoaderCircle className="icon spin" aria-hidden="true" /> : null}
            {busy ? t.basecamp.revoking : t.basecamp.revoke}
          </button>
          <button ref={keepRef} type="button" className="button" onClick={onClose} disabled={busy}>
            {t.basecamp.keep}
          </button>
        </div>
      </div>
    </dialog>
  )
}
