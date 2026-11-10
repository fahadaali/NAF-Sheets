// The DOM around the grid for synced sheets: the row tooltip, the deletion
// dialog (§9.2.7), the «حالة المزامنة» panel with conflicts (§9.1) and rows
// that need attention, and the sheet toolbar (indent, outdent, collapse).

import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Activity,
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  ExternalLink,
  ListIndentDecrease,
  ListIndentIncrease,
  LoaderCircle,
  LocateFixed,
  MessageSquare,
  Paperclip,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react'
import type { AssigneeOptionsResponse, ConflictRecord, TaskUid, WorkbookSyncResponse } from '@naf-sheets/shared'
import { formatCount, formatDateTime } from '../lib/format'
import { Notice } from '../components/Notice'
import { t } from '../strings'
import { conflictFieldLabel, formatConflictValue } from '../sync/conflicts'
import type { RowState } from '../sync/sync-state'
import { STATE_ICONS } from './sync-render'
import type { ActiveTask, RemovalRequest, RowHover } from './sync-layer'

export function StateLabel({ state }: { state: RowState }) {
  const Icon = STATE_ICONS[state]
  return (
    <span className={`row-state row-state--${state}`} data-state={state}>
      <Icon className="icon" aria-hidden="true" />
      {t.rowSync.states[state]}
    </span>
  )
}

/** Shown while the pointer is on a row number of a synced sheet; stays open while hovered. */
export function RowTooltip({ hover, canWrite, onClose, onRemoveRow }: { hover: RowHover; canWrite: boolean; onClose: () => void; onRemoveRow: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: hover.y + 12, left: hover.x })
  const ind = hover.indicator

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const margin = 8
    // Open towards the inside of the window from the pointer (the row numbers sit at the inline end in RTL).
    const left = Math.min(Math.max(margin, hover.x - rect.width + 16), window.innerWidth - rect.width - margin)
    const top = hover.y + 16 + rect.height > window.innerHeight - margin ? Math.max(margin, hover.y - rect.height - 8) : hover.y + 16
    setPos({ top, left })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hover.x, hover.y, hover.row, onClose])

  if (!ind) return null
  return (
    <div ref={ref} className="row-tooltip" role="tooltip" style={{ top: pos.top, left: pos.left }} data-testid="row-tooltip" data-row={hover.row + 1} data-state={ind.state}>
      <div className="row-tooltip__head">
        <StateLabel state={ind.state} />
        <span className="muted small">
          <bdi className="num">{t.rowSync.row(hover.row + 1)}</bdi>
        </span>
      </div>
      {hover.title ? (
        <p className="row-tooltip__title">
          <bdi>{hover.title}</bdi>
        </p>
      ) : null}
      {ind.message ? <p className="small">{ind.message}</p> : null}
      {ind.state === 'deleted' ? <p className="small">{t.rowSync.deletedBody}</p> : null}
      {ind.state === 'pending' && !ind.message ? <p className="small muted">{t.rowSync.pendingBody}</p> : null}
      {(ind.commentsCount ?? 0) > 0 || ind.attachmentsCount > 0 ? (
        <p className="small with-icon row-tooltip__counts" data-testid="row-counts">
          {(ind.commentsCount ?? 0) > 0 ? (
            <span className="with-icon" title={t.comments.countLabel}>
              <MessageSquare className="icon" aria-hidden="true" />
              <bdi className="num">{t.comments.count(ind.commentsCount as number)}</bdi>
            </span>
          ) : null}
          {ind.attachmentsCount > 0 ? (
            <span className="with-icon" title={t.attachments.title}>
              <Paperclip className="icon" aria-hidden="true" />
              <bdi className="num">{t.attachments.count(ind.attachmentsCount)}</bdi>
            </span>
          ) : null}
        </p>
      ) : null}
      {hover.progress && hover.progress.total > 0 ? (
        <p className="small" data-testid="row-progress">
          {t.hierarchy.progressLabel}: <bdi className="num">{t.hierarchy.progress(hover.progress.done, hover.progress.total)}</bdi>
        </p>
      ) : null}
      <div className="row-tooltip__actions">
        {ind.bcUrl ? (
          <a className="button button--small" href={ind.bcUrl} target="_blank" rel="noopener noreferrer" data-testid="row-bc-link">
            <ExternalLink className="icon" aria-hidden="true" />
            {t.rowSync.openInBasecamp}
          </a>
        ) : null}
        {ind.state === 'deleted' && canWrite ? (
          <button type="button" className="button button--small" onClick={onRemoveRow} data-testid="row-remove">
            <Trash2 className="icon" aria-hidden="true" />
            {t.deletion.confirm}
          </button>
        ) : null}
      </div>
    </div>
  )
}

/** §9.2.7: what removing the selected synced rows does in Basecamp. Resolves the decision. */
export function DeletionDialog({ request, onDecide }: { request: RemovalRequest; onDecide: (confirmed: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const ids = useId()
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  const { plan, titles, alreadyDeleted } = request
  const name = (uid: TaskUid) => titles.get(uid) || t.deletion.untitled
  const todos = plan.todos.filter((f) => !alreadyDeleted.has(f.row.uid))
  const subtasks = plan.subtasks.filter((s) => !alreadyDeleted.has(s.uid))
  const gone = [...plan.todos.map((f) => f.row), ...plan.subtasks].filter((r) => alreadyDeleted.has(r.uid))
  return (
    <dialog ref={ref} className="dialog" role="alertdialog" aria-labelledby={`${ids}-title`} onClose={() => onDecide(false)} data-testid="deletion-dialog">
      <div className="dialog__body">
        <h2 id={`${ids}-title`}>{t.deletion.title}</h2>
        {todos.length > 0 ? (
          <section className="stack-tight" data-testid="deletion-todos">
            <h3 className="picker__label">{t.deletion.todosHeading}</h3>
            <p>{t.deletion.todo}</p>
            <ul className="deletion-list">
              {todos.map((f) => (
                <li key={f.row.uid}>
                  <bdi>{name(f.row.uid)}</bdi>
                  {f.subtasks.length > 0 ? <span className="muted small"> — {t.deletion.withSubtasks(f.subtasks.length)}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {subtasks.length > 0 ? (
          <section className="stack-tight" data-testid="deletion-subtasks">
            <h3 className="picker__label">{t.deletion.subtasksHeading}</h3>
            <p className="deletion-warning">{t.deletion.subtask}</p>
            <ul className="deletion-list">
              {subtasks.map((s) => (
                <li key={s.uid}>
                  <bdi>{name(s.uid)}</bdi>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {gone.length > 0 ? (
          <section className="stack-tight" data-testid="deletion-gone">
            <p>{t.deletion.alreadyDeleted}</p>
            <ul className="deletion-list">
              {gone.map((r) => (
                <li key={r.uid}>
                  <bdi>{name(r.uid)}</bdi>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <p className="muted small">{t.deletion.whenSaved}</p>
        <div className="dialog__actions">
          <button type="button" className="button button--danger" onClick={() => onDecide(true)} data-testid="deletion-confirm">
            <Trash2 className="icon" aria-hidden="true" />
            {t.deletion.confirm}
          </button>
          <button type="button" className="button" onClick={() => onDecide(false)} autoFocus data-testid="deletion-cancel">
            {t.deletion.cancel}
          </button>
        </div>
      </div>
    </dialog>
  )
}

export interface AttentionRow {
  uid: TaskUid
  sheetId: string
  sheetTitle: string
  row: number
  title: string
  state: RowState
  message: string | null
  bcUrl: string | null
}

export interface PanelConflict {
  conflict: ConflictRecord
  title: string
  located: boolean
}

/** «حالة المزامنة»: the workbook's state, its conflicts and the rows needing attention. */
export function SyncPanel({
  open,
  info,
  conflicts,
  attention,
  options,
  canResolve,
  onClose,
  onGoTo,
  onRestore,
  onDismiss,
}: {
  open: boolean
  info: WorkbookSyncResponse | null
  conflicts: PanelConflict[]
  attention: AttentionRow[]
  options: AssigneeOptionsResponse | null
  canResolve: boolean
  onClose: () => void
  onGoTo: (uid: TaskUid, field?: ConflictRecord['field']) => void
  onRestore: (conflict: ConflictRecord) => Promise<string | null>
  onDismiss: (conflict: ConflictRecord) => Promise<string | null>
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const ids = useId()
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      setMessage(null)
      dialog.showModal()
    } else if (!open && dialog.open) dialog.close()
  }, [open])

  const act = async (conflict: ConflictRecord, run: (c: ConflictRecord) => Promise<string | null>, done: string) => {
    setBusy(conflict.id)
    const problem = await run(conflict)
    setBusy(null)
    setMessage(problem ? { tone: 'danger', text: problem } : { tone: 'info', text: done })
  }

  const last = info?.lastSuccessAt ? formatDateTime(info.lastSuccessAt) : null
  return (
    <dialog ref={ref} className="side-panel" aria-labelledby={`${ids}-title`} onClose={onClose} data-testid="sync-panel">
      <div className="side-panel__head">
        <h2 id={`${ids}-title`} className="with-icon">
          <Activity className="icon" aria-hidden="true" />
          {t.rowSync.panelTitle}
        </h2>
        <button type="button" className="icon-button" aria-label={t.fileSettings.close} title={t.fileSettings.close} onClick={onClose}>
          <X className="icon" aria-hidden="true" />
        </button>
      </div>
      <section className="side-panel__section">
        <p className="small">
          {t.rowSync.lastSuccess}: {last ? <bdi dir="ltr" className="num">{last}</bdi> :<span className="muted">{t.rowSync.never}</span>}
        </p>
        {message ? (
          <Notice tone={message.tone} testId="sync-panel-message">
            <p>{message.text}</p>
          </Notice>
        ) : null}
      </section>
      <section className="side-panel__section" aria-labelledby={`${ids}-conflicts`} data-testid="conflict-list">
        <h3 id={`${ids}-conflicts`}>{t.conflicts.title}</h3>
        {conflicts.length === 0 ? (
          <p className="muted small">{t.conflicts.empty}</p>
        ) : (
          <>
            <p className="small muted">{t.conflicts.intro}</p>
            <ul className="panel-list">
              {conflicts.map(({ conflict, title, located }) => {
                const winnerLocal = conflict.winner === 'local'
                return (
                  <li key={conflict.id} className="panel-item" data-conflict-id={conflict.id}>
                    <p className="panel-item__title">
                      <strong>{conflictFieldLabel(conflict.field)}</strong>
                      {title ? (
                        <>
                          {' — '}
                          <bdi>{title}</bdi>
                        </>
                      ) : null}
                    </p>
                    <dl className="conflict-values">
                      <div className={winnerLocal ? 'is-winner' : ''}>
                        <dt>
                          {t.conflicts.local}
                          {winnerLocal ? <span className="chip__tag">{t.conflicts.winner}</span> : null}
                        </dt>
                        <dd>
                          <bdi>{formatConflictValue(conflict.field, conflict.localValue, options)}</bdi>
                        </dd>
                      </div>
                      <div className={!winnerLocal ? 'is-winner' : ''}>
                        <dt>
                          {t.conflicts.remote}
                          {!winnerLocal ? <span className="chip__tag">{t.conflicts.winner}</span> : null}
                        </dt>
                        <dd>
                          <bdi>{formatConflictValue(conflict.field, conflict.remoteValue, options)}</bdi>
                        </dd>
                      </div>
                    </dl>
                    <div className="row-actions">
                      {canResolve ? (
                        <>
                          <button type="button" className="button button--small" disabled={busy !== null} onClick={() => void act(conflict, onRestore, t.conflicts.restored)} data-testid="conflict-restore">
                            {busy === conflict.id ? <LoaderCircle className="icon spin" aria-hidden="true" /> : <RotateCcw className="icon" aria-hidden="true" />}
                            {t.conflicts.restore}
                          </button>
                          <button type="button" className="button button--small" disabled={busy !== null} onClick={() => void act(conflict, onDismiss, t.conflicts.dismissed)} data-testid="conflict-dismiss">
                            <Check className="icon" aria-hidden="true" />
                            {t.conflicts.dismiss}
                          </button>
                        </>
                      ) : null}
                      {located ? (
                        <button type="button" className="button button--small button--ghost" onClick={() => onGoTo(conflict.uid, conflict.field)}>
                          <LocateFixed className="icon" aria-hidden="true" />
                          {t.rowSync.goToRow}
                        </button>
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </section>
      <section className="side-panel__section" aria-labelledby={`${ids}-attention`} data-testid="attention-list">
        <h3 id={`${ids}-attention`}>{t.rowSync.attentionTitle}</h3>
        {attention.length === 0 ? (
          <p className="muted small">{t.rowSync.attentionEmpty}</p>
        ) : (
          <ul className="panel-list">
            {attention.map((a) => (
              <li key={a.uid} className="panel-item" data-uid={a.uid} data-state={a.state}>
                <div className="row-tooltip__head">
                  <StateLabel state={a.state} />
                  <span className="muted small">
                    <bdi>{a.sheetTitle}</bdi> · <bdi className="num">{t.rowSync.row(a.row + 1)}</bdi>
                  </span>
                </div>
                {a.title ? (
                  <p className="panel-item__title">
                    <bdi>{a.title}</bdi>
                  </p>
                ) : null}
                {a.message ? <p className="small">{a.message}</p> : null}
                {a.state === 'deleted' ? <p className="small">{t.rowSync.deletedBody}</p> : null}
                <div className="row-actions">
                  <button type="button" className="button button--small button--ghost" onClick={() => onGoTo(a.uid)}>
                    <LocateFixed className="icon" aria-hidden="true" />
                    {t.rowSync.goToRow}
                  </button>
                  {a.bcUrl ? (
                    <a className="button button--small button--ghost" href={a.bcUrl} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="icon" aria-hidden="true" />
                      {t.rowSync.openInBasecamp}
                    </a>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </dialog>
  )
}

/** Above the grid on a synced sheet: Tab / Shift+Tab as buttons, collapse, progress, files, details, the panel. */
export function SyncToolbar({
  active,
  canWrite,
  counts,
  rowCounts,
  onIndent,
  onOutdent,
  onToggleCollapse,
  onOpenPanel,
  onOpenAttachments,
  onOpenDetails,
  children,
}: {
  active: ActiveTask | null
  canWrite: boolean
  counts: { error: number; conflict: number; pending: number } | null
  /** Phase 5: the selected row's files and its to-do's comments. */
  rowCounts?: { attachments: number; comments: number | null } | null
  onIndent: () => void
  onOutdent: () => void
  onToggleCollapse: () => void
  onOpenPanel: () => void
  onOpenAttachments?: () => void
  onOpenDetails?: () => void
  children?: ReactNode
}) {
  const task = active?.task ?? null
  const hasFamily = (active?.family.rows.length ?? 0) > 0
  const attention = (counts?.error ?? 0) + (counts?.conflict ?? 0)
  return (
    <div className="sync-toolbar" role="toolbar" aria-label={t.hierarchy.groupLabel} data-testid="sync-toolbar">
      <button type="button" className="button button--small" onClick={onIndent} disabled={!canWrite || !task || task.level === 1} data-testid="indent-button" title="Tab">
        <ListIndentIncrease className="icon mirror" aria-hidden="true" />
        <span className="sync-toolbar__label">{t.hierarchy.indent}</span>
      </button>
      <button type="button" className="button button--small" onClick={onOutdent} disabled={!canWrite || !task || task.level === 0} data-testid="outdent-button" title="Shift+Tab">
        <ListIndentDecrease className="icon mirror" aria-hidden="true" />
        <span className="sync-toolbar__label">{t.hierarchy.outdent}</span>
      </button>
      <button type="button" className="button button--small" onClick={onToggleCollapse} disabled={!hasFamily} aria-pressed={active?.family.collapsed ?? false} data-testid="collapse-button">
        {active?.family.collapsed ? <ChevronsUpDown className="icon" aria-hidden="true" /> : <ChevronsDownUp className="icon" aria-hidden="true" />}
        <span className="sync-toolbar__label">{active?.family.collapsed ? t.hierarchy.expand : t.hierarchy.collapse}</span>
      </button>
      {active?.progress && active.progress.total > 0 ? (
        <span className="badge badge--neutral" data-testid="toolbar-progress" title={t.hierarchy.progressLabel}>
          <bdi className="num">{t.hierarchy.progress(active.progress.done, active.progress.total)}</bdi>
        </span>
      ) : null}
      <span className="sync-toolbar__spacer" />
      {onOpenAttachments ? (
        <button type="button" className="button button--small" onClick={onOpenAttachments} disabled={!task} aria-haspopup="dialog" data-testid="attachments-button" title={t.attachments.title}>
          <Paperclip className="icon" aria-hidden="true" />
          <span className="sync-toolbar__label">{t.attachments.title}</span>
          {(rowCounts?.attachments ?? 0) > 0 ? (
            <span className="badge badge--neutral">
              <bdi className="num">{formatCount(rowCounts?.attachments ?? 0)}</bdi>
            </span>
          ) : null}
        </button>
      ) : null}
      {onOpenDetails ? (
        <button type="button" className="button button--small" onClick={onOpenDetails} disabled={!task} aria-haspopup="dialog" data-testid="details-button" title={t.details.buttonHint}>
          <MessageSquare className="icon" aria-hidden="true" />
          <span className="sync-toolbar__label">{t.details.button}</span>
          {(rowCounts?.comments ?? 0) > 0 ? (
            <span className="badge badge--info" data-testid="details-button-count" aria-label={t.comments.count(rowCounts?.comments ?? 0)}>
              <bdi className="num">{formatCount(rowCounts?.comments ?? 0)}</bdi>
            </span>
          ) : null}
        </button>
      ) : null}
      {children}
      <button type="button" className="button button--small" onClick={onOpenPanel} aria-haspopup="dialog" data-testid="sync-panel-button">
        <Activity className="icon" aria-hidden="true" />
        <span className="sync-toolbar__label">{t.rowSync.panelButton}</span>
        {attention > 0 ? (
          <span className="badge badge--danger">
            <bdi className="num">{attention}</bdi>
          </span>
        ) : null}
      </button>
    </div>
  )
}
