// The attachment cell editor (spec §5.2 «محرّر خلية المرفقات: رقائق للملفات +
// زر رفع + سحب وإفلات», §10): the row's files as chips (download, remove after
// a confirmation), an upload button, drag and drop, progress per file, errors,
// and keyboard access (Tab between chips, Delete on a chip to remove it).
//
// It opens as a dialog over the grid, like the assignee editor
// (apps/web/OPEN_QUESTIONS.md #39, #55). The files themselves live in the API;
// the attachments cell shows their names and the server writes it.

import { useEffect, useId, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent } from 'react'
import { Check, CircleX, Cloud, Download, HardDrive, LoaderCircle, Paperclip, RotateCcw, Trash2, Upload, X } from 'lucide-react'
import type { AttachmentInfo, TaskAttachmentsResponse } from '@naf-sheets/shared'
import { api, errorMessage, isAbortError } from '../lib/api'
import { uploadAttachment } from '../lib/upload'
import { Notice } from '../components/Notice'
import { t } from '../strings'
import { checkFile, dragHasFiles, filesOf, focusAfterRemoval, formatBytes, removalSentence, stateTone, uploadPercent, type UploadItem } from '../attachments/model'
import type { TaskTarget } from './sync-layer'

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: TaskAttachmentsResponse }

const STATE_ICON = { attached: Cloud, uploading: LoaderCircle, local_only: HardDrive, failed: CircleX } as const

export function AttachmentEditor({
  target,
  workbookId,
  canWrite,
  onClose,
  onChanged,
}: {
  target: TaskTarget
  workbookId: string
  /** The grid takes edits now (role, room, Basecamp link lock). */
  canWrite: boolean
  onClose: () => void
  /** The list changed (the editor polls the rows' counts again). */
  onChanged?: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const ids = useId()
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [uploads, setUploads] = useState<UploadItem[]>([])
  const [confirm, setConfirm] = useState<AttachmentInfo | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [announce, setAnnounce] = useState('')
  const [dragging, setDragging] = useState(false)
  const controller = useRef(new AbortController())
  const queue = useRef<Promise<void>>(Promise.resolve())
  const counter = useRef(0)
  const focusNext = useRef<string | null>(null)

  useEffect(() => {
    ref.current?.showModal()
    const abort = controller.current
    return () => abort.abort()
  }, [])

  useEffect(() => {
    if (target.uid === null) return
    const c = new AbortController()
    api.getTaskAttachments(workbookId, target.uid, c.signal).then(
      (data) => setLoad({ kind: 'ready', data }),
      (e: unknown) => {
        if (!isAbortError(e)) setLoad({ kind: 'error', message: errorMessage(e) })
      },
    )
    return () => c.abort()
  }, [workbookId, target.uid])

  // After a removal, the focus goes to the neighbouring chip (or the upload button).
  useEffect(() => {
    if (load.kind !== 'ready' || confirm !== null) return
    const next = focusNext.current
    if (next === null) return
    focusNext.current = null
    const el = next === '' ? null : listRef.current?.querySelector<HTMLElement>(`[data-attachment-id="${CSS.escape(next)}"] a`)
    ;(el ?? inputRef.current?.parentElement?.querySelector<HTMLElement>('[data-testid="attachment-upload"]'))?.focus()
  }, [load, confirm])

  const data = load.kind === 'ready' ? load.data : null
  const editable = canWrite && data !== null && data.canEdit && target.uid !== null

  const setFiles = (attachments: AttachmentInfo[]) => setLoad((l) => (l.kind === 'ready' ? { kind: 'ready', data: { ...l.data, attachments } } : l))
  const patchUpload = (key: string, patch: Partial<UploadItem>) => setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...patch } : u)))

  const send = (files: File[]) => {
    if (!data || !editable || target.uid === null) return
    const uid = target.uid
    for (const file of files) {
      const key = `u-${++counter.current}`
      const problem = checkFile(file, data.settings.maxBytes)
      setUploads((list) => [...list, { key, name: file.name, size: file.size, loaded: 0, phase: problem ? 'error' : 'uploading', message: problem }])
      if (problem) continue
      // One at a time: each upload rewrites the same to-do's description in Basecamp.
      queue.current = queue.current.then(() =>
        uploadAttachment(workbookId, uid, file, { signal: controller.current.signal, onProgress: (loaded) => patchUpload(key, { loaded }) }).then(
          (res) => {
            setUploads((list) => list.filter((u) => u.key !== key))
            setFiles(res.attachments)
            setAnnounce(t.attachments.uploaded(res.attachment.filename))
            onChanged?.()
          },
          (e: unknown) => {
            if (isAbortError(e)) return
            patchUpload(key, { phase: 'error', message: errorMessage(e) })
          },
        ),
      )
    }
  }

  const remove = async (file: AttachmentInfo) => {
    setBusy(file.id)
    setActionError(null)
    try {
      const next = await api.removeAttachment(workbookId, file.id)
      focusNext.current = focusAfterRemoval((data?.attachments ?? []).map((a) => a.id), file.id) ?? ''
      setLoad({ kind: 'ready', data: next })
      setAnnounce(t.attachments.removed(file.filename))
      onChanged?.()
    } catch (e: unknown) {
      setActionError(errorMessage(e))
    } finally {
      setBusy(null)
      setConfirm(null)
    }
  }

  const retry = async (file: AttachmentInfo) => {
    setBusy(file.id)
    setActionError(null)
    try {
      setFiles((await api.retryAttachment(workbookId, file.id)).attachments)
      onChanged?.()
    } catch (e: unknown) {
      setActionError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const onDrag = (e: DragEvent) => {
    if (!editable || !dragHasFiles(e.dataTransfer?.types)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (e.type === 'dragenter' || e.type === 'dragover') setDragging(true)
  }
  const onDragLeave = (e: DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setDragging(false)
  }
  const onDrop = (e: DragEvent) => {
    setDragging(false)
    if (!editable || !dragHasFiles(e.dataTransfer?.types)) return
    e.preventDefault()
    send(filesOf(e.dataTransfer.files))
  }

  const onChipKey = (file: AttachmentInfo) => (e: KeyboardEvent) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && editable && busy === null) {
      e.preventDefault()
      setConfirm(file)
    }
  }

  return (
    <dialog ref={ref} className="dialog picker attachments" aria-labelledby={`${ids}-title`} onClose={onClose} data-testid="attachment-editor">
      <div
        className={`dialog__body attachments__body${dragging ? ' is-dragging' : ''}`}
        onDragEnter={onDrag}
        onDragOver={onDrag}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        data-testid="attachment-dropzone"
        data-dragging={dragging ? 'true' : 'false'}
      >
        <div className="picker__head">
          <h2 id={`${ids}-title`} className="with-icon">
            <Paperclip className="icon" aria-hidden="true" />
            {t.attachments.title}
          </h2>
          <button type="button" className="icon-button" aria-label={t.attachments.close} title={t.attachments.close} onClick={onClose}>
            <X className="icon" aria-hidden="true" />
          </button>
        </div>
        {target.title ? (
          <p className="muted small">
            <bdi>{target.title}</bdi>
          </p>
        ) : null}
        <p className="sr-only" role="status" aria-live="polite" data-testid="attachment-announce">
          {announce}
        </p>

        {target.uid === null ? (
          <Notice tone="info" testId="attachment-no-uid">
            <p>{t.attachments.noUid}</p>
          </Notice>
        ) : null}
        {target.uid !== null && load.kind === 'loading' ? (
          <p className="muted with-icon" role="status">
            <LoaderCircle className="icon spin" aria-hidden="true" />
            {t.attachments.loading}
          </p>
        ) : null}
        {load.kind === 'error' ? (
          <Notice tone="danger" testId="attachment-load-error">
            <p>{load.message}</p>
          </Notice>
        ) : null}
        {data?.notice ? (
          <Notice tone="info" testId="attachment-notice">
            <p>{data.notice}</p>
          </Notice>
        ) : null}

        {data && confirm ? (
          <section className="stack" role="alertdialog" aria-labelledby={`${ids}-confirm`} aria-describedby={`${ids}-confirm-body`} data-testid="attachment-confirm">
            <h3 id={`${ids}-confirm`} className="with-icon">
              <Trash2 className="icon" aria-hidden="true" />
              {t.attachments.confirmTitle}
            </h3>
            <p id={`${ids}-confirm-body`}>{removalSentence(confirm)}</p>
            <div className="dialog__actions">
              <button type="button" className="button button--danger" onClick={() => void remove(confirm)} disabled={busy !== null} data-testid="attachment-confirm-remove">
                {busy === confirm.id ? <LoaderCircle className="icon spin" aria-hidden="true" /> : <Trash2 className="icon" aria-hidden="true" />}
                {t.attachments.confirm}
              </button>
              <button type="button" className="button" onClick={() => setConfirm(null)} disabled={busy !== null} autoFocus data-testid="attachment-confirm-cancel">
                {t.attachments.cancel}
              </button>
            </div>
          </section>
        ) : null}

        {data && !confirm ? (
          <>
            {data.attachments.length === 0 && uploads.length === 0 ? (
              <p className="muted small" data-testid="attachment-empty">
                {editable ? t.attachments.empty : t.attachments.emptyReadOnly}
              </p>
            ) : null}
            {data.attachments.length > 0 ? (
              <ul ref={listRef} className="attachment-list" aria-label={t.attachments.listLabel} data-testid="attachment-chips">
                {data.attachments.map((file) => {
                  const StateIcon = STATE_ICON[file.state]
                  return (
                    <li key={file.id} className={`attachment-chip attachment-chip--${file.state}`} data-attachment-id={file.id} data-state={file.state} onKeyDown={onChipKey(file)}>
                      <Paperclip className="icon attachment-chip__icon" aria-hidden="true" />
                      <a className="attachment-chip__name" href={file.downloadPath} download={file.filename} title={t.attachments.download(file.filename)} aria-label={t.attachments.download(file.filename)}>
                        <bdi>{file.filename}</bdi>
                      </a>
                      {file.size > 0 ? (
                        <span className="muted small">
                          <bdi className="num">{formatBytes(file.size)}</bdi>
                        </span>
                      ) : null}
                      <span className={`badge badge--${stateTone(file.state)}`} data-testid="attachment-state">
                        <StateIcon className={file.state === 'uploading' ? 'icon spin' : 'icon'} aria-hidden="true" />
                        {t.attachments.states[file.state]}
                      </span>
                      <Download className="icon muted" aria-hidden="true" />
                      {file.state === 'failed' && editable ? (
                        <button type="button" className="button button--small" onClick={() => void retry(file)} disabled={busy !== null} data-testid="attachment-retry">
                          {busy === file.id ? <LoaderCircle className="icon spin" aria-hidden="true" /> : <RotateCcw className="icon" aria-hidden="true" />}
                          {t.attachments.retry}
                        </button>
                      ) : null}
                      {editable ? (
                        <button type="button" className="chip__remove attachment-chip__remove" aria-label={t.attachments.remove(file.filename)} title={t.attachments.remove(file.filename)} onClick={() => setConfirm(file)} disabled={busy !== null} data-testid="attachment-remove">
                          <X className="icon" aria-hidden="true" />
                        </button>
                      ) : null}
                      {file.state === 'failed' && file.message ? <p className="attachment-chip__message small">{file.message}</p> : null}
                    </li>
                  )
                })}
              </ul>
            ) : null}

            {uploads.length > 0 ? (
              <ul className="upload-list" aria-label={t.attachments.uploadsLabel} data-testid="attachment-uploads">
                {uploads.map((u) => (
                  <li key={u.key} className={`upload-item upload-item--${u.phase}`} data-phase={u.phase}>
                    <div className="upload-item__head">
                      {u.phase === 'uploading' ? <LoaderCircle className="icon spin" aria-hidden="true" /> : <CircleX className="icon" aria-hidden="true" />}
                      <bdi className="upload-item__name">{u.name}</bdi>
                      {u.phase === 'uploading' ? (
                        <span className="small muted">
                          <bdi className="num">{t.attachments.progress(uploadPercent(u))}</bdi>
                        </span>
                      ) : (
                        <button type="button" className="icon-button" aria-label={t.attachments.dismiss} title={t.attachments.dismiss} onClick={() => setUploads((list) => list.filter((x) => x.key !== u.key))}>
                          <X className="icon" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                    {u.phase === 'uploading' ? (
                      <progress className="upload-item__progress" max={100} value={uploadPercent(u)} aria-label={`${t.attachments.uploading} ${u.name}`} />
                    ) : (
                      <p className="small upload-item__error" role="alert">
                        {u.message}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}

            {actionError ? (
              <Notice tone="danger" testId="attachment-error">
                <p>{actionError}</p>
              </Notice>
            ) : null}

            {editable ? (
              <div className={`dropzone${dragging ? ' is-active' : ''}`}>
                <p className="small">{dragging ? t.attachments.dropActive : t.attachments.dropHint}</p>
                <input
                  ref={inputRef}
                  type="file"
                  multiple
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(e) => {
                    send(filesOf(e.currentTarget.files))
                    e.currentTarget.value = ''
                  }}
                  data-testid="attachment-input"
                />
                <button type="button" className="button button--primary" onClick={() => inputRef.current?.click()} data-testid="attachment-upload">
                  <Upload className="icon" aria-hidden="true" />
                  {t.attachments.upload}
                </button>
                <p className="field-hint">
                  <bdi>{t.attachments.limit(formatBytes(data.settings.maxBytes))}</bdi>
                </p>
                {data.attachments.length > 0 ? <p className="field-hint">{t.attachments.keyboardHint}</p> : null}
              </div>
            ) : (
              <p className="field-hint" data-testid="attachment-read-only">
                {t.attachments.readOnly}
              </p>
            )}

            <div className="dialog__actions">
              <button type="button" className="button" onClick={onClose} data-testid="attachment-done">
                <Check className="icon" aria-hidden="true" />
                {t.attachments.close}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </dialog>
  )
}
