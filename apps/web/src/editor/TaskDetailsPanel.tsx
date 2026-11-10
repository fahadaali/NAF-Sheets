// «تفاصيل المهمة» (spec §12.1 item 5), a side panel for the selected row of a
// synced sheet: its files (downloads for everyone; «إدارة المرفقات» for those
// who may edit), and its Basecamp comments — read, and added with the
// person's own token. A subtask's row shows its to-do's comments, and says so
// (§8 table: comments live on to-dos only). A viewer reads only.
//
// OPEN: the panel holds files and comments only; the other parts of §12.1
// item 5 (all fields, subtasks, the row's change history) are later work
// (apps/web/OPEN_QUESTIONS.md #56).

import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ExternalLink, LoaderCircle, MessageSquare, Paperclip, Send, X } from 'lucide-react'
import { COMMENT_MAX_LENGTH } from '@naf-sheets/shared'
import type { CommentInfo, TaskAttachmentsResponse, TaskCommentsResponse } from '@naf-sheets/shared'
import { api, ApiRequestError, basecampStartUrl, currentPath, errorMessage, isAbortError } from '../lib/api'
import { formatCount, formatDateTime } from '../lib/format'
import { Notice } from '../components/Notice'
import { t } from '../strings'
import { commentProblem, formatBytes } from '../attachments/model'
import type { TaskTarget } from './sync-layer'

type Load<T> = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; message: string; relink: boolean } | { kind: 'ready'; data: T }

const LINK_CODES = new Set(['basecamp_not_linked', 'basecamp_link_expired', 'basecamp_link_revoked'])

function failed<T>(e: unknown): Load<T> {
  return { kind: 'error', message: errorMessage(e), relink: e instanceof ApiRequestError && LINK_CODES.has(e.code) }
}

export function TaskDetailsPanel({
  open,
  target,
  workbookId,
  canWrite,
  bcUrl,
  onClose,
  onManageAttachments,
  onChanged,
}: {
  open: boolean
  target: TaskTarget | null
  workbookId: string
  /** The grid takes edits now. */
  canWrite: boolean
  bcUrl: string | null
  onClose: () => void
  onManageAttachments: (target: TaskTarget) => void
  /** Comments or files changed (the editor polls the rows' counts again). */
  onChanged: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const ids = useId()
  const [files, setFiles] = useState<Load<TaskAttachmentsResponse>>({ kind: 'idle' })
  const [comments, setComments] = useState<Load<TaskCommentsResponse>>({ kind: 'idle' })
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])

  const uid = open ? (target?.uid ?? null) : null
  useEffect(() => {
    setText('')
    setSendError(null)
    setSent(false)
    if (uid === null) {
      setFiles({ kind: 'idle' })
      setComments({ kind: 'idle' })
      return
    }
    const c = new AbortController()
    setFiles({ kind: 'loading' })
    setComments({ kind: 'loading' })
    api.getTaskAttachments(workbookId, uid, c.signal).then(
      (data) => setFiles({ kind: 'ready', data }),
      (e: unknown) => {
        if (!isAbortError(e)) setFiles(failed(e))
      },
    )
    api.getTaskComments(workbookId, uid, c.signal).then(
      (data) => setComments({ kind: 'ready', data }),
      (e: unknown) => {
        if (!isAbortError(e)) setComments(failed(e))
      },
    )
    return () => c.abort()
  }, [workbookId, uid, attempt])

  const thread = comments.kind === 'ready' ? comments.data : null
  const canComment = canWrite && thread !== null && thread.canComment

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!uid || sending) return
    const problem = commentProblem(text)
    if (problem) {
      setSendError(problem)
      return
    }
    setSending(true)
    setSendError(null)
    setSent(false)
    try {
      const res = await api.createComment(workbookId, uid, text.trim())
      setComments((l) => (l.kind === 'ready' ? { kind: 'ready', data: { ...l.data, comments: [...l.data.comments, res.comment], commentsCount: res.commentsCount } } : l))
      setText('')
      setSent(true)
      onChanged()
    } catch (err: unknown) {
      setSendError(errorMessage(err))
    } finally {
      setSending(false)
    }
  }

  const kind = target?.level === 1 ? t.details.subtask : t.details.todo
  return (
    <dialog ref={ref} className="side-panel details-panel" aria-labelledby={`${ids}-title`} onClose={onClose} data-testid="details-panel">
      <div className="side-panel__head">
        <h2 id={`${ids}-title`}>{t.details.title}</h2>
        <button type="button" className="icon-button" aria-label={t.details.close} title={t.details.close} onClick={onClose}>
          <X className="icon" aria-hidden="true" />
        </button>
      </div>

      {!target || target.uid === null ? (
        <section className="side-panel__section">
          <p className="muted small" data-testid="details-no-task">
            {target && target.uid === null ? t.attachments.noUid : t.details.noTask}
          </p>
        </section>
      ) : (
        <>
          <section className="side-panel__section" data-testid="details-task">
            <span className="badge badge--neutral">{kind}</span>
            <p className="panel-item__title">
              <bdi>{target.title}</bdi>
            </p>
            {bcUrl ? (
              <a className="button button--small button--ghost" href={bcUrl} target="_blank" rel="noopener noreferrer" data-testid="details-bc-link">
                <ExternalLink className="icon" aria-hidden="true" />
                {t.details.openInBasecamp}
              </a>
            ) : null}
          </section>

          <section className="side-panel__section" aria-labelledby={`${ids}-files`} data-testid="details-attachments">
            <h3 id={`${ids}-files`} className="with-icon">
              <Paperclip className="icon" aria-hidden="true" />
              {t.details.attachmentsHeading}
            </h3>
            {files.kind === 'loading' ? (
              <p className="muted small with-icon" role="status">
                <LoaderCircle className="icon spin" aria-hidden="true" />
                {t.attachments.loading}
              </p>
            ) : null}
            {files.kind === 'error' ? (
              <Notice tone="danger">
                <p>{files.message}</p>
              </Notice>
            ) : null}
            {files.kind === 'ready' ? (
              <>
                {files.data.notice ? <p className="field-hint">{files.data.notice}</p> : null}
                {files.data.attachments.length === 0 ? (
                  <p className="muted small">{t.attachments.emptyReadOnly}</p>
                ) : (
                  <ul className="attachment-list" aria-label={t.attachments.listLabel}>
                    {files.data.attachments.map((f) => (
                      <li key={f.id} className={`attachment-chip attachment-chip--${f.state}`} data-state={f.state}>
                        <Paperclip className="icon attachment-chip__icon" aria-hidden="true" />
                        <a className="attachment-chip__name" href={f.downloadPath} download={f.filename} aria-label={t.attachments.download(f.filename)}>
                          <bdi>{f.filename}</bdi>
                        </a>
                        {f.size > 0 ? (
                          <span className="muted small">
                            <bdi className="num">{formatBytes(f.size)}</bdi>
                          </span>
                        ) : null}
                        {f.state !== 'attached' ? <span className="badge badge--neutral">{t.attachments.states[f.state]}</span> : null}
                      </li>
                    ))}
                  </ul>
                )}
                {canWrite && files.data.canEdit ? (
                  <button type="button" className="button button--small" onClick={() => onManageAttachments(target)} data-testid="details-manage-attachments">
                    <Paperclip className="icon" aria-hidden="true" />
                    {t.details.manageAttachments}
                  </button>
                ) : null}
              </>
            ) : null}
          </section>

          <section className="side-panel__section" aria-labelledby={`${ids}-comments`} data-testid="details-comments">
            <h3 id={`${ids}-comments`} className="with-icon">
              <MessageSquare className="icon" aria-hidden="true" />
              {t.details.commentsHeading}
              {thread ? (
                <span className="badge badge--info" title={t.comments.countLabel} data-testid="details-comment-count">
                  <bdi className="num">{formatCount(thread.commentsCount)}</bdi>
                </span>
              ) : null}
            </h3>
            {thread?.onParent ? (
              <Notice tone="info" testId="details-on-parent">
                <p>{target.parentTitle ? t.comments.onParent(target.parentTitle) : t.comments.onParentUntitled}</p>
              </Notice>
            ) : null}
            {comments.kind === 'loading' ? (
              <p className="muted small with-icon" role="status">
                <LoaderCircle className="icon spin" aria-hidden="true" />
                {t.comments.loading}
              </p>
            ) : null}
            {comments.kind === 'error' ? (
              <Notice
                tone="danger"
                testId="details-comments-error"
                actions={
                  comments.relink ? (
                    <a className="button button--small button--primary" href={basecampStartUrl(currentPath())} data-testid="details-relink">
                      {t.basecamp.link}
                    </a>
                  ) : (
                    <button type="button" className="button button--small" onClick={() => setAttempt((n) => n + 1)}>
                      {t.comments.retry}
                    </button>
                  )
                }
              >
                <p>{comments.message}</p>
              </Notice>
            ) : null}
            {thread ? (
              thread.comments.length === 0 ? (
                <p className="muted small" data-testid="details-comments-empty">
                  {canComment ? t.comments.empty : t.comments.emptyReadOnly}
                </p>
              ) : (
                <ol className="comment-list" data-testid="comment-list">
                  {thread.comments.map((c) => (
                    <CommentItem key={c.id} comment={c} />
                  ))}
                </ol>
              )
            ) : null}
            {thread && canComment ? (
              <form className="comment-form" onSubmit={(e) => void submit(e)} noValidate data-testid="comment-form">
                <label htmlFor={`${ids}-new`} className="picker__label">
                  {thread.onParent ? t.comments.labelOnParent : t.comments.label}
                </label>
                <textarea
                  id={`${ids}-new`}
                  value={text}
                  maxLength={COMMENT_MAX_LENGTH}
                  placeholder={t.comments.placeholder}
                  onChange={(e) => {
                    setText(e.target.value)
                    setSent(false)
                  }}
                  aria-invalid={sendError !== null}
                  data-testid="comment-input"
                />
                {sendError ? (
                  <Notice tone="danger" testId="comment-error">
                    <p>{sendError}</p>
                  </Notice>
                ) : null}
                {sent ? (
                  <p className="small" role="status" data-testid="comment-sent">
                    {t.comments.sent}
                  </p>
                ) : null}
                <div className="dialog__actions">
                  <button type="submit" className="button button--primary" disabled={sending} data-testid="comment-send">
                    {sending ? <LoaderCircle className="icon spin" aria-hidden="true" /> : <Send className="icon mirror" aria-hidden="true" />}
                    {sending ? t.comments.sending : t.comments.send}
                  </button>
                </div>
              </form>
            ) : null}
            {thread && !canComment ? (
              <p className="field-hint" data-testid="comment-read-only">
                {t.comments.readOnly}
              </p>
            ) : null}
          </section>
        </>
      )}
    </dialog>
  )
}

function CommentItem({ comment }: { comment: CommentInfo }) {
  const when = formatDateTime(comment.createdAt)
  return (
    <li className="comment" data-comment-id={comment.id}>
      <div className="comment__head">
        {comment.creatorAvatarUrl ? <img className="avatar" src={comment.creatorAvatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : null}
        <strong>
          <bdi>{comment.creatorName || t.comments.unknownAuthor}</bdi>
        </strong>
        {when ? (
          <span className="muted small">
            <bdi dir="ltr" className="num">
              {when}
            </bdi>
          </span>
        ) : null}
        {comment.appUrl ? (
          <a className="icon-button comment__link" href={comment.appUrl} target="_blank" rel="noopener noreferrer" aria-label={t.comments.openComment} title={t.comments.openComment}>
            <ExternalLink className="icon" aria-hidden="true" />
          </a>
        ) : null}
      </div>
      <p className="comment__text">
        <bdi>{comment.text}</bdi>
      </p>
      {comment.attachments.length > 0 ? (
        <p className="small muted with-icon" aria-label={t.comments.attachments}>
          <Paperclip className="icon" aria-hidden="true" />
          <bdi>{comment.attachments.join('، ')}</bdi>
        </p>
      ) : null}
    </li>
  )
}
