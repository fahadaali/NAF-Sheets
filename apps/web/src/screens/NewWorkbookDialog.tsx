// «ملف جديد» (spec §7.1). Phase 1 offers the blank workbook only; templates
// and Google Sheets import arrive with phases 2 and 7.
// OPEN: the phase 1 contract has no rename endpoint, so the title is asked
// here, once (apps/web/OPEN_QUESTIONS.md #2).

import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { FileSpreadsheet, LoaderCircle } from 'lucide-react'
import { api, errorMessage } from '../lib/api'
import { t } from '../strings'

export function NewWorkbookDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState<string>(t.newFile.defaultTitle)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ids = useId()
  const headingId = `${ids}-heading`
  const inputId = `${ids}-title`
  const errorId = `${ids}-error`

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      setTitle(t.newFile.defaultTitle)
      setError(null)
      dialog.showModal()
      inputRef.current?.select()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    const value = title.trim()
    if (!value) {
      setError(t.newFile.titleRequired)
      inputRef.current?.focus()
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { id } = await api.createWorkbook(value)
      onCreated(id)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

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
        <div className="option-card">
          <FileSpreadsheet className="icon" aria-hidden="true" />
          <div>
            <strong>{t.newFile.blankOption}</strong>
            <p>{t.newFile.blankHint}</p>
          </div>
        </div>
        <div className="field">
          <label htmlFor={inputId}>{t.newFile.titleLabel}</label>
          <input
            ref={inputRef}
            id={inputId}
            name="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoComplete="off"
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
          />
          {error ? (
            <p id={errorId} className="field-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <div className="dialog__actions">
          <button type="submit" className="button button--primary" disabled={busy}>
            {busy ? <LoaderCircle className="icon spin" aria-hidden="true" /> : null}
            {busy ? t.newFile.creating : t.newFile.create}
          </button>
          <button type="button" className="button" onClick={onClose} disabled={busy}>
            {t.newFile.cancel}
          </button>
        </div>
      </form>
    </dialog>
  )
}
