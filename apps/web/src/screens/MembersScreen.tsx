// Admin: platform members «أعضاء المنصة» (spec §3, §12.1 item 8).
// GET /api/admin/members, PUT /api/admin/members/:userId.
//
// naf-auth creates every member as «مشاهد» at their first sign-in; an admin
// changes the role and the active state here. The API refuses an admin's
// change to themselves and any change that would leave no active admin; the
// screen explains both next to the controls it disables.

import { useEffect, useState } from 'react'
import { Ban, CircleCheck, CircleDashed, Link2, LoaderCircle, Mail, RefreshCw, Save, UserCheck, Users, UserX } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { BasecampMatchState, CurrentUser, PlatformMember, PlatformRole, UpdatePlatformMemberResponse } from '@naf-sheets/shared'
import { AdminPage } from '../components/AdminPage'
import { Notice } from '../components/Notice'
import { api, errorMessage, isAbortError } from '../lib/api'
import { formatDateTime } from '../lib/format'
import { lastSeenDay, memberLock, peopleMatchHref } from '../lib/members'
import { Link } from '../lib/router'
import { t } from '../strings'
import '../styles/members.css'

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; members: PlatformMember[] }
/** The last change, announced above the table. */
type Outcome = { member: string; text: string; report: UpdatePlatformMemberResponse['nafIdReport'] }

const ROLES: PlatformRole[] = ['admin', 'editor', 'viewer']

// Never colour alone: every match state has an icon and a label.
const MATCH: Record<BasecampMatchState, { Icon: LucideIcon; tone: string }> = {
  auto: { Icon: Mail, tone: 'success' },
  manual: { Icon: UserCheck, tone: 'success' },
  declined: { Icon: UserX, tone: 'neutral' },
  none: { Icon: CircleDashed, tone: 'warning' },
}

export function MembersScreen({ user, userSettled }: { user: CurrentUser | null; userSettled: boolean }) {
  return (
    <AdminPage user={user} userSettled={userSettled} title={t.members.title} screen="members">
      <Members selfId={user?.id ?? ''} />
    </AdminPage>
  )
}

function displayName(m: PlatformMember): string {
  return m.name || m.email || t.members.unnamed
}

function Members({ selfId }: { selfId: string }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoad((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))
    api.listMembers(controller.signal).then(
      (data) => setLoad({ kind: 'ready', members: data.members }),
      (error: unknown) => {
        if (!isAbortError(error)) setLoad({ kind: 'error', message: errorMessage(error) })
      },
    )
    return () => controller.abort()
  }, [attempt])

  if (load.kind === 'loading') {
    return (
      <div className="panel panel--plain" role="status">
        <LoaderCircle className="panel__icon spin" aria-hidden="true" />
        <p>{t.members.loading}</p>
      </div>
    )
  }
  if (load.kind === 'error') {
    return (
      <Notice
        tone="danger"
        testId="members-error"
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

  // What the API stored replaces the row: the list is read again after each change.
  const onChanged = (res: UpdatePlatformMemberResponse, text: string) => {
    setLoad((prev) => (prev.kind === 'ready' ? { kind: 'ready', members: prev.members.map((m) => (m.userId === res.member.userId ? res.member : m)) } : prev))
    setOutcome({ member: displayName(res.member), text, report: res.nafIdReport })
    setAttempt((n) => n + 1)
  }

  return (
    <div className="stack">
      <div className="section-head">
        <p className="lead">{t.members.intro}</p>
        <button type="button" className="button button--small" onClick={() => setAttempt((n) => n + 1)} data-testid="members-refresh">
          <RefreshCw className="icon" aria-hidden="true" />
          {t.members.refresh}
        </button>
      </div>
      <p className="muted small" data-testid="members-first-sign-in">
        {t.members.firstSignIn}
      </p>

      <div aria-live="polite" data-testid="members-outcome">
        {outcome ? (
          <Notice tone={outcome.report === 'failed' ? 'warning' : 'info'}>
            <p>
              {outcome.text}: <bdi>{outcome.member}</bdi>
            </p>
            {outcome.report === 'failed' ? <p>{t.members.reportFailed}</p> : null}
            {outcome.report === 'skipped' ? <p>{t.members.reportSkipped}</p> : null}
          </Notice>
        ) : null}
      </div>

      {load.members.length === 0 ? (
        <section className="panel" data-testid="members-empty">
          <Users className="panel__icon" aria-hidden="true" />
          <h2>{t.members.emptyTitle}</h2>
          <p>{t.members.emptyBody}</p>
        </section>
      ) : (
        <div className="table-wrap">
          <table className="data-table members-table" data-testid="members-table">
            <caption className="sr-only">{t.members.title}</caption>
            <thead>
              <tr>
                <th scope="col">{t.members.columns.member}</th>
                <th scope="col">{t.members.columns.email}</th>
                <th scope="col">{t.members.columns.role}</th>
                <th scope="col">{t.members.columns.status}</th>
                <th scope="col">{t.members.columns.lastSeen}</th>
                <th scope="col">{t.members.columns.basecamp}</th>
              </tr>
            </thead>
            <tbody>
              {load.members.map((m) => (
                <MemberRow key={m.userId} member={m} lock={memberLock(m, selfId, load.members)} onChanged={onChanged} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function MemberRow({
  member,
  lock,
  onChanged,
}: {
  member: PlatformMember
  lock: 'self' | 'last_admin' | null
  onChanged: (res: UpdatePlatformMemberResponse, text: string) => void
}) {
  const [role, setRole] = useState<PlatformRole>(member.role)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = displayName(member)
  const self = lock === 'self'
  const locked = lock !== null
  const selectId = `member-role-${member.userId}`
  const hintId = `member-hint-${member.userId}`

  // A fresh list from the API replaces the row's value.
  useEffect(() => setRole(member.role), [member.role])

  const save = async (body: { role?: PlatformRole; active?: boolean }, text: string) => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.updateMember(member.userId, body)
      setConfirming(false)
      onChanged(res, text)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const match = MATCH[member.basecamp.state]
  const lastSeen = lastSeenDay(member.lastSeenAt)

  return (
    <tr data-user-id={member.userId} data-role={member.role} data-active={member.active ? 'true' : 'false'}>
      <th scope="row" data-label={t.members.columns.member}>
        <div className="stack-tight">
          <bdi>{name}</bdi>
          {self ? <span className="badge badge--info">{t.members.you}</span> : null}
        </div>
      </th>
      <td data-label={t.members.columns.email}>{member.email ? <bdi dir="ltr" className="members-table__email">{member.email}</bdi> : <span className="muted">—</span>}</td>
      <td data-label={t.members.columns.role}>
        <div className="stack-tight">
          <div className="row-actions">
            <label htmlFor={selectId} className="sr-only">
              {t.members.roleLabel(name)}
            </label>
            <select
              id={selectId}
              className="select members-table__role"
              value={role}
              onChange={(e) => {
                setRole(e.target.value as PlatformRole)
                setError(null)
              }}
              disabled={busy || locked}
              aria-describedby={locked ? hintId : undefined}
              data-testid="member-role"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {t.members.roles[r]}
                </option>
              ))}
            </select>
            {locked ? null : (
              <button
                type="button"
                className="button button--small"
                onClick={() => void save({ role }, t.members.savedRole(t.members.roles[role]))}
                disabled={busy || role === member.role}
                data-testid="member-save-role"
              >
                {busy && role !== member.role ? <LoaderCircle className="icon spin" aria-hidden="true" /> : <Save className="icon" aria-hidden="true" />}
                {busy && role !== member.role ? t.members.saving : t.members.saveRole}
              </button>
            )}
          </div>
          {locked ? (
            <p id={hintId} className="muted small" data-testid={self ? 'member-self-hint' : 'member-last-admin-hint'}>
              {self ? t.members.selfHint : t.members.lastAdminHint}
            </p>
          ) : null}
        </div>
      </td>
      <td data-label={t.members.columns.status}>
        <div className="stack-tight">
          {member.active ? (
            <span className="badge badge--success" data-testid="member-status">
              <CircleCheck className="icon" aria-hidden="true" />
              {t.members.status.active}
            </span>
          ) : (
            <span className="badge badge--neutral" data-testid="member-status">
              <Ban className="icon" aria-hidden="true" />
              {t.members.status.suspended}
            </span>
          )}
          {locked ? null : member.active ? (
            confirming ? (
              <div className="stack-tight" role="group" aria-label={t.members.suspend} data-testid="member-suspend-confirm">
                <p className="small">{t.members.suspendConfirm}</p>
                <div className="row-actions">
                  <button type="button" className="button button--small button--danger" onClick={() => void save({ active: false }, t.members.suspended)} disabled={busy} data-testid="member-suspend-yes">
                    {busy ? <LoaderCircle className="icon spin" aria-hidden="true" /> : <Ban className="icon" aria-hidden="true" />}
                    {busy ? t.members.saving : t.members.suspendYes}
                  </button>
                  <button type="button" className="button button--small" onClick={() => setConfirming(false)} disabled={busy}>
                    {t.members.keepActive}
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="button button--small" onClick={() => setConfirming(true)} disabled={busy} data-testid="member-suspend">
                <Ban className="icon" aria-hidden="true" />
                {t.members.suspend}
              </button>
            )
          ) : (
            <button type="button" className="button button--small" onClick={() => void save({ active: true }, t.members.reactivated)} disabled={busy} data-testid="member-reactivate">
              {busy ? <LoaderCircle className="icon spin" aria-hidden="true" /> : <CircleCheck className="icon" aria-hidden="true" />}
              {busy ? t.members.saving : t.members.reactivate}
            </button>
          )}
          {error ? (
            <span className="field-error" role="alert" data-testid="member-error">
              {error}
            </span>
          ) : null}
        </div>
      </td>
      <td data-label={t.members.columns.lastSeen}>
        {lastSeen ? (
          <bdi dir="ltr" className="num" title={formatDateTime(member.lastSeenAt ?? '') ?? undefined}>
            {lastSeen}
          </bdi>
        ) : (
          <span className="muted">{t.members.never}</span>
        )}
      </td>
      <td data-label={t.members.columns.basecamp}>
        <div className="stack-tight">
          <span className={`badge badge--${match.tone}`} data-match={member.basecamp.state}>
            <match.Icon className="icon" aria-hidden="true" />
            {t.members.match[member.basecamp.state]}
          </span>
          {member.basecamp.personName ? <bdi className="small">{member.basecamp.personName}</bdi> : null}
          {member.active ? (
            <Link
              className="button button--small button--ghost"
              href={peopleMatchHref(member.userId)}
              aria-label={t.members.openMatchLabel(name)}
              data-testid="member-open-match"
            >
              <Link2 className="icon" aria-hidden="true" />
              {t.members.openMatch}
            </Link>
          ) : (
            <span className="muted small">{t.members.suspendedMatchHint}</span>
          )}
        </div>
      </td>
    </tr>
  )
}
