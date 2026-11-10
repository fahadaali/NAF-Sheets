// Workbook editor (spec §12.1 item 2). Loaded lazily from App.tsx: this module
// is the only way into Univer, so the files screen never downloads it.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowRight, CloudCheck, CloudOff, CloudUpload, Eye, FileSpreadsheet, LoaderCircle, TriangleExclamationPoint } from 'lucide-react'
import type { WorkbookResponse } from '@naf-sheets/shared'
import { api, classifySaveError, errorMessage, isAbortError } from '../lib/api'
import { Autosave } from '../lib/autosave'
import type { SaveStatus } from '../lib/autosave'
import { Link, setLeaveGuard } from '../lib/router'
import { useDocumentTitle } from '../lib/use-document-title'
import { Notice } from '../components/Notice'
import { SyncBadge } from '../components/SyncBadge'
import { t } from '../strings'
import { mountWorkbook } from './univer-host'
import type { MountedWorkbook, RtlState } from './univer-host'
import { resolveWorkbookData } from './workbook-data'

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: WorkbookResponse }

export default function EditorScreen({ id }: { id: string }) {
  const [attempt, setAttempt] = useState(0)
  const [load, setLoad] = useState<Load>({ kind: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    setLoad({ kind: 'loading' })
    api.getWorkbook(id, controller.signal).then(
      (data) => setLoad({ kind: 'ready', data }),
      (error: unknown) => {
        if (!isAbortError(error)) setLoad({ kind: 'error', message: errorMessage(error) })
      },
    )
    return () => controller.abort()
  }, [id, attempt])

  useDocumentTitle(load.kind === 'ready' ? load.data.workbook.title : null)
  const reload = () => setAttempt((n) => n + 1)

  if (load.kind === 'ready') return <WorkbookEditor key={attempt} data={load.data} onReload={reload} />

  return (
    <div className="editor" data-screen="editor">
      <EditorBar title={null} />
      {load.kind === 'loading' ? (
        <div className="panel panel--plain editor-message" role="status">
          <LoaderCircle className="panel__icon spin" aria-hidden="true" />
          <p>{t.editor.loading}</p>
        </div>
      ) : (
        <div className="editor-message">
          <Notice
            tone="danger"
            testId="editor-load-error"
            actions={
              <>
                <button type="button" className="button button--small" onClick={reload}>
                  {t.files.retry}
                </button>
                <Link href="/" className="button button--small">
                  {t.editor.back}
                </Link>
              </>
            }
          >
            <p>{load.message}</p>
          </Notice>
        </div>
      )}
    </div>
  )
}

function EditorBar({ title, children }: { title: string | null; children?: ReactNode }) {
  return (
    <header className="editor-bar">
      {/* Back points to the start of the line: right in RTL. */}
      <Link href="/" className="icon-button" aria-label={t.editor.back} title={t.editor.back}>
        <ArrowRight className="icon" aria-hidden="true" />
      </Link>
      <FileSpreadsheet className="icon editor-bar__icon" aria-hidden="true" />
      {title !== null ? (
        <h1 className="editor-bar__title">
          <bdi>{title}</bdi>
        </h1>
      ) : null}
      {children}
    </header>
  )
}

type Engine = 'starting' | 'ready' | 'failed'

function WorkbookEditor({ data, onReload }: { data: WorkbookResponse; onReload: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const autosaveRef = useRef<Autosave | null>(null)
  const resolved = useMemo(() => resolveWorkbookData(data), [data])
  // Workbook viewers never save (spec §3); the API refuses their writes too.
  const canEdit = data.workbook.access !== 'viewer'
  const [engine, setEngine] = useState<Engine>('starting')
  const [rtl, setRtl] = useState<RtlState | null>(null)
  const [save, setSave] = useState<SaveStatus>({ phase: 'saved', version: data.version, message: null })

  useEffect(() => {
    const host = hostRef.current
    if (!resolved.ok || !host) return
    let cancelled = false
    let mounted: MountedWorkbook | null = null
    let autosave: Autosave | null = null

    mountWorkbook(host, resolved.data, {
      isCancelled: () => cancelled,
      onRtlStatus: (state) => {
        if (!cancelled) setRtl(state)
      },
    }).then(
      (workbook) => {
        if (!workbook) return
        if (cancelled) {
          workbook.dispose()
          return
        }
        mounted = workbook
        if (!canEdit) {
          workbook.setEditable(false)
        } else {
          const saver = new Autosave({
            initialVersion: data.version,
            save: (baseVersion, snapshot) => api.saveSnapshot(data.workbook.id, { baseVersion, snapshot }).then((r) => r.version),
            getSnapshot: () => workbook.snapshot(),
            classifyError: classifySaveError,
            onStatus: (status) => {
              if (cancelled) return
              setSave(status)
              // Never let further edits pile up on a version that cannot be saved.
              // OPEN: unsaved edits are dropped on reload (OPEN_QUESTIONS.md #11).
              if (status.phase === 'conflict') workbook.setEditable(false)
            },
          })
          autosave = saver
          autosaveRef.current = saver
          workbook.onChange(() => saver.markChanged())
        }
        setEngine('ready')
      },
      (error: unknown) => {
        console.error('[editor] Univer failed to start', error)
        if (!cancelled) setEngine('failed')
      },
    )

    return () => {
      cancelled = true
      autosaveRef.current = null
      // Reads the snapshot synchronously, then the editor can go.
      if (autosave) void autosave.finalize()
      mounted?.dispose()
    }
    // Mounted once per WorkbookEditor; a reload remounts it with a new key.
  }, [])

  // Unsaved work: the browser asks before closing the tab; in-app navigation
  // asks only when a save failed (otherwise leaving saves it).
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!autosaveRef.current?.hasUnsavedChanges) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    setLeaveGuard(() => {
      const saver = autosaveRef.current
      if (!saver?.hasUnsavedChanges) return true
      const { phase } = saver.status
      return phase === 'error' || phase === 'conflict' ? window.confirm(t.editor.leaveUnsaved) : true
    })
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      setLeaveGuard(null)
    }
  }, [])

  const { workbook } = data

  return (
    <div className="editor" data-screen="editor" data-workbook-id={workbook.id} data-save-phase={save.phase} data-save-version={save.version}>
      <EditorBar title={workbook.title}>
        {!canEdit ? (
          <span className="badge badge--neutral">
            <Eye className="icon" aria-hidden="true" />
            {t.editor.readOnlyBadge}
          </span>
        ) : null}
        <div className="editor-bar__end">
          {canEdit && resolved.ok ? <SaveIndicator status={save} /> : null}
          <SyncBadge state={workbook.syncState} />
        </div>
      </EditorBar>

      <div className="editor-notices">
        {!canEdit ? (
          <Notice tone="info" testId="editor-read-only">
            <p>{t.editor.readOnlyBanner}</p>
          </Notice>
        ) : null}
        {save.phase === 'conflict' ? (
          <Notice
            tone="danger"
            testId="editor-conflict"
            actions={
              <button type="button" className="button button--small" onClick={onReload}>
                {t.editor.reload}
              </button>
            }
          >
            <p>{save.message ?? t.editor.conflictFallback}</p>
            <p>{t.editor.conflictLocked}</p>
          </Notice>
        ) : null}
        {save.phase === 'error' ? (
          <Notice
            tone="danger"
            testId="editor-save-error"
            actions={
              <button type="button" className="button button--small" onClick={() => void autosaveRef.current?.saveNow()}>
                {t.editor.saveRetry}
              </button>
            }
          >
            <p>{save.message}</p>
          </Notice>
        ) : null}
        {rtl && !rtl.mirrored ? (
          <Notice tone="warning" title={t.editor.rtlBannerTitle} testId="editor-rtl-off">
            <p>{t.editor.rtlBannerBody}</p>
            {rtl.reason ? (
              <details>
                <summary>{t.editor.rtlTechnical}</summary>
                <bdi dir="ltr">{rtl.reason}</bdi>
              </details>
            ) : null}
          </Notice>
        ) : null}
        {!resolved.ok ? (
          <Notice tone="danger" testId="editor-invalid">
            <p>{t.editor.invalidSnapshot}</p>
          </Notice>
        ) : null}
        {engine === 'failed' ? (
          <Notice
            tone="danger"
            testId="editor-engine-failed"
            actions={
              <button type="button" className="button button--small" onClick={() => window.location.reload()}>
                {t.editor.reloadPage}
              </button>
            }
          >
            <p>{t.editor.engineFailed}</p>
          </Notice>
        ) : null}
      </div>

      {resolved.ok ? (
        <div className="editor-stage">
          <div
            ref={hostRef}
            className="editor-host"
            data-testid="univer-host"
            data-engine={engine}
            data-rtl-mirrored={rtl === null ? 'pending' : String(rtl.mirrored)}
          />
          {engine === 'starting' ? (
            <div className="editor-overlay" role="status">
              <LoaderCircle className="icon spin" aria-hidden="true" />
              {t.editor.starting}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  const look = {
    saved: { Icon: CloudCheck, label: t.editor.save.saved, spin: false },
    pending: { Icon: CloudUpload, label: t.editor.save.pending, spin: false },
    saving: { Icon: LoaderCircle, label: t.editor.save.saving, spin: true },
    error: { Icon: CloudOff, label: t.editor.save.error, spin: false },
    conflict: { Icon: TriangleExclamationPoint, label: t.editor.save.conflict, spin: false },
  }[status.phase]
  const { Icon } = look
  return (
    <span className={`save-status save-status--${status.phase}`} role="status" aria-live="polite" data-testid="save-status">
      <Icon className={look.spin ? 'icon spin' : 'icon'} aria-hidden="true" />
      {look.label}
    </span>
  )
}
