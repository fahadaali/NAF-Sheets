// Admin: service tokens of the internal API (spec §13 «واجهة برمجية داخلية
// للمنظومة (محمية برموز خدمة)»). The token is shown once, right after it is
// created; only its hash is stored. Revoking never deletes the record.

import { useEffect, useId, useState } from 'react'
import type { FormEvent } from 'react'
import { Ban, KeyRound, LoaderCircle, Plus } from 'lucide-react'
import type { ApiTokenSummary, CurrentUser } from '@naf-sheets/shared'
import { AdminPage } from '../components/AdminPage'
import { Notice } from '../components/Notice'
import { api, errorMessage, isAbortError } from '../lib/api'
import { formatDateTime } from '../lib/format'
import { t } from '../strings'

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; tokens: ApiTokenSummary[] }

/** The read-only endpoints of the internal API (packages/shared/src/api-phase7.ts). */
const ENDPOINTS = ['GET /api/v1/workbooks', 'GET /api/v1/workbooks/:id/tasks?status=&assignee=&due_before=', 'GET /api/v1/stats']

export function ApiTokensScreen({ user, userSettled }: { user: CurrentUser | null; userSettled: boolean }) {
  return (
    <AdminPage user={user} userSettled={userSettled} title={t.apiTokens.title} screen="api-tokens">
      <ApiTokens />
    </AdminPage>
  )
}

function ApiTokens() {
  const ids = useId()
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    api.listApiTokens(controller.signal).then(
      (data) => setLoad({ kind: 'ready', tokens: data.tokens }),
      (err: unknown) => {
        if (!isAbortError(err)) setLoad({ kind: 'error', message: errorMessage(err) })
      },
    )
    return () => controller.abort()
  }, [attempt])

  const reload = () => setAttempt((n) => n + 1)

  const create = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (!name.trim()) return setError(t.apiTokens.nameRequired)
    setBusy(true)
    setError(null)
    try {
      const created = await api.createApiToken(name.trim())
      setSecret(created.secret)
      setName('')
      reload()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <p className="lead">{t.apiTokens.intro}</p>
      <section className="card" aria-labelledby={`${ids}-endpoints`}>
        <h2 id={`${ids}-endpoints`}>{t.apiTokens.endpointsTitle}</h2>
        <ul className="stack-tight" dir="ltr" data-testid="api-endpoints">
          {ENDPOINTS.map((e) => (
            <li key={e}>
              <code>{e}</code>
            </li>
          ))}
        </ul>
      </section>

      <section className="card" aria-labelledby={`${ids}-create`}>
        <h2 id={`${ids}-create`} className="sr-only">
          {t.apiTokens.create}
        </h2>
        <form className="stack" onSubmit={create} noValidate>
          <div className="field">
            <label htmlFor={`${ids}-name`}>{t.apiTokens.nameLabel}</label>
            <input id={`${ids}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoComplete="off" disabled={busy} />
          </div>
          {error ? (
            <p className="field-error" role="alert" data-testid="token-error">
              {error}
            </p>
          ) : null}
          <div className="card__actions">
            <button type="submit" className="button button--primary" disabled={busy}>
              {busy ? <LoaderCircle className="icon spin" aria-hidden="true" /> : <Plus className="icon" aria-hidden="true" />}
              {busy ? t.apiTokens.creating : t.apiTokens.create}
            </button>
          </div>
        </form>
      </section>

      {secret ? (
        <Notice
          tone="warning"
          title={t.apiTokens.secretTitle}
          testId="token-secret"
          actions={
            <button type="button" className="button button--small" onClick={() => setSecret(null)}>
              {t.apiTokens.hideSecret}
            </button>
          }
        >
          <p>{t.apiTokens.secretBody}</p>
          <label className="sr-only" htmlFor={`${ids}-secret`}>
            {t.apiTokens.secretLabel}
          </label>
          <input id={`${ids}-secret`} className="secret-field" dir="ltr" readOnly value={secret} onFocus={(e) => e.currentTarget.select()} data-testid="token-secret-value" />
        </Notice>
      ) : null}

      {load.kind === 'loading' ? (
        <div className="panel panel--plain" role="status">
          <LoaderCircle className="panel__icon spin" aria-hidden="true" />
          <p>{t.apiTokens.loading}</p>
        </div>
      ) : load.kind === 'error' ? (
        <Notice
          tone="danger"
          actions={
            <button type="button" className="button button--small" onClick={reload}>
              {t.files.retry}
            </button>
          }
        >
          <p>{load.message}</p>
        </Notice>
      ) : load.tokens.length === 0 ? (
        <section className="panel" data-testid="tokens-empty">
          <KeyRound className="panel__icon" aria-hidden="true" />
          <h2>{t.apiTokens.emptyTitle}</h2>
          <p>{t.apiTokens.emptyBody}</p>
        </section>
      ) : (
        <div className="table-wrap">
          <table className="data-table" data-testid="tokens-table">
            <caption className="sr-only">{t.apiTokens.title}</caption>
            <thead>
              <tr>
                <th scope="col">{t.apiTokens.columns.name}</th>
                <th scope="col">{t.apiTokens.columns.prefix}</th>
                <th scope="col">{t.apiTokens.columns.createdAt}</th>
                <th scope="col">{t.apiTokens.columns.lastUsedAt}</th>
                <th scope="col">{t.apiTokens.columns.state}</th>
                <th scope="col">{t.apiTokens.columns.actions}</th>
              </tr>
            </thead>
            <tbody>
              {load.tokens.map((token) => (
                <TokenRow key={token.id} token={token} onChanged={reload} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function TokenRow({ token, onChanged }: { token: ApiTokenSummary; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const revoked = token.revokedAt !== null

  const revoke = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.revokeApiToken(token.id)
      onChanged()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <tr data-token-id={token.id} data-revoked={revoked ? 'true' : 'false'}>
      <th scope="row">
        <bdi>{token.name}</bdi>
      </th>
      <td>
        <bdi dir="ltr">
          <code>{token.prefix}…</code>
        </bdi>
      </td>
      <td>
        <bdi dir="ltr" className="num">{formatDateTime(token.createdAt) ?? token.createdAt}</bdi>
      </td>
      <td>{token.lastUsedAt ? <bdi dir="ltr" className="num">{formatDateTime(token.lastUsedAt) ?? token.lastUsedAt}</bdi> : <span className="muted">{t.apiTokens.never}</span>}</td>
      <td>
        {revoked ? (
          <span className="badge badge--neutral">
            <Ban className="icon" aria-hidden="true" />
            {t.apiTokens.revoked}
          </span>
        ) : (
          <span className="badge badge--success">
            <KeyRound className="icon" aria-hidden="true" />
            {t.apiTokens.active}
          </span>
        )}
      </td>
      <td>
        {revoked ? null : confirming ? (
          <div className="stack-tight" role="group" aria-label={t.apiTokens.revoke}>
            <p className="small">{t.apiTokens.revokeConfirm}</p>
            <div className="row-actions">
              <button type="button" className="button button--small button--danger" onClick={() => void revoke()} disabled={busy}>
                {busy ? <LoaderCircle className="icon spin" aria-hidden="true" /> : <Ban className="icon" aria-hidden="true" />}
                {busy ? t.apiTokens.revoking : t.apiTokens.revokeYes}
              </button>
              <button type="button" className="button button--small" onClick={() => setConfirming(false)} disabled={busy}>
                {t.apiTokens.keep}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="button button--small" onClick={() => setConfirming(true)}>
            <Ban className="icon" aria-hidden="true" />
            {t.apiTokens.revoke}
          </button>
        )}
        {error ? (
          <span className="field-error" role="alert">
            {error}
          </span>
        ) : null}
      </td>
    </tr>
  )
}
