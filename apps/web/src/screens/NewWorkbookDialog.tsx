// «ملف جديد» (spec §7.1): three options.
//   1. ملف فارغ — POST /api/workbooks (phase 1).
//   2. من قالب ناف (phase 7) — GET /api/templates, then POST /api/workbooks
//      with `source: 'template'`: a copy of the template's snapshot (admins
//      manage templates from «الإعدادات» → «القوالب»).
//   3. استيراد من Google Sheets (§7.2) — paste a link; when the caller's
//      Google account is not linked, the browser goes to Google's consent and
//      comes back here (`/?import=<id>`), then POST /api/import/gsheets and
//      the import report opens.
// OPEN: the phase 1 contract has no rename endpoint, so the title is asked
// here, once (apps/web/OPEN_QUESTIONS.md #2).

import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, RefObject } from 'react'
import { FileSpreadsheet, LayoutTemplate, LoaderCircle, Sheet } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ImportGsheetsRequest, TemplateSummary } from '@naf-sheets/shared'
import { api, errorMessage, googleStartUrl, isAbortError } from '../lib/api'
import { parseSpreadsheetSource } from '../lib/gsheets-source'
import { pathFor } from '../lib/routes'
import { t } from '../strings'

type Choice = 'blank' | 'template' | 'gsheets'
type Busy = null | 'creating' | 'checkingGoogle' | 'redirecting' | 'importing'
type Templates = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; list: TemplateSummary[] }

export function NewWorkbookDialog({
  open,
  initialImport,
  onClose,
  onCreated,
  onImported,
}: {
  open: boolean
  /** A spreadsheet id to start the import with (back from Google's consent). */
  initialImport?: string | undefined
  onClose: () => void
  onCreated: (id: string) => void
  onImported: (workbookId: string) => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const sourceRef = useRef<HTMLInputElement>(null)
  const [choice, setChoice] = useState<Choice>('blank')
  const [title, setTitle] = useState<string>(t.newFile.defaultTitle)
  const [source, setSource] = useState('')
  const [importTitle, setImportTitle] = useState('')
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [returned, setReturned] = useState(false)
  const [templates, setTemplates] = useState<Templates>({ kind: 'idle' })
  const [templateId, setTemplateId] = useState('')
  const templateRef = useRef<HTMLSelectElement>(null)
  // Which field takes the focus once the dialog has rendered its option's fields.
  const focusOnOpen = useRef<'title' | 'source' | null>(null)
  const ids = useId()
  const headingId = `${ids}-heading`
  const errorId = `${ids}-error`

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      setTitle(t.newFile.defaultTitle)
      setImportTitle('')
      setError(null)
      setBusy(null)
      setChoice(initialImport ? 'gsheets' : 'blank')
      setSource(initialImport ?? '')
      setReturned(Boolean(initialImport))
      setTemplates({ kind: 'idle' })
      setTemplateId('')
      focusOnOpen.current = initialImport ? 'source' : 'title'
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
    // `initialImport` is read only when the dialog opens.
  }, [open])

  // After every render: the field exists only once its option is shown.
  useEffect(() => {
    if (focusOnOpen.current === 'source' && sourceRef.current) {
      sourceRef.current.focus()
      focusOnOpen.current = null
    } else if (focusOnOpen.current === 'title' && titleRef.current) {
      titleRef.current.select()
      focusOnOpen.current = null
    }
  })

  // The list is read once per opening of the dialog, when the template option is first chosen.
  const templatesRequested = useRef(false)
  useEffect(() => {
    if (!open) {
      templatesRequested.current = false
      return
    }
    if (choice !== 'template' || templatesRequested.current) return
    templatesRequested.current = true
    setTemplates({ kind: 'loading' })
    api.listTemplates().then(
      (res) => setTemplates({ kind: 'ready', list: res.templates }),
      (err: unknown) => {
        if (!isAbortError(err)) setTemplates({ kind: 'error', message: errorMessage(err) })
      },
    )
  }, [open, choice])

  const choose = (next: Choice) => {
    if (busy) return
    setChoice(next)
    setError(null)
  }

  const createFromTemplate = async () => {
    if (!templateId) {
      setError(t.newFile.templateRequired)
      templateRef.current?.focus()
      return
    }
    const value = title.trim()
    if (!value) {
      setError(t.newFile.titleRequired)
      titleRef.current?.focus()
      return
    }
    setBusy('creating')
    setError(null)
    try {
      const { id } = await api.createWorkbookFromTemplate(value, templateId)
      onCreated(id)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const createBlank = async () => {
    const value = title.trim()
    if (!value) {
      setError(t.newFile.titleRequired)
      titleRef.current?.focus()
      return
    }
    setBusy('creating')
    setError(null)
    try {
      const { id } = await api.createWorkbook(value)
      onCreated(id)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const importSheet = async () => {
    const check = parseSpreadsheetSource(source)
    if (!check.ok) {
      setError(t.newFile.sourceProblems[check.problem])
      sourceRef.current?.focus()
      return
    }
    setError(null)
    setReturned(false)
    setBusy('checkingGoogle')
    try {
      const google = await api.getGoogleLink()
      if (google.state !== 'active') {
        // Unlinked or expired: Google's consent, then back to «ملف جديد» with the id filled in.
        // OPEN: the user presses «استيراد» again; nothing is imported unasked (OPEN_QUESTIONS.md #26).
        setBusy('redirecting')
        window.location.assign(googleStartUrl(pathFor({ name: 'files', q: '', importSource: check.spreadsheetId })))
        return
      }
      setBusy('importing')
      // OPEN: the id is sent rather than the pasted address (the contract takes either), OPEN_QUESTIONS.md #27.
      const body: ImportGsheetsRequest = { source: check.spreadsheetId }
      const wanted = importTitle.trim()
      if (wanted) body.title = wanted
      const { workbookId } = await api.importGsheets(body)
      setBusy(null)
      onImported(workbookId)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(null)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (choice === 'blank') void createBlank()
    else if (choice === 'template') void createFromTemplate()
    else if (choice === 'gsheets') void importSheet()
  }

  const status =
    busy === 'checkingGoogle' ? t.newFile.checkingGoogle : busy === 'redirecting' ? t.newFile.redirectingToGoogle : busy === 'importing' ? t.newFile.importing : null

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      aria-labelledby={headingId}
      onClose={onClose}
      onCancel={(e) => {
        if (busy) e.preventDefault()
      }}
    >
      <form onSubmit={submit} noValidate>
        <h2 id={headingId}>{t.newFile.title}</h2>
        <fieldset className="choices" disabled={busy !== null}>
          <legend className="sr-only">{t.newFile.optionsLegend}</legend>
          <ChoiceCard name={`${ids}-choice`} value="blank" checked={choice === 'blank'} onChoose={choose} Icon={FileSpreadsheet} label={t.newFile.blankOption} hint={t.newFile.blankHint} />
          <ChoiceCard
            name={`${ids}-choice`}
            value="template"
            checked={choice === 'template'}
            onChoose={choose}
            Icon={LayoutTemplate}
            label={t.newFile.templateOption}
            hint={t.newFile.templateHint}
          />
          <ChoiceCard name={`${ids}-choice`} value="gsheets" checked={choice === 'gsheets'} onChoose={choose} Icon={Sheet} label={t.newFile.importOption} hint={t.newFile.importHint} />
        </fieldset>

        {choice === 'template' ? (
          <TemplateField
            id={`${ids}-template`}
            selectRef={templateRef}
            templates={templates}
            value={templateId}
            invalid={Boolean(error) && !templateId}
            errorId={errorId}
            onChange={(id) => {
              setTemplateId(id)
              setError(null)
              const picked = templates.kind === 'ready' ? templates.list.find((x) => x.id === id) : undefined
              // Suggest the template's name while the title is still the default.
              if (picked && (title.trim() === '' || title === t.newFile.defaultTitle)) setTitle(picked.title)
            }}
          />
        ) : null}

        {choice === 'blank' || choice === 'template' ? (
          <div className="field">
            <label htmlFor={`${ids}-title`}>{t.newFile.titleLabel}</label>
            <input
              ref={titleRef}
              id={`${ids}-title`}
              name="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoComplete="off"
              required
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
            />
          </div>
        ) : null}

        {choice === 'gsheets' ? (
          <>
            {returned ? (
              <p className="muted" role="status" data-testid="import-returned">
                {t.newFile.returnedFromGoogle}
              </p>
            ) : null}
            <div className="field">
              <label htmlFor={`${ids}-source`}>{t.newFile.sourceLabel}</label>
              <input
                ref={sourceRef}
                id={`${ids}-source`}
                name="source"
                dir="ltr"
                inputMode="url"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder={t.newFile.sourcePlaceholder}
                autoComplete="off"
                spellCheck={false}
                required
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
              />
            </div>
            <div className="field">
              <label htmlFor={`${ids}-import-title`}>{t.newFile.importTitleLabel}</label>
              <input
                id={`${ids}-import-title`}
                name="importTitle"
                value={importTitle}
                onChange={(e) => setImportTitle(e.target.value)}
                autoComplete="off"
                aria-describedby={`${ids}-import-title-hint`}
              />
              <p id={`${ids}-import-title-hint`} className="field-hint">
                {t.newFile.importTitleHint}
              </p>
            </div>
          </>
        ) : null}

        {error ? (
          <p id={errorId} className="field-error" role="alert" data-testid="new-file-error">
            {error}
          </p>
        ) : null}
        {status ? (
          <p className="muted" role="status" data-testid="new-file-status">
            {status}
          </p>
        ) : null}

        <div className="dialog__actions">
          <button type="submit" className="button button--primary" disabled={busy !== null}>
            {busy ? <LoaderCircle className="icon spin" aria-hidden="true" /> : null}
            {choice === 'gsheets' ? t.newFile.importSubmit : busy === 'creating' ? t.newFile.creating : t.newFile.create}
          </button>
          <button type="button" className="button" onClick={onClose} disabled={busy !== null}>
            {t.newFile.cancel}
          </button>
        </div>
      </form>
    </dialog>
  )
}

function ChoiceCard({
  name,
  value,
  checked,
  disabled = false,
  onChoose,
  Icon,
  label,
  hint,
}: {
  name: string
  value: Choice
  checked: boolean
  disabled?: boolean
  onChoose: (value: Choice) => void
  Icon: LucideIcon
  label: string
  hint: string
}) {
  const id = `${name}-${value}`
  return (
    <div className="choice" data-choice={value}>
      <input type="radio" id={id} name={name} value={value} checked={checked} disabled={disabled} onChange={() => onChoose(value)} aria-describedby={`${id}-hint`} />
      <label htmlFor={id}>
        <Icon className="icon" aria-hidden="true" />
        <span>
          <strong>{label}</strong>
          <span id={`${id}-hint`} className="choice__hint">
            {hint}
          </span>
        </span>
      </label>
    </div>
  )
}

function TemplateField({
  id,
  selectRef,
  templates,
  value,
  invalid,
  errorId,
  onChange,
}: {
  id: string
  selectRef: RefObject<HTMLSelectElement>
  templates: Templates
  value: string
  invalid: boolean
  errorId: string
  onChange: (id: string) => void
}) {
  if (templates.kind === 'idle' || templates.kind === 'loading') {
    return (
      <p className="muted" role="status" data-testid="templates-loading">
        <LoaderCircle className="icon spin inline-icon" aria-hidden="true" />
        {t.newFile.templatesLoading}
      </p>
    )
  }
  if (templates.kind === 'error') {
    return (
      <p className="field-error" role="alert" data-testid="templates-error">
        {templates.message}
      </p>
    )
  }
  if (templates.list.length === 0) {
    return (
      <p className="muted" data-testid="templates-empty">
        {t.newFile.templatesEmpty}
      </p>
    )
  }
  const picked = templates.list.find((x) => x.id === value)
  return (
    <div className="field">
      <label htmlFor={id}>{t.newFile.templateLabel}</label>
      <select
        ref={selectRef}
        id={id}
        className="select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={invalid ? errorId : picked ? `${id}-hint` : undefined}
      >
        <option value="">{t.newFile.templatePlaceholder}</option>
        {templates.list.map((tpl) => (
          <option key={tpl.id} value={tpl.id}>
            {tpl.title} — {t.newFile.templateSheets(tpl.sheetCount)}
          </option>
        ))}
      </select>
      {picked?.description ? (
        <p id={`${id}-hint`} className="field-hint">
          {picked.description}
        </p>
      ) : null}
    </div>
  )
}
