// Linking wizard (spec §7.3), full screen, opened from the editor's file
// settings. Nine steps; the state and the plan live in ./model.ts (pure).
//
// Basecamp is read through the API with the caller's own token (§3): the
// projects, the project's lists and people, and POST …/link/preview (which
// changes nothing). Only «بدء المزامنة» (POST …/link) changes anything, and
// nothing in Basecamp is ever deleted by this flow.
//
// Loaded lazily from App.tsx: it is the only screen that bundles the wizard
// helpers of @naf-sheets/gsheets-import.

import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowRight, Check, CircleCheck, Info, LoaderCircle, ShieldX } from 'lucide-react'
import { COMPLETED_VALUE_SUGGESTIONS } from '@naf-sheets/gsheets-import'
import type {
  BasecampPeopleResponse,
  BasecampProjectsResponse,
  BasecampTodolistsResponse,
  LinkPlan,
  LinkPreviewResponse,
  LinkWorkbookResponse,
  MappedField,
  WorkbookResponse,
} from '@naf-sheets/shared'
import { BasecampLinkBanner, isLinkActive, useBasecampLink } from '../components/BasecampLink'
import { Notice } from '../components/Notice'
import { api, errorMessage, isAbortError } from '../lib/api'
import { columnLetters } from '../lib/cell-target'
import { formatCount } from '../lib/format'
import { Link, navigate } from '../lib/router'
import { pathFor } from '../lib/routes'
import { useDocumentTitle } from '../lib/use-document-title'
import { canLinkWorkbook } from '../editor/FileSettingsPanel'
import { resolveWorkbookData } from '../editor/workbook-data'
import { t } from '../strings'
import {
  buildLinkPlan,
  canStart,
  cellText,
  columnOf,
  detectHierarchyFor,
  gridWidth,
  initialState,
  isPerSheetStep,
  isStepApplicable,
  sheetsForStep,
  statusAnalysis,
  stepErrors,
  STEPS,
  syncedSheets,
  wizardReducer,
  wizardSheets,
} from './model'
import type { SheetDraft, WizardAction, WizardSheet, WizardState, WizardStep } from './model'

type Remote<T> = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: T }

/** Run `load` whenever `key` changes (null: nothing to load). */
function useRemote<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>): [Remote<T>, () => void] {
  const [state, setState] = useState<Remote<T>>({ kind: 'idle' })
  const [attempt, setAttempt] = useState(0)
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    if (key === null) {
      setState({ kind: 'idle' })
      return
    }
    const controller = new AbortController()
    setState({ kind: 'loading' })
    loadRef.current(controller.signal).then(
      (data) => setState({ kind: 'ready', data }),
      (error: unknown) => {
        if (!isAbortError(error)) setState({ kind: 'error', message: errorMessage(error) })
      },
    )
    return () => controller.abort()
  }, [key, attempt])
  return [state, () => setAttempt((n) => n + 1)]
}

export default function LinkWizardScreen({ id }: { id: string }) {
  const [workbook, retryWorkbook] = useRemote<WorkbookResponse>(id, (signal) => api.getWorkbook(id, signal))
  const basecamp = useBasecampLink()
  useDocumentTitle(t.wizard.title)
  const editorPath = pathFor({ name: 'editor', id })

  let body: ReactNode
  if (workbook.kind === 'idle' || workbook.kind === 'loading' || basecamp.load.kind === 'loading') {
    body = (
      <div className="panel panel--plain" role="status">
        <LoaderCircle className="panel__icon spin" aria-hidden="true" />
        <p>{t.wizard.loading}</p>
      </div>
    )
  } else if (workbook.kind === 'error') {
    body = (
      <Notice
        tone="danger"
        testId="wizard-load-error"
        actions={
          <button type="button" className="button button--small" onClick={retryWorkbook}>
            {t.files.retry}
          </button>
        }
      >
        <p>{workbook.message}</p>
      </Notice>
    )
  } else if (!canLinkWorkbook(workbook.data.workbook.access)) {
    body = <Refusal title={t.wizard.notAllowedTitle} text={t.wizard.notAllowedBody} back={editorPath} />
  } else if (workbook.data.workbook.bcProjectId !== null) {
    // OPEN: re-linking a linked workbook is not this wizard's job (OPEN_QUESTIONS.md #20).
    body = <Refusal title={t.wizard.alreadyLinkedTitle} text={t.wizard.alreadyLinkedBody} back={editorPath} />
  } else if (!isLinkActive(basecamp.load)) {
    body = (
      <div className="stack">
        <BasecampLinkBanner load={basecamp.load} onRetry={basecamp.reload} showErrors testId="wizard-basecamp-link">
          <p>{t.wizard.linkRequired}</p>
        </BasecampLinkBanner>
      </div>
    )
  } else {
    body = <Wizard data={workbook.data} />
  }

  return (
    <div className="wizard" data-screen="link-wizard">
      <header className="editor-bar">
        <Link href={editorPath} className="icon-button" aria-label={t.wizard.backToFile} title={t.wizard.backToFile}>
          <ArrowRight className="icon" aria-hidden="true" />
        </Link>
        <h1 className="editor-bar__title">{t.wizard.title}</h1>
        {workbook.kind === 'ready' ? (
          <span className="muted wizard__file">
            <bdi>{workbook.data.workbook.title}</bdi>
          </span>
        ) : null}
      </header>
      <main id="main" className="wizard__main">
        {body}
      </main>
    </div>
  )
}

function Refusal({ title, text, back }: { title: string; text: string; back: string }) {
  return (
    <section className="panel" data-testid="wizard-refusal">
      <ShieldX className="panel__icon" aria-hidden="true" />
      <h2>{title}</h2>
      <p>{text}</p>
      <Link className="button" href={back}>
        {t.wizard.backToFile}
      </Link>
    </section>
  )
}

// ---------------------------------------------------------------------------

function Wizard({ data }: { data: WorkbookResponse }) {
  const id = data.workbook.id
  const { sheets, unregistered } = useMemo(() => {
    const resolved = resolveWorkbookData(data)
    return wizardSheets(data.sheets, resolved.ok ? resolved.data : null)
  }, [data])
  const [state, dispatch] = useReducer(wizardReducer, undefined, () => initialState(data.workbook.title, sheets))
  const [showErrors, setShowErrors] = useState(false)
  const [submit, setSubmit] = useState<Remote<LinkWorkbookResponse>>({ kind: 'idle' })
  const errorsRef = useRef<HTMLDivElement>(null)

  const projectId = state.project?.mode === 'existing' ? state.project.projectId : null
  const [projects, retryProjects] = useRemote<BasecampProjectsResponse>('projects', (signal) => api.listBasecampProjects(signal))
  const [todolists, retryTodolists] = useRemote<BasecampTodolistsResponse>(projectId === null ? null : `lists-${projectId}`, (signal) =>
    api.listBasecampTodolists(projectId as number, signal),
  )
  const [people] = useRemote<BasecampPeopleResponse>(projectId === null ? null : `people-${projectId}`, (signal) => api.listBasecampPeople(projectId as number, signal))

  // POST …/link/preview: on entering «المسؤولون», and on the final step for the exact plan to commit.
  const plan = useMemo(() => buildLinkPlan(state), [state])
  const planJson = JSON.stringify(plan)
  // The key is null on every other step, so coming back to a step asks again.
  const previewKey = state.step === 'assignees' ? 'assignees' : state.step === 'preview' ? `preview-${planJson}` : null
  const planRef = useRef<LinkPlan>(plan)
  planRef.current = plan
  const [preview, retryPreview] = useRemote<LinkPreviewResponse>(previewKey, (signal) => api.previewLink(id, planRef.current, signal))

  useEffect(() => setShowErrors(false), [state.step])

  const errors = stepErrors(state, state.step)
  const stepIndex = STEPS.indexOf(state.step)
  const proposedTotal = preview.kind === 'ready' && state.step === 'preview' ? preview.data.sheets.reduce((n, s) => n + s.proposedMatches.length, 0) : 0

  const next = () => {
    if (errors.length > 0) {
      setShowErrors(true)
      requestAnimationFrame(() => errorsRef.current?.focus())
      return
    }
    dispatch({ type: 'next' })
  }

  const start = async () => {
    if (submit.kind === 'loading' || !canStart(state, proposedTotal) || preview.kind !== 'ready') return
    setSubmit({ kind: 'loading' })
    try {
      const result = await api.linkWorkbook(id, plan)
      setSubmit({ kind: 'ready', data: result })
    } catch (error) {
      setSubmit({ kind: 'error', message: errorMessage(error) })
    }
  }

  if (submit.kind === 'ready') {
    const queued = submit.data.sheets.reduce((n, s) => n + s.queuedTasks, 0)
    return (
      <section className="panel" data-testid="wizard-done">
        <CircleCheck className="panel__icon panel__icon--success" aria-hidden="true" />
        <h2>{t.wizard.done.title}</h2>
        <p>{t.wizard.done.body}</p>
        <p>
          <bdi className="num">{t.wizard.done.queued(queued)}</bdi>
        </p>
        <Link className="button button--primary" href={pathFor({ name: 'editor', id })}>
          {t.wizard.done.open}
        </Link>
      </section>
    )
  }

  const isLast = state.step === 'preview'
  const noneChosen = state.project?.mode === 'none'
  const perSheet = isPerSheetStep(state.step) ? sheetsForStep(state, state.step) : []
  const activeSheet = perSheet.find((s) => s.planId === state.activeSheet) ?? perSheet[0] ?? null
  const activeDraft = activeSheet ? state.drafts[activeSheet.planId] : undefined

  return (
    <div className="wizard__layout" data-step={state.step}>
      <nav className="stepper" aria-label={t.wizard.stepsLabel}>
        {/* The spec's own numbering (§7.3, 1–9); steps that do not apply are marked, not renumbered. */}
        <p className="stepper__count muted">{t.wizard.stepOf(stepIndex + 1, STEPS.length)}</p>
        <ol>
          {STEPS.map((step, i) => {
            const on = isStepApplicable(state, step)
            const reachable = on && i <= state.furthest
            const current = step === state.step
            return (
              <li key={step} className={`stepper__item${current ? ' is-current' : ''}${on ? '' : ' is-off'}${i < stepIndex && on ? ' is-done' : ''}`}>
                <button
                  type="button"
                  className="stepper__button"
                  aria-current={current ? 'step' : undefined}
                  disabled={!reachable || current}
                  onClick={() => dispatch({ type: 'goTo', step })}
                >
                  <span className="stepper__dot" aria-hidden="true">
                    {i < stepIndex && on ? <Check className="icon" /> : <bdi className="num">{i + 1}</bdi>}
                  </span>
                  <span>
                    {t.wizard.steps[step]}
                    {on ? null : <span className="stepper__off"> — {t.wizard.notApplicable}</span>}
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
      </nav>

      <section className="wizard__content" aria-labelledby="wizard-step-heading">
        <h2 id="wizard-step-heading" className="wizard__heading">
          {t.wizard.steps[state.step]}
        </h2>
        <p className="wizard__never-deletes muted">
          <Info className="icon inline-icon" aria-hidden="true" />
          {t.wizard.neverDeletes}
        </p>

        {showErrors && errors.length > 0 ? (
          <div ref={errorsRef} tabIndex={-1} className="wizard__errors">
            <Notice tone="danger" title={t.wizard.fixErrors} testId="wizard-errors">
              <ul>
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </Notice>
          </div>
        ) : null}

        {perSheet.length > 1 ? (
          <div className="sheet-tabs" role="group" aria-label={t.wizard.sheetTabs}>
            {perSheet.map((s) => (
              <button
                key={s.planId}
                type="button"
                className="sheet-tabs__tab"
                aria-pressed={s.planId === activeSheet?.planId}
                onClick={() => dispatch({ type: 'setActiveSheet', sheet: s.planId })}
              >
                <bdi>{s.title}</bdi>
              </button>
            ))}
          </div>
        ) : perSheet.length === 1 && activeSheet ? (
          <p className="sheet-name">
            {t.wizard.preview.sheet}: <bdi>{activeSheet.title}</bdi>
          </p>
        ) : null}

        <div className="wizard__step">
          {state.step === 'project' ? <ProjectStep state={state} dispatch={dispatch} projects={projects} onRetry={retryProjects} /> : null}
          {state.step === 'sheets' ? <SheetsStep state={state} dispatch={dispatch} todolists={todolists} onRetry={retryTodolists} unregistered={unregistered} /> : null}
          {state.step === 'headerRow' && activeSheet && activeDraft ? <HeaderRowStep sheet={activeSheet} draft={activeDraft} dispatch={dispatch} /> : null}
          {state.step === 'columns' && activeSheet && activeDraft ? <ColumnsStep sheet={activeSheet} draft={activeDraft} dispatch={dispatch} /> : null}
          {state.step === 'hierarchy' && activeSheet && activeDraft ? <HierarchyStep sheet={activeSheet} draft={activeDraft} dispatch={dispatch} /> : null}
          {state.step === 'status' && activeSheet && activeDraft ? <StatusStep sheet={activeSheet} draft={activeDraft} dispatch={dispatch} /> : null}
          {state.step === 'assignees' && activeSheet && activeDraft ? (
            <AssigneesStep sheet={activeSheet} draft={activeDraft} dispatch={dispatch} preview={preview} onRetry={retryPreview} people={people} />
          ) : null}
          {state.step === 'existingTasks' && activeSheet && activeDraft ? <ExistingTasksStep sheet={activeSheet} draft={activeDraft} dispatch={dispatch} /> : null}
          {state.step === 'preview' ? <PreviewStep state={state} dispatch={dispatch} preview={preview} onRetry={retryPreview} todolists={todolists} projects={projects} /> : null}
        </div>

        {submit.kind === 'error' ? (
          <Notice tone="danger" testId="wizard-submit-error">
            <p>{submit.message}</p>
          </Notice>
        ) : null}

        <div className="wizard__footer">
          {/* OPEN: «بدون ربط الآن» sends nothing and returns to the file (OPEN_QUESTIONS.md #29). */}
          {noneChosen && state.step === 'project' ? (
            <button type="button" className="button button--primary" onClick={() => navigate(pathFor({ name: 'editor', id }))} data-testid="wizard-finish-unlinked">
              {t.wizard.project.finishUnlinked}
            </button>
          ) : isLast ? (
            <button
              type="button"
              className="button button--primary"
              onClick={() => void start()}
              disabled={!canStart(state, proposedTotal) || preview.kind !== 'ready' || submit.kind === 'loading'}
              data-testid="wizard-start"
            >
              {submit.kind === 'loading' ? <LoaderCircle className="icon spin" aria-hidden="true" /> : null}
              {submit.kind === 'loading' ? t.wizard.preview.starting : t.wizard.preview.start}
            </button>
          ) : (
            <button type="button" className="button button--primary" onClick={next} data-testid="wizard-next">
              {t.wizard.next}
            </button>
          )}
          {state.step !== 'project' ? (
            <button type="button" className="button" onClick={() => dispatch({ type: 'back' })} disabled={submit.kind === 'loading'}>
              {t.wizard.back}
            </button>
          ) : null}
          <Link className="button button--ghost" href={pathFor({ name: 'editor', id })}>
            {t.wizard.cancel}
          </Link>
        </div>
      </section>
    </div>
  )
}

type Dispatch = (action: WizardAction) => void

function Loading({ text }: { text: string }) {
  return (
    <p className="muted" role="status">
      <LoaderCircle className="icon spin inline-icon" aria-hidden="true" />
      {text}
    </p>
  )
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Notice
      tone="danger"
      actions={
        <button type="button" className="button button--small" onClick={onRetry}>
          {t.files.retry}
        </button>
      }
    >
      <p>{message}</p>
    </Notice>
  )
}

function Radio({ name, value, checked, disabled, onChange, label, hint, children }: { name: string; value: string; checked: boolean; disabled?: boolean; onChange: () => void; label: string; hint?: ReactNode; children?: ReactNode }) {
  const id = `${name}-${value}`
  return (
    <div className="choice" data-choice={value}>
      <input type="radio" id={id} name={name} value={value} checked={checked} disabled={disabled} onChange={onChange} />
      <label htmlFor={id}>
        <span>
          <strong>{label}</strong>
          {hint ? <span className="choice__hint">{hint}</span> : null}
        </span>
      </label>
      {checked && children ? <div className="choice__more">{children}</div> : null}
    </div>
  )
}

// --- Step 1 -----------------------------------------------------------------

function ProjectStep({ state, dispatch, projects, onRetry }: { state: WizardState; dispatch: Dispatch; projects: Remote<BasecampProjectsResponse>; onRetry: () => void }) {
  const p = state.project
  return (
    <fieldset className="choices">
      <legend>{t.wizard.project.intro}</legend>
      <Radio
        name="project"
        value="existing"
        checked={p?.mode === 'existing'}
        onChange={() => dispatch({ type: 'setProject', project: { mode: 'existing', projectId: p?.mode === 'existing' ? p.projectId : null } })}
        label={t.wizard.project.existing}
      >
        {projects.kind === 'loading' || projects.kind === 'idle' ? <Loading text={t.wizard.project.loadingProjects} /> : null}
        {projects.kind === 'error' ? <LoadError message={projects.message} onRetry={onRetry} /> : null}
        {projects.kind === 'ready' && projects.data.projects.length === 0 ? <p className="muted">{t.wizard.project.noProjects}</p> : null}
        {projects.kind === 'ready' && projects.data.projects.length > 0 ? (
          <div className="field">
            <label htmlFor="wizard-project">{t.wizard.project.existingLabel}</label>
            <select
              id="wizard-project"
              className="select"
              value={p?.mode === 'existing' && p.projectId !== null ? String(p.projectId) : ''}
              onChange={(e) => dispatch({ type: 'setProject', project: { mode: 'existing', projectId: e.target.value === '' ? null : Number(e.target.value) } })}
            >
              <option value="">{t.wizard.project.choose}</option>
              {projects.data.projects.map((project) => (
                <option key={project.id} value={String(project.id)}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </Radio>
      <Radio
        name="project"
        value="create"
        checked={p?.mode === 'create'}
        onChange={() => dispatch({ type: 'setProject', project: { mode: 'create' } })}
        label={t.wizard.project.create}
        hint={
          <>
            {t.wizard.project.createHint} <bdi>{state.workbookTitle}</bdi>
          </>
        }
      />
      <Radio name="project" value="none" checked={p?.mode === 'none'} onChange={() => dispatch({ type: 'setProject', project: { mode: 'none' } })} label={t.wizard.project.none} hint={t.wizard.project.noneHint} />
    </fieldset>
  )
}

// --- Step 2 -----------------------------------------------------------------

function SheetsStep({
  state,
  dispatch,
  todolists,
  onRetry,
  unregistered,
}: {
  state: WizardState
  dispatch: Dispatch
  todolists: Remote<BasecampTodolistsResponse>
  onRetry: () => void
  unregistered: number
}) {
  const existingAllowed = state.project?.mode === 'existing'
  return (
    <div className="stack">
      <p>{t.wizard.sheets.intro}</p>
      {state.sheets.map((sheet) => {
        const d = state.drafts[sheet.planId]
        if (!d) return null
        const name = `sheet-mode-${sheet.planId}`
        return (
          <fieldset key={sheet.planId} className="choices card" data-sheet={sheet.planId}>
            <legend className="card__legend">
              <bdi>{sheet.title}</bdi>
            </legend>
            <Radio
              name={name}
              value="existing"
              checked={d.mode === 'existing'}
              disabled={!existingAllowed}
              onChange={() => dispatch({ type: 'setSheetMode', sheet: sheet.planId, mode: 'existing' })}
              label={t.wizard.sheets.existing}
              hint={existingAllowed ? undefined : t.wizard.sheets.existingNeedsProject}
            >
              {todolists.kind === 'loading' || todolists.kind === 'idle' ? <Loading text={t.wizard.sheets.loadingLists} /> : null}
              {todolists.kind === 'error' ? <LoadError message={todolists.message} onRetry={onRetry} /> : null}
              {todolists.kind === 'ready' && todolists.data.todolists.length === 0 ? <p className="muted">{t.wizard.sheets.noLists}</p> : null}
              {todolists.kind === 'ready' && todolists.data.todolists.length > 0 ? (
                <div className="field">
                  <label htmlFor={`${name}-list`}>{t.wizard.sheets.listLabel(sheet.title)}</label>
                  <select
                    id={`${name}-list`}
                    className="select"
                    value={d.todolistId === null ? '' : String(d.todolistId)}
                    onChange={(e) => dispatch({ type: 'setTodolist', sheet: sheet.planId, todolistId: e.target.value === '' ? null : Number(e.target.value) })}
                  >
                    <option value="">{t.wizard.sheets.chooseList}</option>
                    {todolists.data.todolists.map((list) => (
                      <option key={list.id} value={String(list.id)}>
                        {list.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <p className="muted small">{t.wizard.sheets.existingKeeps}</p>
            </Radio>
            <Radio name={name} value="new" checked={d.mode === 'new'} onChange={() => dispatch({ type: 'setSheetMode', sheet: sheet.planId, mode: 'new' })} label={t.wizard.sheets.new} />
            <Radio name={name} value="local" checked={d.mode === 'local'} onChange={() => dispatch({ type: 'setSheetMode', sheet: sheet.planId, mode: 'local' })} label={t.wizard.sheets.local} />
          </fieldset>
        )
      })}
      {unregistered > 0 ? (
        <Notice tone="info">
          <p>{t.wizard.sheets.unregistered(unregistered)}</p>
        </Notice>
      ) : null}
      {syncedSheets(state).length === 0 ? (
        <Notice tone="info">
          <p>{t.wizard.sheets.allLocal}</p>
        </Notice>
      ) : null}
    </div>
  )
}

// --- Step 3 -----------------------------------------------------------------

const PREVIEW_ROWS = 8
const PREVIEW_COLUMNS = 8

function HeaderRowStep({ sheet, draft, dispatch }: { sheet: WizardSheet; draft: SheetDraft; dispatch: Dispatch }) {
  const inputId = `header-row-${sheet.planId}`
  const rows = Math.min(sheet.grid.length, Math.max(PREVIEW_ROWS, Number.isInteger(draft.headerRow) ? draft.headerRow + 2 : 0), 15)
  const columns = Math.min(gridWidth(sheet.grid), PREVIEW_COLUMNS)
  if (sheet.grid.length === 0) return <p className="muted">{t.wizard.headerRow.emptySheet}</p>
  return (
    <div className="stack">
      <p>{t.wizard.headerRow.intro}</p>
      <div className="field field--inline">
        <label htmlFor={inputId}>{t.wizard.headerRow.label}</label>
        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          dir="ltr"
          min={1}
          max={sheet.grid.length}
          value={Number.isFinite(draft.headerRow) ? draft.headerRow : ''}
          onChange={(e) => dispatch({ type: 'setHeaderRow', sheet: sheet.planId, row: e.target.value === '' ? Number.NaN : Number(e.target.value) })}
          className="input-number"
        />
      </div>
      <p className="muted small">{draft.headerDetected ? t.wizard.headerRow.detected : t.wizard.headerRow.defaulted}</p>
      <div className="table-wrap">
        <table className="mini-grid">
          <caption className="sr-only">{t.wizard.headerRow.previewCaption}</caption>
          <thead>
            <tr>
              <th scope="col" aria-hidden="true" />
              {Array.from({ length: columns }, (_, c) => (
                <th key={c} scope="col">
                  <bdi>{columnLetters(c)}</bdi>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, r) => (
              <tr key={r} className={r === draft.headerRow - 1 ? 'is-header' : undefined}>
                <th scope="row">
                  <bdi className="num">{r + 1}</bdi>
                </th>
                {Array.from({ length: columns }, (_, c) => (
                  <td key={c}>
                    <bdi>{cellText(sheet.grid, r, c)}</bdi>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// --- Step 4 -----------------------------------------------------------------

const FIELDS: MappedField[] = ['title', 'assignees', 'due_on', 'starts_on', 'completed', 'notes', 'attachments', 'free']

function ColumnsStep({ sheet, draft, dispatch }: { sheet: WizardSheet; draft: SheetDraft; dispatch: Dispatch }) {
  return (
    <div className="stack">
      <p>{t.wizard.columns.intro}</p>
      <div className="table-wrap">
        <table className="data-table" data-testid="wizard-columns">
          <thead>
            <tr>
              <th scope="col">{t.wizard.columns.column}</th>
              <th scope="col">{t.wizard.columns.header}</th>
              <th scope="col">{t.wizard.columns.field}</th>
            </tr>
          </thead>
          <tbody>
            {draft.columns.map((c) => {
              const letter = columnLetters(c.column)
              const selectId = `col-${sheet.planId}-${letter}`
              return (
                <tr key={c.column} data-column={letter}>
                  <td>
                    <bdi className="num">{letter}</bdi>
                  </td>
                  <td>{c.header.trim() ? <bdi>{c.header}</bdi> : <span className="muted">{t.wizard.columns.untitled}</span>}</td>
                  <td>
                    <div className="stack-tight">
                      <div className="inline-row">
                        <label htmlFor={selectId} className="sr-only">
                          {t.wizard.columns.fieldLabel(letter)}
                        </label>
                        <select
                          id={selectId}
                          className="select"
                          value={c.field}
                          onChange={(e) => dispatch({ type: 'setColumnField', sheet: sheet.planId, column: c.column, field: e.target.value as MappedField })}
                        >
                          {FIELDS.map((f) => (
                            <option key={f} value={f}>
                              {t.wizard.columns.fields[f]}
                            </option>
                          ))}
                        </select>
                        {c.field === c.suggested && c.suggested !== 'free' ? <span className="badge badge--info">{t.wizard.columns.suggested}</span> : null}
                      </div>
                      {c.field === 'free' ? (
                        <label className="checkbox">
                          <input
                            type="checkbox"
                            checked={c.appendToDescription}
                            onChange={(e) => dispatch({ type: 'setAppendToDescription', sheet: sheet.planId, column: c.column, value: e.target.checked })}
                          />
                          {t.wizard.columns.appendToDescription}
                        </label>
                      ) : null}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// --- Step 5 -----------------------------------------------------------------

function rowList(rows: number[]): string {
  const shown = rows.slice(0, 12).map((r) => String(r + 1))
  return t.wizard.hierarchy.rowList(shown, rows.length > shown.length)
}

function HierarchyStep({ sheet, draft, dispatch }: { sheet: WizardSheet; draft: SheetDraft; dispatch: Dispatch }) {
  const titleColumn = columnOf(draft.columns, 'title')
  const detected = useMemo(() => detectHierarchyFor(sheet.grid, draft.headerRow, titleColumn), [sheet.grid, draft.headerRow, titleColumn])
  const current = detectHierarchyFor(sheet.grid, draft.headerRow, titleColumn, draft.hierarchy)
  const main = current?.rows.filter((r) => r.level === 0).length ?? 0
  const sub = current?.rows.filter((r) => r.level === 1).length ?? 0
  const tooDeep = current?.warnings.filter((w) => w.kind === 'too_deep').map((w) => w.row) ?? []
  const orphan = current?.warnings.filter((w) => w.kind === 'orphan').map((w) => w.row) ?? []
  const name = `hierarchy-${sheet.planId}`
  const h = draft.hierarchy
  const numberingDefault = detected?.numberingColumn ?? null
  return (
    <div className="stack">
      <fieldset className="choices">
        <legend>{t.wizard.hierarchy.intro}</legend>
        <Radio name={name} value="flat" checked={h.mode === 'flat'} onChange={() => dispatch({ type: 'setHierarchy', sheet: sheet.planId, hierarchy: { mode: 'flat' } })} label={t.wizard.hierarchy.flat} hint={t.wizard.hierarchy.flatHint} />
        <Radio
          name={name}
          value="numbering"
          checked={h.mode === 'numbering'}
          onChange={() => dispatch({ type: 'setHierarchy', sheet: sheet.planId, hierarchy: { mode: 'numbering', column: numberingDefault } })}
          label={t.wizard.hierarchy.numbering}
        >
          <div className="field">
            <label htmlFor={`${name}-column`}>{t.wizard.hierarchy.numberingColumn}</label>
            <select
              id={`${name}-column`}
              className="select"
              value={h.mode === 'numbering' && h.column !== null ? String(h.column) : ''}
              onChange={(e) => dispatch({ type: 'setHierarchy', sheet: sheet.planId, hierarchy: { mode: 'numbering', column: e.target.value === '' ? null : Number(e.target.value) } })}
            >
              <option value="">{t.wizard.hierarchy.chooseColumn}</option>
              {draft.columns.map((c) => (
                <option key={c.column} value={String(c.column)}>
                  {`${columnLetters(c.column)} — ${c.header.trim() || t.wizard.columns.untitled}`}
                </option>
              ))}
            </select>
          </div>
        </Radio>
        <Radio name={name} value="indent" checked={h.mode === 'indent'} onChange={() => dispatch({ type: 'setHierarchy', sheet: sheet.planId, hierarchy: { mode: 'indent' } })} label={t.wizard.hierarchy.indent} />
      </fieldset>
      {detected && detected.source !== 'none' ? (
        <p className="muted small">
          {t.wizard.hierarchy.detectedFrom} {detected.source === 'numbering' ? t.wizard.hierarchy.numbering : t.wizard.hierarchy.indent}
        </p>
      ) : null}
      {current ? (
        <p data-testid="hierarchy-summary">
          <bdi>{t.wizard.hierarchy.summary(main, sub)}</bdi>
        </p>
      ) : null}
      {tooDeep.length > 0 ? (
        <Notice tone="warning">
          <p>{t.wizard.hierarchy.tooDeep(rowList(tooDeep))}</p>
        </Notice>
      ) : null}
      {orphan.length > 0 ? (
        <Notice tone="warning">
          <p>{t.wizard.hierarchy.orphan(rowList(orphan))}</p>
        </Notice>
      ) : null}
    </div>
  )
}

// --- Step 6 -----------------------------------------------------------------

function StatusStep({ sheet, draft, dispatch }: { sheet: WizardSheet; draft: SheetDraft; dispatch: Dispatch }) {
  const analysis = statusAnalysis(sheet.grid, draft.headerRow, draft.columns)
  if (!analysis) return <p className="muted">{t.wizard.status.noColumn}</p>
  if (analysis.kind === 'boolean') return <p>{t.wizard.status.boolean}</p>
  const options =
    analysis.kind === 'text'
      ? analysis.distinct
      : [...new Set([...COMPLETED_VALUE_SUGGESTIONS, ...draft.completedValues])].map((value) => ({ value, count: 0 }))
  return (
    <fieldset className="stack">
      <legend>{analysis.kind === 'empty' ? t.wizard.status.empty : t.wizard.status.intro}</legend>
      <div className="checks">
        {options.map((o) => (
          <label key={o.value} className="checkbox" data-value={o.value}>
            <input
              type="checkbox"
              checked={draft.completedValues.includes(o.value)}
              onChange={(e) => dispatch({ type: 'setCompletedValue', sheet: sheet.planId, value: o.value, completed: e.target.checked })}
            />
            <bdi>{o.value}</bdi>
            {o.count > 0 ? <span className="muted small">({t.wizard.status.count(o.count)})</span> : null}
          </label>
        ))}
      </div>
      {draft.completedValues.length === 0 ? (
        <Notice tone="warning">
          <p>{t.wizard.status.noneChosen}</p>
        </Notice>
      ) : null}
    </fieldset>
  )
}

// --- Step 7 -----------------------------------------------------------------

function AssigneesStep({
  sheet,
  draft,
  dispatch,
  preview,
  onRetry,
  people,
}: {
  sheet: WizardSheet
  draft: SheetDraft
  dispatch: Dispatch
  preview: Remote<LinkPreviewResponse>
  onRetry: () => void
  people: Remote<BasecampPeopleResponse>
}) {
  if (columnOf(draft.columns, 'assignees') === null) return <p className="muted">{t.wizard.assignees.noColumn}</p>
  if (preview.kind === 'loading' || preview.kind === 'idle') return <Loading text={t.wizard.assignees.loading} />
  if (preview.kind === 'error') return <LoadError message={preview.message} onRetry={onRetry} />
  const unmatched = preview.data.sheets.find((s) => s.sheetId === sheet.planId)?.unmatchedAssignees ?? []
  if (unmatched.length === 0) return <p data-testid="assignees-all-matched">{t.wizard.assignees.allMatched}</p>
  const everyone = people.kind === 'ready' ? people.data.people : []
  return (
    <div className="stack">
      <p>{t.wizard.assignees.intro}</p>
      <div className="table-wrap">
        <table className="data-table" data-testid="wizard-assignees">
          <thead>
            <tr>
              <th scope="col">{t.wizard.assignees.text}</th>
              <th scope="col">{t.wizard.assignees.person}</th>
            </tr>
          </thead>
          <tbody>
            {unmatched.map((u, i) => {
              const candidateIds = new Set(u.candidates.map((c) => c.bcPersonId))
              const others = everyone.filter((p) => !candidateIds.has(p.id))
              const chosen = draft.assigneeMatches[u.text]
              const selectId = `assignee-${sheet.planId}-${i}`
              return (
                <tr key={u.text} data-text={u.text}>
                  <td>
                    <bdi>{u.text}</bdi>
                  </td>
                  <td>
                    <label htmlFor={selectId} className="sr-only">
                      {t.wizard.assignees.personLabel(u.text)}
                    </label>
                    <select
                      id={selectId}
                      className="select"
                      value={chosen === undefined || chosen === null ? '' : String(chosen)}
                      onChange={(e) => dispatch({ type: 'setAssigneeMatch', sheet: sheet.planId, text: u.text, personId: e.target.value === '' ? null : Number(e.target.value) })}
                    >
                      {/* OPEN: nothing is assigned unless the user picks someone (OPEN_QUESTIONS.md #28). */}
                      <option value="">{t.wizard.assignees.leaveUnassigned}</option>
                      {u.candidates.length > 0 ? (
                        <optgroup label={t.wizard.assignees.candidates}>
                          {u.candidates.map((c) => (
                            <option key={c.bcPersonId} value={String(c.bcPersonId)}>
                              {`${c.name} (${t.wizard.assignees.score(`${Math.round(Math.min(1, Math.max(0, c.score)) * 100)}%`)})`}
                            </option>
                          ))}
                        </optgroup>
                      ) : null}
                      {others.length > 0 ? (
                        <optgroup label={t.wizard.assignees.otherPeople}>
                          {others.map((p) => (
                            <option key={p.id} value={String(p.id)}>
                              {p.name}
                            </option>
                          ))}
                        </optgroup>
                      ) : null}
                    </select>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// --- Step 8 -----------------------------------------------------------------

function ExistingTasksStep({ sheet, draft, dispatch }: { sheet: WizardSheet; draft: SheetDraft; dispatch: Dispatch }) {
  if (draft.mode !== 'existing') return <p className="muted">{t.wizard.existingTasks.notApplicable}</p>
  const name = `existing-${sheet.planId}`
  return (
    <div className="stack">
      <fieldset className="choices">
        <legend>{t.wizard.existingTasks.intro}</legend>
        <Radio
          name={name}
          value="create_all"
          checked={draft.existingTasks === 'create_all'}
          onChange={() => dispatch({ type: 'setExistingTasks', sheet: sheet.planId, value: 'create_all' })}
          label={t.wizard.existingTasks.createAll}
          hint={t.wizard.existingTasks.createAllHint}
        />
        <Radio
          name={name}
          value="match_by_title"
          checked={draft.existingTasks === 'match_by_title'}
          onChange={() => dispatch({ type: 'setExistingTasks', sheet: sheet.planId, value: 'match_by_title' })}
          label={t.wizard.existingTasks.matchByTitle}
          hint={t.wizard.existingTasks.matchByTitleHint}
        />
      </fieldset>
      <Notice tone="info">
        <p>{t.wizard.existingTasks.nothingDeleted}</p>
      </Notice>
    </div>
  )
}

// --- Step 9 -----------------------------------------------------------------

function PreviewStep({
  state,
  dispatch,
  preview,
  onRetry,
  todolists,
  projects,
}: {
  state: WizardState
  dispatch: Dispatch
  preview: Remote<LinkPreviewResponse>
  onRetry: () => void
  todolists: Remote<BasecampTodolistsResponse>
  projects: Remote<BasecampProjectsResponse>
}) {
  if (preview.kind === 'loading' || preview.kind === 'idle') return <Loading text={t.wizard.preview.loading} />
  if (preview.kind === 'error') return <LoadError message={preview.message} onRetry={onRetry} />
  const p = state.project
  const projectName =
    p?.mode === 'create'
      ? t.wizard.preview.projectCreate(state.workbookTitle)
      : p?.mode === 'existing' && projects.kind === 'ready'
        ? (projects.data.projects.find((x) => x.id === p.projectId)?.name ?? String(p.projectId))
        : ''
  const listName = (id: number | null) => (todolists.kind === 'ready' ? todolists.data.todolists.find((l) => l.id === id)?.name : undefined) ?? String(id)
  const bySheet = new Map(preview.data.sheets.map((s) => [s.sheetId, s]))
  const proposed = preview.data.sheets.flatMap((s) => s.proposedMatches.map((m) => ({ ...m, sheetId: s.sheetId })))
  const sheetTitle = (sheetId: string) => state.sheets.find((s) => s.planId === sheetId)?.title ?? sheetId
  const unmatched = preview.data.sheets.reduce(
    (n, s) => n + s.unmatchedAssignees.filter((u) => (state.drafts[s.sheetId]?.assigneeMatches[u.text] ?? null) === null).length,
    0,
  )
  const warnings = preview.data.sheets.flatMap((s) => s.warnings.map((w) => ({ sheetId: s.sheetId, text: w })))
  return (
    <div className="stack" data-testid="wizard-preview">
      <p>{t.wizard.preview.intro}</p>
      <p>
        <strong>{t.wizard.preview.project}:</strong> <bdi>{projectName}</bdi>
      </p>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t.wizard.preview.sheet}</th>
              <th scope="col">{t.wizard.preview.mode}</th>
              <th scope="col">{t.wizard.preview.todos}</th>
              <th scope="col">{t.wizard.preview.subtasks}</th>
            </tr>
          </thead>
          <tbody>
            {state.sheets.map((sheet) => {
              const d = state.drafts[sheet.planId]
              const row = bySheet.get(sheet.planId)
              const mode = d?.mode === 'existing' ? `${t.wizard.sheets.existing}: ${listName(d.todolistId)}` : d?.mode === 'new' ? t.wizard.sheets.new : t.wizard.preview.local
              return (
                <tr key={sheet.planId} data-sheet={sheet.planId}>
                  <td>
                    <bdi>{sheet.title}</bdi>
                  </td>
                  <td>
                    <bdi>{mode}</bdi>
                  </td>
                  <td>
                    <bdi className="num" data-testid="preview-todos">
                      {d?.mode === 'local' || !row ? '—' : formatCount(row.todosToCreate)}
                    </bdi>
                  </td>
                  <td>
                    <bdi className="num" data-testid="preview-subtasks">
                      {d?.mode === 'local' || !row ? '—' : formatCount(row.subtasksToCreate)}
                    </bdi>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {proposed.length > 0 ? (
        <section className="stack" aria-labelledby="proposed-heading">
          <h3 id="proposed-heading">{t.wizard.preview.proposedMatches}</h3>
          <div className="table-wrap">
            <table className="data-table" data-testid="proposed-matches">
              <thead>
                <tr>
                  <th scope="col">{t.wizard.preview.sheet}</th>
                  <th scope="col">{t.wizard.preview.row}</th>
                  <th scope="col">{t.wizard.preview.rowTitle}</th>
                  <th scope="col">{t.wizard.preview.todoTitle}</th>
                </tr>
              </thead>
              <tbody>
                {proposed.map((m) => (
                  <tr key={`${m.sheetId}-${m.rowNumber}-${m.todoId}`}>
                    <td>
                      <bdi>{sheetTitle(m.sheetId)}</bdi>
                    </td>
                    <td>
                      <bdi className="num">{m.rowNumber}</bdi>
                    </td>
                    <td>
                      <bdi>{m.title}</bdi>
                    </td>
                    <td>
                      <bdi>{m.todoTitle}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* OPEN: the plan has no way to reject one pair; the review is all or nothing (OPEN_QUESTIONS.md #21). */}
          <label className="checkbox">
            <input type="checkbox" checked={state.matchesReviewed} onChange={(e) => dispatch({ type: 'setMatchesReviewed', value: e.target.checked })} />
            {t.wizard.preview.reviewConfirm}
          </label>
          {!state.matchesReviewed ? <p className="muted small">{t.wizard.preview.reviewRequired}</p> : null}
        </section>
      ) : null}

      {unmatched > 0 ? <p className="muted">{t.wizard.preview.unmatched(unmatched)}</p> : null}

      {warnings.length > 0 ? (
        <Notice tone="warning" title={t.wizard.preview.warnings}>
          <ul>
            {warnings.map((w, i) => (
              <li key={i}>
                <bdi>{sheetTitle(w.sheetId)}</bdi>: {w.text}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <Notice tone="info">
        <p>{t.wizard.preview.nothingDeleted}</p>
      </Notice>
    </div>
  )
}
