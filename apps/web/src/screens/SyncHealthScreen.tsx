// Admin: sync health report (spec §9.4 «تقرير صحة المزامنة لـ admin: عدد
// الأخطاء، التعارضات، آخر نجاح، حالة الـ Webhooks», §15 phase 7).
// GET /api/admin/sync-health, plus the latest backup run (GET /api/admin/backups, §14).

import { useEffect, useId, useState } from 'react'
import type { FormEvent } from 'react'
import { Archive, CircleCheck, CircleExclamationPoint, Clock, Inbox, LoaderCircle, RefreshCw, Save, TriangleExclamationPoint, Unplug, Webhook } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { BackupRunsResponse, CurrentUser, SyncHealthResponse } from '@naf-sheets/shared'
import { AdminPage } from '../components/AdminPage'
import { Notice } from '../components/Notice'
import { api, errorMessage, isAbortError } from '../lib/api'
import { formatCount, formatDateTime } from '../lib/format'
import { Link } from '../lib/router'
import { pathFor } from '../lib/routes'
import { t } from '../strings'

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: SyncHealthResponse }
type Backups = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; data: BackupRunsResponse }
type Webhook = SyncHealthResponse['workbooks'][number]['webhook']

// Never colour alone: every webhook state has an icon and a label.
const WEBHOOK: Record<Webhook, { Icon: LucideIcon; tone: string }> = {
  active: { Icon: CircleCheck, tone: 'success' },
  inactive: { Icon: TriangleExclamationPoint, tone: 'warning' },
  missing: { Icon: Unplug, tone: 'neutral' },
}

export function SyncHealthScreen({ user, userSettled }: { user: CurrentUser | null; userSettled: boolean }) {
  return (
    <AdminPage user={user} userSettled={userSettled} title={t.syncHealth.title} screen="sync-health">
      <SyncHealth />
    </AdminPage>
  )
}

function Count({ n, tone, Icon }: { n: number; tone: string; Icon: LucideIcon }) {
  if (n === 0) {
    return (
      <bdi className="num muted" data-count={0}>
        0
      </bdi>
    )
  }
  return (
    <span className={`badge badge--${tone}`} data-count={n}>
      <Icon className="icon" aria-hidden="true" />
      <bdi className="num">{formatCount(n)}</bdi>
    </span>
  )
}

function SyncHealth() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [backups, setBackups] = useState<Backups>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoad((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))
    api.getSyncHealth(controller.signal).then(
      (data) => setLoad({ kind: 'ready', data }),
      (error: unknown) => {
        if (!isAbortError(error)) setLoad({ kind: 'error', message: errorMessage(error) })
      },
    )
    api.getBackups(controller.signal).then(
      (data) => setBackups({ kind: 'ready', data }),
      (error: unknown) => {
        if (!isAbortError(error)) setBackups({ kind: 'error' })
      },
    )
    return () => controller.abort()
  }, [attempt])

  if (load.kind === 'loading') {
    return (
      <div className="panel panel--plain" role="status">
        <LoaderCircle className="panel__icon spin" aria-hidden="true" />
        <p>{t.syncHealth.loading}</p>
      </div>
    )
  }
  if (load.kind === 'error') {
    return (
      <Notice
        tone="danger"
        testId="sync-health-error"
        actions={
          <button type="button" className="button button--small" onClick={() => setAttempt((n) => n + 1)}>
            {t.files.retry}
          </button>
        }
      >
        <p>{load.message}</p>
      </Notice>
    )
  }

  const { workbooks, deadLetters } = load.data
  return (
    <div className="stack">
      <div className="section-head">
        <p className="lead">{t.syncHealth.intro}</p>
        <button type="button" className="button button--small" onClick={() => setAttempt((n) => n + 1)} data-testid="sync-health-refresh">
          <RefreshCw className="icon" aria-hidden="true" />
          {t.syncHealth.refresh}
        </button>
      </div>

      <section className="card" aria-labelledby="dead-letters-heading" data-testid="dead-letters" data-dead-letters={deadLetters}>
        <div className="card__row">
          <Inbox className="icon" aria-hidden="true" />
          <div className="stack-tight">
            <h2 id="dead-letters-heading">
              {t.syncHealth.deadLettersTitle}: <bdi className="num">{formatCount(deadLetters)}</bdi>
            </h2>
            <p className={deadLetters > 0 ? '' : 'muted'}>{t.syncHealth.deadLetters(deadLetters)}</p>
          </div>
        </div>
      </section>

      {workbooks.length === 0 ? (
        <section className="panel" data-testid="sync-health-empty">
          <Webhook className="panel__icon" aria-hidden="true" />
          <h2>{t.syncHealth.emptyTitle}</h2>
          <p>{t.syncHealth.emptyBody}</p>
        </section>
      ) : (
        <div className="table-wrap">
          <table className="data-table" data-testid="sync-health-table">
            <caption className="sr-only">{t.syncHealth.title}</caption>
            <thead>
              <tr>
                <th scope="col">{t.syncHealth.columns.workbook}</th>
                <th scope="col">{t.syncHealth.columns.errors}</th>
                <th scope="col">{t.syncHealth.columns.conflicts}</th>
                <th scope="col">{t.syncHealth.columns.pending}</th>
                <th scope="col">{t.syncHealth.columns.lastSuccess}</th>
                <th scope="col">{t.syncHealth.columns.webhook}</th>
              </tr>
            </thead>
            <tbody>
              {workbooks.map((w) => {
                const look = WEBHOOK[w.webhook] ?? WEBHOOK.missing
                const last = w.lastSuccessAt ? formatDateTime(w.lastSuccessAt) : null
                const hint = w.webhook === 'active' ? null : t.syncHealth.webhookHint[w.webhook]
                return (
                  <tr key={w.workbookId} data-workbook-id={w.workbookId}>
                    <th scope="row">
                      <div className="stack-tight">
                        <Link href={pathFor({ name: 'editor', id: w.workbookId })}>
                          <bdi>{w.title}</bdi>
                        </Link>
                        <span className="muted small">
                          {t.syncHealth.projectNumber} <bdi className="num">{w.bcProjectId}</bdi>
                        </span>
                      </div>
                    </th>
                    <td data-col="errors">
                      <Count n={w.counts.error} tone="danger" Icon={TriangleExclamationPoint} />
                    </td>
                    <td data-col="conflicts">
                      <Count n={w.counts.conflict} tone="warning" Icon={CircleExclamationPoint} />
                    </td>
                    <td data-col="pending">
                      <Count n={w.counts.pending} tone="info" Icon={Clock} />
                    </td>
                    <td data-col="last-success">{last ? <bdi dir="ltr" className="num">{last}</bdi> : <span className="muted">{t.syncHealth.never}</span>}</td>
                    <td data-col="webhook" data-webhook={w.webhook}>
                      <div className="stack-tight">
                        <span className={`badge badge--${look.tone}`}>
                          <look.Icon className="icon" aria-hidden="true" />
                          {t.syncHealth.webhook[w.webhook]}
                        </span>
                        {hint ? <span className="muted small">{hint}</span> : null}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <BackupCard backups={backups} />
    </div>
  )
}

function BackupCard({ backups }: { backups: Backups }) {
  if (backups.kind === 'loading') return null
  const latest = backups.kind === 'ready' ? backups.data.runs[0] : undefined
  return (
    <section className="card" aria-labelledby="backup-heading" data-testid="backup-card" data-backup-status={latest?.status ?? 'none'}>
      <div className="card__row">
        <Archive className="icon" aria-hidden="true" />
        <div className="stack-tight">
          <h2 id="backup-heading">{t.syncHealth.backupTitle}</h2>
          {backups.kind === 'error' ? (
            <p className="muted">{t.syncHealth.backupLoadFailed}</p>
          ) : !latest ? (
            <p className="muted">{t.syncHealth.backupNone}</p>
          ) : (
            <>
              <p>
                {t.syncHealth.backupLast}: <bdi dir="ltr" className="num">{formatDateTime(latest.startedAt) ?? latest.startedAt}</bdi> —{' '}
                <span className={`badge badge--${latest.status === 'succeeded' ? 'success' : latest.status === 'running' ? 'info' : 'danger'}`}>
                  {latest.status === 'succeeded' ? <CircleCheck className="icon" aria-hidden="true" /> : <TriangleExclamationPoint className="icon" aria-hidden="true" />}
                  {t.syncHealth.backupStatus[latest.status]}
                </span>
              </p>
              {latest.status === 'succeeded' ? <p className="muted small">{t.syncHealth.backupRows(formatCount(latest.rows))}</p> : null}
              {latest.message ? <p className="small">{latest.message}</p> : null}
            </>
          )}
        </div>
      </div>
      {backups.kind === 'ready' ? <RetentionSection data={backups.data} /> : null}
    </section>
  )
}

/** Backup retention (owner decision 2026-11-10): the policy, what it last removed, and its two numbers. */
function RetentionSection({ data }: { data: BackupRunsResponse }) {
  const ids = useId()
  const [saved, setSaved] = useState(data.retention)
  const [daily, setDaily] = useState(String(data.retention.keepDaily))
  const [monthly, setMonthly] = useState(String(data.retention.keepMonthly))
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string }>({ kind: 'idle' })
  const last = data.lastPrune

  async function save(event: FormEvent) {
    event.preventDefault()
    const keepDaily = Number(daily)
    const keepMonthly = Number(monthly)
    const valid = (n: number, min: number, max: number) => daily.trim() !== '' && monthly.trim() !== '' && Number.isInteger(n) && n >= min && n <= max
    if (!valid(keepDaily, 1, 365) || !valid(keepMonthly, 0, 120)) {
      setState({ kind: 'error', message: t.syncHealth.retentionInvalid })
      return
    }
    setState({ kind: 'saving' })
    try {
      const result = await api.putBackupRetention({ keepDaily, keepMonthly })
      setSaved(result.retention)
      setState({ kind: 'saved' })
    } catch (error) {
      setState({ kind: 'error', message: errorMessage(error) })
    }
  }

  return (
    <div className="stack-tight" data-testid="backup-retention" data-keep-daily={saved.keepDaily} data-keep-monthly={saved.keepMonthly}>
      <h3 id={`${ids}-title`}>{t.syncHealth.retentionTitle}</h3>
      <p className="small" data-testid="retention-policy">
        {t.syncHealth.retentionPolicy[0]} <bdi className="num">{formatCount(saved.keepDaily)}</bdi> {t.syncHealth.retentionPolicy[1]}{' '}
        <bdi className="num">{formatCount(saved.keepMonthly)}</bdi> {t.syncHealth.retentionPolicy[2]}
      </p>
      <p className="muted small" data-testid="retention-last">
        {last ? (
          <>
            {t.syncHealth.retentionLast[0]} <bdi dir="ltr" className="num">{formatDateTime(last.at) ?? last.at}</bdi>
            {t.syncHealth.retentionLast[1]} <bdi className="num">{formatCount(last.runsRemoved)}</bdi> {t.syncHealth.retentionLast[2]}{' '}
            <bdi className="num">{formatCount(last.runsKept)}</bdi> {t.syncHealth.retentionLast[3]}
          </>
        ) : (
          t.syncHealth.retentionNone
        )}
      </p>
      {last?.message ? <p className="small">{last.message}</p> : null}
      <form className="stack-tight" onSubmit={save} noValidate aria-labelledby={`${ids}-title`}>
        <div className="field field--inline">
          <label htmlFor={`${ids}-daily`}>{t.syncHealth.retentionDaily}</label>
          <input
            id={`${ids}-daily`}
            className="input-number"
            type="number"
            inputMode="numeric"
            dir="ltr"
            min={1}
            max={365}
            value={daily}
            onChange={(e) => setDaily(e.target.value)}
            aria-invalid={state.kind === 'error' ? true : undefined}
            disabled={state.kind === 'saving'}
            data-testid="retention-daily"
          />
        </div>
        <div className="field field--inline">
          <label htmlFor={`${ids}-monthly`}>{t.syncHealth.retentionMonthly}</label>
          <input
            id={`${ids}-monthly`}
            className="input-number"
            type="number"
            inputMode="numeric"
            dir="ltr"
            min={0}
            max={120}
            value={monthly}
            onChange={(e) => setMonthly(e.target.value)}
            aria-invalid={state.kind === 'error' ? true : undefined}
            disabled={state.kind === 'saving'}
            data-testid="retention-monthly"
          />
        </div>
        {state.kind === 'error' ? (
          <p className="field-error" role="alert" data-testid="retention-error">
            {state.message}
          </p>
        ) : null}
        {state.kind === 'saved' ? (
          <p className="small" role="status" data-testid="retention-saved">
            {t.syncHealth.retentionSaved}
          </p>
        ) : null}
        <div className="card__actions">
          <button type="submit" className="button button--small" disabled={state.kind === 'saving'} data-testid="retention-save">
            {state.kind === 'saving' ? <LoaderCircle className="icon spin" aria-hidden="true" /> : <Save className="icon" aria-hidden="true" />}
            {state.kind === 'saving' ? t.syncHealth.retentionSaving : t.syncHealth.retentionSave}
          </button>
        </div>
      </form>
    </div>
  )
}
