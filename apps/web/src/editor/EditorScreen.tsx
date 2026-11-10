// Workbook editor (spec §12.1 item 2). Loaded lazily from App.tsx: this module
// is the only way into Univer, so the files screen never downloads it.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowRight, CloudCheck, CloudOff, CloudUpload, Eye, FileSpreadsheet, LayoutDashboard, LoaderCircle, Settings2, Table2, TriangleExclamationPoint } from 'lucide-react'
import type { AssigneeOptionsResponse, ConflictRecord, SaveSnapshotRequest, WorkbookResponse, WorkbookSyncResponse } from '@naf-sheets/shared'
import { api, classifySaveError, errorMessage, isAbortError } from '../lib/api'
import { Autosave } from '../lib/autosave'
import type { SaveStatus } from '../lib/autosave'
import type { EditorTarget } from '../lib/cell-target'
import { Link, navigate, setLeaveGuard } from '../lib/router'
import { pathFor } from '../lib/routes'
import { useDocumentTitle } from '../lib/use-document-title'
import { BasecampLinkBanner, isLinkActive, useBasecampLink } from '../components/BasecampLink'
import { Notice } from '../components/Notice'
import { SyncBadge } from '../components/SyncBadge'
import { t } from '../strings'
import { cellText } from '../sync/cells'
import { CONFLICT_FIELD_COLUMN } from '../sync/conflicts'
import { PendingDeletions, uidsInSnapshot } from '../sync/deletions'
import { prepareSyncedSheets } from '../sync/prepare'
import { Poller } from '../sync/sync-state'
import { AssigneeEditor } from './AssigneeEditor'
import { AttachmentEditor } from './AttachmentEditor'
import { TaskDetailsPanel } from './TaskDetailsPanel'
import { FileSettingsPanel } from './FileSettingsPanel'
import { SyncLayer } from './sync-layer'
import type { ActiveTask, AssigneeTarget, RemovalRequest, RowHover, TaskTarget } from './sync-layer'
import { readGridTheme } from './sync-render'
import { DeletionDialog, RowTooltip, SyncPanel, SyncToolbar } from './sync-ui'
import type { AttentionRow, PanelConflict } from './sync-ui'
import { mountWorkbook } from './univer-host'
import type { MountedWorkbook, RtlState } from './univer-host'
import { resolveWorkbookData } from './workbook-data'
import { installCollabGrid } from '../collab/grid'
import { PresenceBar } from '../collab/PresenceBar'
import { CollabSession } from '../collab/session'
import type { CollabNoticeKind, CollabView } from '../collab/session'
import { collabText } from '../collab/strings'
import { DashboardView } from '../dashboard/DashboardView'

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: WorkbookResponse }

/** A message from the realtime room for the person (Arabic). */
export interface RoomNotice {
  id: number
  message: string
  kind: CollabNoticeKind | 'locked'
}

const CONNECTING_VIEW: CollabView = { mode: 'connecting', readOnly: false, pending: 0, peers: [], locks: [] }

/** What the editor shows: the grid, or the workbook's dashboard («اللوحة», /workbooks/:id/dashboard). */
export type EditorView = 'sheets' | 'dashboard'

export default function EditorScreen({ id, target, view = 'sheets' }: { id: string; target?: EditorTarget | undefined; view?: EditorView }) {
  const [attempt, setAttempt] = useState(0)
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  // What the editor mounts: the loaded workbook, then the room's snapshot after a resync.
  // `base`: the load it belongs to, so a reload never mounts the previous load's data.
  const [mount, setMount] = useState<{ key: number; base: WorkbookResponse; data: WorkbookResponse } | null>(null)
  const [session, setSession] = useState<CollabSession | null>(null)
  const [collab, setCollab] = useState<CollabView>(CONNECTING_VIEW)
  const [roomNotice, setRoomNotice] = useState<RoomNotice | null>(null)

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

  // The realtime session (spec §11): one per loaded workbook; it survives the
  // remounts a resync causes, which replace the mounted workbook with the room's.
  // OPEN: a resync remounts the whole editor (apps/web/OPEN_QUESTIONS.md #52).
  useEffect(() => {
    if (load.kind !== 'ready') return
    const data = load.data
    setMount({ key: 0, base: data, data })
    let notices = 0
    const s = new CollabSession({
      workbookId: data.workbook.id,
      version: data.version,
      reload: (snapshot) => setMount((m) => ({ key: (m?.key ?? 0) + 1, base: data, data: { ...data, snapshot } })),
      onNotice: (message, kind) => setRoomNotice({ id: ++notices, message, kind }),
    })
    setCollab(s.view())
    const unsubscribe = s.subscribe(setCollab)
    setSession(s)
    s.start()
    return () => {
      unsubscribe()
      s.stop()
      setSession(null)
      setCollab(CONNECTING_VIEW)
      setRoomNotice(null)
    }
  }, [load])

  useDocumentTitle(load.kind === 'ready' ? load.data.workbook.title : null)
  const reload = () => setAttempt((n) => n + 1)

  if (load.kind === 'ready' && mount && mount.base === load.data)
    return (
      <WorkbookEditor
        key={`${attempt}-${mount.key}`}
        data={mount.data}
        target={target}
        view={view}
        onReload={reload}
        session={session}
        collab={collab}
        roomNotice={roomNotice}
        onRoomNotice={setRoomNotice}
      />
    )

  return (
    <div className="editor" data-screen="editor">
      <EditorBar title={null} />
      {load.kind !== 'error' ? (
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

/** Univer ids of the sheets that sync with Basecamp. */
const syncedSheetIds = (data: WorkbookResponse): ReadonlySet<string> =>
  new Set(data.sheets.filter((s) => s.syncMode === 'synced').map((s) => s.univerSheetId))

/** How long a refused command's message stays on screen. */
const REFUSAL_MS = 12_000
/** The row tooltip stays this long after the pointer left the row numbers (so it can be reached). */
const TOOLTIP_GRACE_MS = 350

type Removal = { request: RemovalRequest; resolve: (confirmed: boolean) => void }

interface WorkbookEditorProps {
  data: WorkbookResponse
  target?: EditorTarget | undefined
  view: EditorView
  onReload: () => void
  /** Null until the session started (first render). */
  session: CollabSession | null
  collab: CollabView
  roomNotice: RoomNotice | null
  onRoomNotice: (notice: RoomNotice | null) => void
}

function WorkbookEditor({ data, target, view, onReload, session, collab, roomNotice, onRoomNotice }: WorkbookEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const autosaveRef = useRef<Autosave | null>(null)
  const mountedRef = useRef<MountedWorkbook | null>(null)
  const layerRef = useRef<SyncLayer | null>(null)
  const pollerRef = useRef<Poller | null>(null)
  const deletionsRef = useRef(new PendingDeletions())
  const editableRef = useRef(false)
  const sessionRef = useRef<CollabSession | null>(session)
  sessionRef.current = session
  // Edits are shared through the room unless it could not be joined (then saved with PUT).
  const sharedRef = useRef(true)
  sharedRef.current = collab.mode !== 'unavailable'
  const lockedNotices = useRef(0)
  const theme = useMemo(() => readGridTheme(), [])
  const resolved = useMemo(() => {
    const r = resolveWorkbookData(data)
    // Synced sheets: wider row numbers for the sync state, status as a checkbox (src/sync/prepare.ts).
    return r.ok ? { ...r, data: prepareSyncedSheets(r.data, data.sheets, { rowHeaderWidth: theme.rowMarginWidth }) } : r
  }, [data, theme])
  // Workbook viewers never save (spec §3); the API refuses their writes too.
  const canEdit = data.workbook.access !== 'viewer'
  const linked = data.workbook.bcProjectId !== null
  const [engine, setEngine] = useState<Engine>('starting')
  const [rtl, setRtl] = useState<RtlState | null>(null)
  const [save, setSave] = useState<SaveStatus>({ phase: 'saved', version: data.version, message: null })
  const [activeSheet, setActiveSheet] = useState<string | null>(null)
  const [selection, setSelection] = useState<{ kind: 'none' } | { kind: 'applied'; where: string } | { kind: 'missing' }>({ kind: 'none' })
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Wave 3: synced sheets.
  const [syncInfo, setSyncInfo] = useState<WorkbookSyncResponse | null>(null)
  const [syncProblem, setSyncProblem] = useState<string | null>(null)
  const [conflicts, setConflicts] = useState<ConflictRecord[]>([])
  const [refusal, setRefusal] = useState<string | null>(null)
  const [removal, setRemoval] = useState<Removal | null>(null)
  const [assigneeTarget, setAssigneeTarget] = useState<AssigneeTarget | null>(null)
  // Phase 5: the attachment editor (§5.2) and the task details panel (§12.1 item 5).
  const [attachmentTarget, setAttachmentTarget] = useState<TaskTarget | null>(null)
  const [detailsTarget, setDetailsTarget] = useState<TaskTarget | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [rowHover, setRowHover] = useState<RowHover | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [active, setActive] = useState<ActiveTask | null>(null)
  const [people, setPeople] = useState<AssigneeOptionsResponse | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tooltipHovered = useRef(false)
  const refusalTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Spec §3: synced sheets cannot be edited before the user links their own
  // Basecamp account (local sheets can). Until the link is known to be
  // active — loading, failed, unlinked, expired, revoked — they stay read-only.
  // OPEN: the lock follows the shown sheet (apps/web/OPEN_QUESTIONS.md #18).
  const synced = useMemo(() => syncedSheetIds(data), [data])
  const needsLink = canEdit && synced.size > 0
  const basecamp = useBasecampLink(needsLink)
  const syncedLocked = needsLink && !isLinkActive(basecamp.load)
  // The room: only while joined (not a viewer, not offline or resyncing), or in the fallback.
  const roomAllows = (collab.mode === 'live' && !collab.readOnly) || collab.mode === 'unavailable'
  const editable = canEdit && roomAllows && save.phase !== 'conflict' && !(syncedLocked && activeSheet !== null && synced.has(activeSheet))
  editableRef.current = editable

  const refuse = (message: string) => {
    setRefusal(message)
    if (refusalTimer.current) clearTimeout(refusalTimer.current)
    refusalTimer.current = setTimeout(() => setRefusal(null), REFUSAL_MS)
  }

  const showRowHover = (hover: RowHover | null) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
    if (hover) {
      setRowHover(hover)
      return
    }
    hoverTimer.current = setTimeout(() => {
      if (!tooltipHovered.current) setRowHover(null)
    }, TOOLTIP_GRACE_MS)
  }

  useEffect(() => {
    const host = hostRef.current
    if (!resolved.ok || !host) return
    let cancelled = false
    let mounted: MountedWorkbook | null = null
    let autosave: Autosave | null = null
    let layer: SyncLayer | null = null
    let frame = 0

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
        mountedRef.current = workbook
        // Never editable before the lock below has been applied once.
        const firstSheet = workbook.activeSheetId()
        if (synced.size > 0 && firstSheet !== null && synced.has(firstSheet)) workbook.setEditable(false)
        setActiveSheet(firstSheet)
        workbook.onActiveSheetChange((sheetId) => {
          if (!cancelled) setActiveSheet(sheetId)
        })
        if (synced.size > 0) {
          try {
            layer = new SyncLayer(workbook.facade.univerAPI, workbook.facade.workbook, host, {
              metas: data.sheets,
              theme,
              canWrite: () => editableRef.current,
              onRefused: (message) => {
                if (!cancelled) refuse(message)
              },
              confirmRemoval: (request) =>
                new Promise<boolean>((resolve) => {
                  setRowHover(null)
                  setRemoval({ request, resolve })
                }),
              // §9.2.7: on the op that removes the rows (the room), or with the next PUT (fallback).
              onDeletionsConfirmed: (uids) => {
                const live = sessionRef.current
                if (live && sharedRef.current) live.confirmDeletions(uids)
                else deletionsRef.current.add(uids)
              },
              openAssignees: (t) => {
                if (cancelled) return
                setRowHover(null)
                setAssigneeTarget(t)
              },
              openAttachments: (target) => {
                if (cancelled) return
                setRowHover(null)
                setAttachmentTarget(target)
              },
              onRowHover: (hover) => {
                if (!cancelled) showRowHover(hover)
              },
              onActiveChange: () => {
                if (cancelled || frame) return
                frame = requestAnimationFrame(() => {
                  frame = 0
                  if (!cancelled) setActive(layer?.activeTask() ?? null)
                })
              },
            })
            layerRef.current = layer
          } catch (error) {
            console.error('[editor] the synced-sheet layer failed to start', error)
          }
        }
        if (!canEdit) {
          workbook.setEditable(false)
        } else {
          const saver = new Autosave({
            initialVersion: data.version,
            save: async (baseVersion, snapshot) => {
              // §9.2.7: rows removed after the deletion dialog, and still gone in this snapshot.
              const confirmedDeletions = deletionsRef.current.forSnapshot(uidsInSnapshot(snapshot, data.sheets))
              const body: SaveSnapshotRequest = { baseVersion, snapshot }
              if (confirmedDeletions.length > 0) body.confirmedDeletions = confirmedDeletions
              const result = await api.saveSnapshot(data.workbook.id, body)
              deletionsRef.current.acknowledge(confirmedDeletions)
              return result.version
            },
            getSnapshot: () => workbook.snapshot(),
            classifyError: classifySaveError,
            onStatus: (status) => {
              if (cancelled) return
              setSave((previous) => {
                // Right after each save, read the rows' sync state again.
                if (status.phase === 'saved' && status.version !== previous.version) pollerRef.current?.poke()
                return status
              })
              // Never let further edits pile up on a version that cannot be saved.
              // OPEN: unsaved edits are dropped on reload (OPEN_QUESTIONS.md #11).
              if (status.phase === 'conflict') workbook.setEditable(false)
            },
          })
          autosave = saver
          autosaveRef.current = saver
          // In a room session the room saves; PUT only when it could not be joined.
          workbook.onChange(() => {
            if (!sharedRef.current) saver.markChanged()
          })
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
      if (frame) cancelAnimationFrame(frame)
      autosaveRef.current = null
      mountedRef.current = null
      layerRef.current = null
      // Reads the snapshot synchronously, then the editor can go.
      if (autosave) void autosave.finalize()
      layer?.dispose()
      mounted?.dispose()
    }
    // Mounted once per WorkbookEditor; a reload remounts it with a new key.
  }, [])

  // The realtime session reads local edits from this editor and applies remote
  // ones to it; frames, presence and soft locks live in the grid.
  useEffect(() => {
    const mounted = mountedRef.current
    if (engine !== 'ready' || !mounted || !session) return
    session.attach(mounted)
    const removeGrid = installCollabGrid(mounted, session, {
      onLocked: (message) => onRoomNotice({ id: -++lockedNotices.current, message, kind: 'locked' }),
    })
    return () => {
      removeGrid()
      session.detach(mounted)
    }
  }, [engine, session])

  // While the dashboard covers the grid, the grid takes no focus or keys.
  const showDashboard = view === 'dashboard'
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    host.inert = showDashboard
    if (showDashboard) host.setAttribute('aria-hidden', 'true')
    else host.removeAttribute('aria-hidden')
  }, [showDashboard])

  // One place decides whether the grid takes edits: role, room, conflict, synced-sheet lock.
  useEffect(() => {
    if (engine === 'ready') mountedRef.current?.setEditable(editable)
    layerRef.current && setActive(layerRef.current.activeTask())
  }, [engine, editable])

  // Rows' sync state: every 10 s while the editor is open, and after each save (spec §5.2).
  useEffect(() => {
    if (engine !== 'ready' || !linked || synced.size === 0) return
    const controller = new AbortController()
    let showsConflicts = false
    const poller = new Poller(async () => {
      try {
        const info = await api.getSync(data.workbook.id, controller.signal)
        setSyncInfo(info)
        setSyncProblem(null)
        layerRef.current?.setSyncInfo(info)
        if (info.counts.conflict > 0 || showsConflicts) {
          const { conflicts: list } = await api.getConflicts(data.workbook.id, controller.signal)
          showsConflicts = list.length > 0
          setConflicts(list)
          layerRef.current?.setConflicts(list)
        }
      } catch (error) {
        if (!isAbortError(error)) setSyncProblem(errorMessage(error))
        throw error
      }
    })
    pollerRef.current = poller
    poller.start()
    return () => {
      poller.stop()
      controller.abort()
      pollerRef.current = null
    }
  }, [engine, linked, synced.size, data.workbook.id])

  // Names for conflict values (assignees arrive as ids): read once, when there are conflicts to show.
  useEffect(() => {
    if (conflicts.length === 0 || people !== null || !linked) return
    const controller = new AbortController()
    api.getAssigneeOptions(data.workbook.id, controller.signal).then(setPeople, () => undefined)
    return () => controller.abort()
  }, [conflicts.length, people, linked, data.workbook.id])

  // The place asked for in the address (import report links, spec §7.2).
  const targetKey = target ? `${target.sheet}|${target.range ? `${target.range.startRow},${target.range.startColumn},${target.range.endRow},${target.range.endColumn}` : ''}` : ''
  useEffect(() => {
    if (engine !== 'ready' || !target) return
    const where = mountedRef.current?.select(target) ?? null
    setSelection(where === null ? { kind: 'missing' } : { kind: 'applied', where })
    // `targetKey` stands for `target`.
  }, [engine, targetKey])

  /** «ربط بمشروع في Basecamp»: store pending edits first, so the wizard reads what is on screen. */
  const startWizard = async (): Promise<string | null> => {
    const saver = autosaveRef.current
    if (saver) {
      await saver.saveNow()
      if (saver.hasUnsavedChanges || saver.status.phase === 'error' || saver.status.phase === 'conflict') return t.fileSettings.saveFirstFailed
    }
    navigate(pathFor({ name: 'linkWizard', id: data.workbook.id }))
    return null
  }

  /** «مزامنة الآن» (§9.4). */
  const syncNow = async (): Promise<{ ok: boolean; message: string }> => {
    try {
      const { queued } = await api.syncNow(data.workbook.id)
      pollerRef.current?.poke()
      return { ok: true, message: t.rowSync.syncNowDone(queued) }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  }

  const resolveConflict = (run: (id: string, conflictId: string) => Promise<unknown>) => async (conflict: ConflictRecord): Promise<string | null> => {
    try {
      await run(data.workbook.id, conflict.id)
      const remaining = conflicts.filter((c) => c.id !== conflict.id)
      setConflicts(remaining)
      layerRef.current?.setConflicts(remaining)
      pollerRef.current?.poke()
      return null
    } catch (error) {
      return errorMessage(error)
    }
  }

  const goTo = (uid: string, field?: ConflictRecord['field']) => {
    const layer = layerRef.current
    const at = layer?.locate(uid)
    if (!layer || !at) return
    const mapped = field ? CONFLICT_FIELD_COLUMN[field] : null
    const column = (mapped ? at.layout.fields[mapped] : undefined) ?? at.layout.fields.title ?? 0
    setPanelOpen(false)
    layer.goTo(at.sheetId, at.row, column)
  }

  // Unsaved work: the browser asks before closing the tab; in-app navigation
  // asks only when a save failed (otherwise leaving saves it).
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const roomPending = sharedRef.current && (sessionRef.current?.view().pending ?? 0) > 0
      if (!autosaveRef.current?.hasUnsavedChanges && !roomPending) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    setLeaveGuard(() => {
      // Room edits not yet acknowledged would be lost with the connection.
      if (sharedRef.current && (sessionRef.current?.view().pending ?? 0) > 0) return window.confirm(t.editor.leaveUnsaved)
      const saver = autosaveRef.current
      if (!saver?.hasUnsavedChanges) return true
      const { phase } = saver.status
      return phase === 'error' || phase === 'conflict' ? window.confirm(t.editor.leaveUnsaved) : true
    })
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      setLeaveGuard(null)
      if (hoverTimer.current) clearTimeout(hoverTimer.current)
      if (refusalTimer.current) clearTimeout(refusalTimer.current)
    }
  }, [])

  const { workbook } = data
  const [dashboardOpened, setDashboardOpened] = useState(showDashboard)
  if (showDashboard && !dashboardOpened) setDashboardOpened(true)
  const onSyncedSheet = engine === 'ready' && activeSheet !== null && synced.has(activeSheet)

  // Phase 5: the selected row's files, and its to-do's comments (a subtask shows its parent's).
  const activeTarget = (): TaskTarget | null => (active ? (layerRef.current?.taskTarget(active.sheetId, active.row) ?? null) : null)
  const rowCounts = (() => {
    const layer = layerRef.current
    const task = active?.task
    if (!layer || !task) return null
    const own = layer.indicatorOf(task.uid)
    const todo = task.level === 1 && task.parentUid ? layer.indicatorOf(task.parentUid) : own
    return { attachments: own?.attachmentsCount ?? 0, comments: todo?.commentsCount ?? null }
  })()
  const detailsBcUrl = detailsTarget?.uid ? (layerRef.current?.indicatorOf(detailsTarget.uid)?.bcUrl ?? null) : null
  const panelData = useMemo(() => {
    const layer = layerRef.current
    if (!panelOpen || !layer) return { conflicts: [] as PanelConflict[], attention: [] as AttentionRow[] }
    const titleOf = (uid: string) => {
      const at = layer.locate(uid)
      const reader = at ? layer.reader(at.sheetId) : null
      return at && reader && at.layout.fields.title !== undefined ? cellText(reader.cell(at.row, at.layout.fields.title)).trim() : ''
    }
    const attention: AttentionRow[] = []
    for (const task of syncInfo?.tasks ?? []) {
      const state = task.remoteStatus !== 'active' ? 'deleted' : task.state
      if (state !== 'error' && state !== 'deleted' && state !== 'conflict') continue
      const at = layer.locate(task.uid)
      if (!at) continue
      const meta = data.sheets.find((s) => s.univerSheetId === at.sheetId)
      attention.push({ uid: task.uid, sheetId: at.sheetId, sheetTitle: meta?.title ?? '', row: at.row, title: titleOf(task.uid), state, message: task.message, bcUrl: task.bcUrl })
    }
    return { conflicts: conflicts.map((conflict) => ({ conflict, title: titleOf(conflict.uid), located: layer.locate(conflict.uid) !== null })), attention }
  }, [panelOpen, syncInfo, conflicts, data.sheets])

  return (
    <div
      className="editor"
      data-screen="editor"
      data-workbook-id={workbook.id}
      data-save-phase={save.phase}
      data-save-version={save.version}
      data-collab={collab.mode}
      data-room-pending={collab.pending}
      data-room-peers={collab.peers.map((p) => p.userId).join(' ')}
      data-room-locks={JSON.stringify(collab.locks.map((l) => ({ userId: l.userId, ...l.cell })))}
    >
      <EditorBar title={workbook.title}>
        <ViewTabs id={workbook.id} view={view} />
        {!canEdit ? (
          <span className="badge badge--neutral">
            <Eye className="icon" aria-hidden="true" />
            {t.editor.readOnlyBadge}
          </span>
        ) : null}
        <div className="editor-bar__end">
          {resolved.ok ? <PresenceBar view={collab} /> : null}
          {canEdit && resolved.ok && collab.mode === 'unavailable' ? <SaveIndicator status={save} /> : null}
          <SyncBadge state={syncInfo?.state ?? workbook.syncState} />
          <button
            type="button"
            className="icon-button"
            aria-label={t.editor.fileSettings}
            title={t.editor.fileSettings}
            aria-haspopup="dialog"
            onClick={() => setSettingsOpen(true)}
            data-testid="file-settings-button"
          >
            <Settings2 className="icon" aria-hidden="true" />
          </button>
        </div>
      </EditorBar>
      <FileSettingsPanel
        open={settingsOpen}
        workbook={workbook}
        onClose={() => setSettingsOpen(false)}
        onStartWizard={startWizard}
        onSyncNow={linked && canEdit && synced.size > 0 ? syncNow : undefined}
      />

      {onSyncedSheet && !showDashboard ? (
        <SyncToolbar
          active={active}
          canWrite={editable}
          counts={syncInfo?.counts ?? null}
          onIndent={() => void layerRef.current?.indentActive('indent')}
          onOutdent={() => void layerRef.current?.indentActive('outdent')}
          onToggleCollapse={() => layerRef.current?.toggleCollapse()}
          onOpenPanel={() => {
            setRowHover(null)
            setPanelOpen(true)
          }}
          rowCounts={rowCounts}
          onOpenAttachments={() => {
            const target = activeTarget()
            if (!target) return
            setRowHover(null)
            setAttachmentTarget(target)
          }}
          onOpenDetails={() => {
            setRowHover(null)
            setDetailsTarget(activeTarget())
            setDetailsOpen(true)
          }}
        />
      ) : null}

      <div className="editor-notices">
        {collab.mode === 'offline' ? (
          <Notice tone="warning" title={collabText.offlineTitle} testId="room-offline">
            <p>{collabText.offline}</p>
          </Notice>
        ) : null}
        {collab.mode === 'resyncing' ? (
          <Notice tone="info" testId="room-resyncing">
            <p>{collabText.resyncing}</p>
          </Notice>
        ) : null}
        {collab.mode === 'failed' ? (
          <Notice
            tone="danger"
            title={collabText.failedTitle}
            testId="room-failed"
            actions={
              <button type="button" className="button button--small" onClick={() => window.location.reload()}>
                {collabText.reloadPage}
              </button>
            }
          >
            <p>{roomNotice?.kind === 'failed' ? roomNotice.message : collabText.offline}</p>
          </Notice>
        ) : null}
        {collab.mode === 'unavailable' && canEdit ? (
          <Notice tone="info" testId="room-unavailable">
            <p>{collabText.unavailable}</p>
          </Notice>
        ) : null}
        {roomNotice && roomNotice.kind !== 'failed' ? (
          <Notice
            tone={roomNotice.kind === 'locked' || roomNotice.kind === 'lock_denied' ? 'info' : 'warning'}
            title={collabText.noticeTitle}
            testId="room-notice"
            actions={
              <button type="button" className="button button--small" onClick={() => onRoomNotice(null)}>
                {collabText.dismiss}
              </button>
            }
          >
            <p>{roomNotice.message}</p>
          </Notice>
        ) : null}
        {needsLink ? (
          <BasecampLinkBanner load={basecamp.load} onRetry={basecamp.reload} showErrors testId="editor-basecamp-link">
            <p>{t.editor.syncedLocked}</p>
          </BasecampLinkBanner>
        ) : null}
        {refusal ? (
          <Notice
            tone="danger"
            title={t.guard.refusedTitle}
            testId="sync-refusal"
            actions={
              <button type="button" className="button button--small" onClick={() => setRefusal(null)}>
                {t.guard.dismiss}
              </button>
            }
          >
            <p>{refusal}</p>
          </Notice>
        ) : null}
        {syncInfo?.notice ? (
          <Notice tone="warning" title={t.rowSync.noticeTitle} testId="sync-notice">
            <p>{syncInfo.notice}</p>
          </Notice>
        ) : null}
        {syncProblem ? (
          <Notice tone="info" testId="sync-poll-error">
            <p>{t.rowSync.pollFailed}</p>
          </Notice>
        ) : null}
        {selection.kind === 'missing' ? (
          <Notice tone="info" testId="editor-target-missing">
            <p>{t.editor.targetMissing}</p>
          </Notice>
        ) : null}
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

      <div className="editor-body">
      {resolved.ok ? (
        <div className="editor-stage">
          <div
            ref={hostRef}
            className="editor-host"
            data-testid="univer-host"
            data-engine={engine}
            data-rtl-mirrored={rtl === null ? 'pending' : String(rtl.mirrored)}
            data-active-sheet={activeSheet ?? ''}
            data-editable={engine === 'ready' ? String(editable) : 'pending'}
            data-selection={selection.kind === 'applied' ? selection.where : ''}
            data-pending-deletions={deletionsRef.current.size}
          />
          {engine === 'starting' ? (
            <div className="editor-overlay" role="status">
              <LoaderCircle className="icon spin" aria-hidden="true" />
              {t.editor.starting}
            </div>
          ) : null}
        </div>
      ) : null}
      {/* Mounted once opened, so going back and forth keeps it; it refreshes on every commit. */}
      {dashboardOpened ? (
        <div className="editor-dashboard" hidden={!showDashboard} id="workbook-dashboard" role="region" aria-label={t.dashboard.tab}>
          <DashboardView workbookId={workbook.id} visible={showDashboard} refreshKey={`${collab.version ?? ''}:${save.version}`} />
        </div>
      ) : null}
      </div>

      {rowHover ? (
        <div
          onMouseEnter={() => {
            tooltipHovered.current = true
          }}
          onMouseLeave={() => {
            tooltipHovered.current = false
            showRowHover(null)
          }}
        >
          <RowTooltip
            hover={rowHover}
            canWrite={editable}
            onClose={() => setRowHover(null)}
            onRemoveRow={() => {
              setRowHover(null)
              layerRef.current?.removeRow(rowHover.sheetId, rowHover.row)
            }}
          />
        </div>
      ) : null}
      {removal ? (
        <DeletionDialog
          request={removal.request}
          onDecide={(confirmed) => {
            removal.resolve(confirmed)
            setRemoval(null)
          }}
        />
      ) : null}
      {assigneeTarget ? (
        <AssigneeEditor
          target={assigneeTarget}
          workbookId={workbook.id}
          projectId={workbook.bcProjectId}
          onSave={(text) => layerRef.current?.writeAssignees(assigneeTarget, text) ?? false}
          onClose={() => setAssigneeTarget(null)}
        />
      ) : null}
      {attachmentTarget ? (
        <AttachmentEditor
          key={`${attachmentTarget.sheetId}:${attachmentTarget.uid ?? attachmentTarget.row}`}
          target={attachmentTarget}
          workbookId={workbook.id}
          canWrite={editable}
          onClose={() => setAttachmentTarget(null)}
          onChanged={() => pollerRef.current?.poke()}
        />
      ) : null}
      <TaskDetailsPanel
        open={detailsOpen}
        target={detailsTarget}
        workbookId={workbook.id}
        canWrite={editable}
        bcUrl={detailsBcUrl}
        onClose={() => setDetailsOpen(false)}
        onManageAttachments={(target) => {
          setDetailsOpen(false)
          setAttachmentTarget(target)
        }}
        onChanged={() => pollerRef.current?.poke()}
      />
      <SyncPanel
        open={panelOpen}
        info={syncInfo}
        conflicts={panelData.conflicts}
        attention={panelData.attention}
        options={people}
        canResolve={editable}
        onClose={() => setPanelOpen(false)}
        onGoTo={goTo}
        onRestore={resolveConflict((id, cid) => api.restoreConflict(id, cid))}
        onDismiss={resolveConflict((id, cid) => api.dismissConflict(id, cid))}
      />
    </div>
  )
}

/**
 * «الجدول» / «اللوحة»: the grid or the dashboard of this workbook. Links, so
 * each view has its address (/workbooks/:id, /workbooks/:id/dashboard).
 * OPEN (apps/web/OPEN_QUESTIONS.md #66): in the editor bar rather than in
 * Univer's own sheet tab bar, which has no public slot for it.
 */
function ViewTabs({ id, view }: { id: string; view: EditorView }) {
  const tabs = [
    { key: 'sheets' as const, href: pathFor({ name: 'editor', id }), label: t.dashboard.sheetsTab, Icon: Table2 },
    { key: 'dashboard' as const, href: pathFor({ name: 'dashboard', id }), label: t.dashboard.tab, Icon: LayoutDashboard },
  ]
  return (
    <nav className="view-tabs" aria-label={t.dashboard.viewSwitch}>
      {tabs.map(({ key, href, label, Icon }) => (
        <Link key={key} href={href} className={view === key ? 'view-tabs__tab view-tabs__tab--active' : 'view-tabs__tab'} aria-current={view === key ? 'page' : undefined} data-testid={`view-tab-${key}`}>
          <Icon className="icon" aria-hidden="true" />
          {label}
        </Link>
      ))}
    </nav>
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
