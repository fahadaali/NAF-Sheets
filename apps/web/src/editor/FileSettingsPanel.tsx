// «إعدادات الملف» (spec §12.1 item 3), side panel. So far it holds the
// Basecamp link of the workbook: its project, or the way into the linking
// wizard (§7.3). Members, new-list behaviour and «مزامنة الآن» are later work.

import { useEffect, useId, useRef, useState } from 'react'
import { FolderKanban, LoaderCircle, X } from 'lucide-react'
import type { WorkbookResponse } from '@naf-sheets/shared'
import { Notice } from '../components/Notice'
import { t } from '../strings'

/**
 * Who sees «ربط بمشروع في Basecamp».
 * OPEN: the contract does not say who may link a workbook; the narrowest
 * reading is its owner or a platform admin (apps/web/OPEN_QUESTIONS.md #19).
 * The API decides in the end.
 */
export const canLinkWorkbook = (access: WorkbookResponse['workbook']['access']): boolean => access === 'owner' || access === 'admin'

export function FileSettingsPanel({
  open,
  workbook,
  onClose,
  onStartWizard,
}: {
  open: boolean
  workbook: WorkbookResponse['workbook']
  onClose: () => void
  /** Saves pending edits, then opens the wizard; resolves with an Arabic message when it could not. */
  onStartWizard: () => Promise<string | null>
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ids = useId()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      setError(null)
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  const start = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    const problem = await onStartWizard()
    setBusy(false)
    if (problem) setError(problem)
  }

  const linked = workbook.bcProjectId !== null
  return (
    <dialog
      ref={ref}
      className="side-panel"
      aria-labelledby={`${ids}-title`}
      onClose={onClose}
      onCancel={(e) => {
        if (busy) e.preventDefault()
      }}
      data-testid="file-settings"
    >
      <div className="side-panel__head">
        <h2 id={`${ids}-title`}>{t.fileSettings.title}</h2>
        <button type="button" className="icon-button" aria-label={t.fileSettings.close} title={t.fileSettings.close} onClick={onClose} disabled={busy}>
          <X className="icon" aria-hidden="true" />
        </button>
      </div>
      <section className="side-panel__section" aria-labelledby={`${ids}-basecamp`}>
        <h3 id={`${ids}-basecamp`} className="with-icon">
          <FolderKanban className="icon" aria-hidden="true" />
          {t.fileSettings.basecampSection}
        </h3>
        {linked ? (
          <p>
            {/* OPEN: the contract carries the project id only, not its name (OPEN_QUESTIONS.md #3). */}
            {t.fileSettings.linkedTo} <bdi className="num">{workbook.bcProjectId}</bdi>
          </p>
        ) : (
          <>
            <p className="muted">{t.fileSettings.unlinked}</p>
            {canLinkWorkbook(workbook.access) ? (
              <button type="button" className="button button--primary" onClick={() => void start()} disabled={busy} data-testid="start-link-wizard">
                {busy ? <LoaderCircle className="icon spin" aria-hidden="true" /> : null}
                {t.fileSettings.startWizard}
              </button>
            ) : (
              <p className="muted small">{t.fileSettings.ownerOnly}</p>
            )}
            {busy ? (
              <p className="muted small" role="status">
                {t.fileSettings.savingFirst}
              </p>
            ) : null}
            {error ? (
              <Notice tone="danger">
                <p>{error}</p>
              </Notice>
            ) : null}
          </>
        )}
      </section>
    </dialog>
  )
}
