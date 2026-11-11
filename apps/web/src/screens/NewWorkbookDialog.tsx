// «ملف جديد» (spec §7.1): three options.
//   1. ملف فارغ — POST /api/workbooks (phase 1).
//   2. من قالب ناف (phase 7) — GET /api/templates, then POST /api/workbooks
//      with `source: 'template'`: a copy of the template's snapshot (admins
//      manage templates from «الإعدادات» → «القوالب»).
//   3. رفع ملف Excel — an .xlsx from Excel or downloaded from Google Sheets:
//      POST /api/import/xlsx with the file's bytes (upload progress).
//   4. رابط Google Sheets — a public ("anyone with the link") file: POST
//      /api/import/gsheets-link; the platform downloads it as .xlsx itself.
//   Owner decision 2026-11-11: there is no Google OAuth secret, so neither
//   option goes through Google's consent (the OAuth routes stay in the API,
//   unused by this screen). After either import the import report opens.
//   `/?import=<id>` still opens the dialog on option 4 with the id filled in.
// OPEN: the phase 1 contract has no rename endpoint, so the title is asked
// here, once (apps/web/OPEN_QUESTIONS.md #2).

import { useEffect, useId, useRef, useState } from 'react'
import type { DragEvent, FormEvent, RefObject } from 'react'
import { FileSpreadsheet, FileUp, LayoutTemplate, Link2, LoaderCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ImportGsheetsLinkRequest, TemplateSummary } from '@naf-sheets/shared'
import { XLSX_MAX_FILE_BYTES } from '@naf-sheets/shared'
import { api, errorMessage, isAbortError } from '../lib/api'
import { parseSpreadsheetSource } from '../lib/gsheets-source'
import { uploadXlsx } from '../lib/upload'
import { checkXlsxFile, formatMegabytes, XLSX_ACCEPT } from '../lib/xlsx-file'
import { t } from '../strings'

type Choice = 'blank' | 'template' | 'xlsx' | 'gsheets'
type Busy = null | 'creating' | 'uploading' | 'importing'
const MAX_MB = Math.round(XLSX_MAX_FILE_BYTES / (1024 * 1024))
type Templates = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; list: TemplateSummary[] }

export function NewWorkbookDialog({
  open,
  initialImport,
  onClose,
  onCreated,
  onImported,
}: {
  open: boolean
  /** A spreadsheet id to start the link import with (`/?import=<id>`). */
  initialImport?: string | undefined
  onClose: () => void
  onCreated: (id: string) => void
  onImported: (workbookId: string) => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const sourceRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [progress, setProgress] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const [choice, setChoice] = useState<Choice>('blank')
  const [title, setTitle] = useState<string>(t.newFile.defaultTitle)
  const [source, setSource] = useState('')
  const [importTitle, setImportTitle] = useState('')
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [templates, setTemplates] = useState<Templates>({ kind: 'idle' })
  const [templateId, setTemplateId] = useState('')
  const templateRef = useRef<HTMLSelectElement>(null)
  // Which field takes the focus once the dialog has rendered its option's fields.
  const focusOnOpen = useRef<'title' | 'source' | 'file' | null>(null)
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
      setFile(null)
      setProgress(0)
      setDragOver(false)
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
    } else if (focusOnOpen.current === 'file' && fileRef.current) {
      fileRef.current.focus()
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

  const importLink = async () => {
    const check = parseSpreadsheetSource(source)
    if (!check.ok) {
      setError(t.newFile.sourceProblems[check.problem])
      sourceRef.current?.focus()
      return
    }
    setError(null)
    setBusy('importing')
    try {
      // OPEN: the id is sent rather than the pasted address (the contract takes either), OPEN_QUESTIONS.md #27.
      const body: ImportGsheetsLinkRequest = { source: check.spreadsheetId }
      const wanted = importTitle.trim()
      if (wanted) body.title = wanted
      const { workbookId } = await api.importGsheetsLink(body)
      setBusy(null)
      onImported(workbookId)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(null)
    }
  }

  const pickFile = (picked: File | null) => {
    setFile(picked)
    setError(null)
    if (picked) {
      const check = checkXlsxFile(picked)
      if (!check.ok) setError(t.newFile.fileProblems[check.problem])
    }
  }

  const importFile = async () => {
    const check = checkXlsxFile(file)
    if (!check.ok || !file) {
      setError(t.newFile.fileProblems[check.ok ? 'missing' : check.problem])
      fileRef.current?.focus()
      return
    }
    setError(null)
    setProgress(0)
    setBusy('uploading')
    try {
      const wanted = importTitle.trim()
      const { workbookId } = await uploadXlsx(file, {
        ...(wanted ? { title: wanted } : {}),
        onProgress: (loaded, total) => {
          setProgress(total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0)
          if (total > 0 && loaded >= total) setBusy('importing')
        },
      })
      setBusy(null)
      onImported(workbookId)
    } catch (err) {
      if (!isAbortError(err)) setError(errorMessage(err))
      setBusy(null)
    }
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    if (busy) return
    const dropped = e.dataTransfer.files?.[0] ?? null
    if (dropped) pickFile(dropped)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (choice === 'blank') void createBlank()
    else if (choice === 'template') void createFromTemplate()
    else if (choice === 'xlsx') void importFile()
    else if (choice === 'gsheets') void importLink()
  }

  const status = busy === 'uploading' ? t.newFile.uploading(progress) : busy === 'importing' ? t.newFile.importing : null
  const importing = choice === 'xlsx' || choice === 'gsheets'

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
          <ChoiceCard
            name={`${ids}-choice`}
            value="blank"
            checked={choice === 'blank'}
            onChoose={choose}
            Icon={FileSpreadsheet}
            label={t.newFile.blankOption}
            hint={t.newFile.blankHint}
          />
          <ChoiceCard
            name={`${ids}-choice`}
            value="template"
            checked={choice === 'template'}
            onChoose={choose}
            Icon={LayoutTemplate}
            label={t.newFile.templateOption}
            hint={t.newFile.templateHint}
          />
          <ChoiceCard
            name={`${ids}-choice`}
            value="xlsx"
            checked={choice === 'xlsx'}
            onChoose={choose}
            Icon={FileUp}
            label={t.newFile.xlsxOption}
            hint={t.newFile.xlsxHint}
          />
          <ChoiceCard
            name={`${ids}-choice`}
            value="gsheets"
            checked={choice === 'gsheets'}
            onChoose={choose}
            Icon={Link2}
            label={t.newFile.importOption}
            hint={t.newFile.importHint}
          />
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

        {choice === 'xlsx' ? (
          <div className="field">
            <span className="field-label" id={`${ids}-file-label`}>
              {t.newFile.fileLabel}
            </span>
            <div
              className={`dropzone import-dropzone${dragOver ? ' is-active' : ''}`}
              data-testid="xlsx-dropzone"
              onDragOver={(e) => {
                e.preventDefault()
                if (!busy) setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
            >
              <FileSpreadsheet className="icon" aria-hidden="true" />
              {file ? (
                <p className="import-dropzone__file" data-testid="xlsx-chosen">
                  <bdi dir="ltr">{file.name}</bdi>
                  <span className="muted num">
                    <bdi dir="ltr">{t.newFile.fileSize(formatMegabytes(file.size))}</bdi>
                  </span>
                </p>
              ) : (
                <p className="muted">{t.newFile.fileDrop}</p>
              )}
              <label className="button button--small" htmlFor={`${ids}-file`}>
                {file ? t.newFile.fileChange : t.newFile.fileChoose}
              </label>
              <input
                ref={fileRef}
                id={`${ids}-file`}
                className="sr-only"
                type="file"
                name="file"
                accept={XLSX_ACCEPT}
                aria-labelledby={`${ids}-file-label`}
                aria-describedby={error ? `${errorId} ${ids}-file-hint` : `${ids}-file-hint`}
                aria-invalid={error ? true : undefined}
                onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <p id={`${ids}-file-hint`} className="field-hint">
              {t.newFile.fileHint(MAX_MB)}
            </p>
            {busy === 'uploading' ? <progress className="import-progress" max={100} value={progress} aria-label={t.newFile.uploading(progress)} /> : null}
          </div>
        ) : null}

        {choice === 'gsheets' ? (
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
              aria-describedby={error ? `${errorId} ${ids}-link-help` : `${ids}-link-help`}
            />
            <p id={`${ids}-link-help`} className="field-hint">
              {t.newFile.linkHelp}
            </p>
          </div>
        ) : null}

        {importing ? (
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
              {choice === 'xlsx' ? t.newFile.uploadTitleHint : t.newFile.importTitleHint}
            </p>
          </div>
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
            {importing ? t.newFile.importSubmit : busy === 'creating' ? t.newFile.creating : t.newFile.create}
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
      <input
        type="radio"
        id={id}
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onChoose(value)}
        aria-describedby={`${id}-hint`}
      />
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
