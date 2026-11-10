import { lazy, Suspense, useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { CurrentUser } from '@naf-sheets/shared'
import { api } from './lib/api'
import { useRoute } from './lib/router'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Notice } from './components/Notice'
import { FilesScreen } from './screens/FilesScreen'
import { ImportReportScreen } from './screens/ImportReportScreen'
import { DeniedScreen, NotFoundScreen } from './screens/MessageScreens'
import { PeopleMatchesScreen } from './screens/PeopleMatchesScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { t } from './strings'

// Univer (~2 MB gzip) is reachable only through this chunk.
const EditorScreen = lazy(() => import('./editor/EditorScreen'))
// The linking wizard bundles the wizard helpers of @naf-sheets/gsheets-import.
const LinkWizardScreen = lazy(() => import('./wizard/LinkWizardScreen'))

/**
 * The signed-in user, for the app bar and for hiding actions a platform
 * viewer cannot take. `settled` turns true once /api/me answered or failed.
 */
function useCurrentUser(enabled: boolean): { user: CurrentUser | null; settled: boolean } {
  const [state, setState] = useState<{ user: CurrentUser | null; settled: boolean }>({ user: null, settled: false })
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    // A 401 redirects to sign-in inside the client; any other failure only
    // means the name is not shown: every screen still works, and the API
    // enforces permissions on its own.
    api.me(controller.signal).then(
      (res) => setState({ user: res.user, settled: true }),
      () => {
        if (!controller.signal.aborted) setState({ user: null, settled: true })
      },
    )
    return () => controller.abort()
  }, [enabled])
  return state
}

function EditorLoading({ text = t.editor.loading }: { text?: string }) {
  return (
    <div className="editor">
      <div className="panel panel--plain editor-message" role="status">
        <LoaderCircle className="panel__icon spin" aria-hidden="true" />
        <p>{text}</p>
      </div>
    </div>
  )
}

function EditorChunkFailed({ message = t.editor.chunkFailed }: { message?: string }) {
  return (
    <div className="editor-message">
      <Notice
        tone="danger"
        actions={
          <button type="button" className="button button--small" onClick={() => window.location.reload()}>
            {t.editor.reloadPage}
          </button>
        }
      >
        <p>{message}</p>
      </Notice>
    </div>
  )
}

export function App() {
  const route = useRoute()
  const { user, settled } = useCurrentUser(route.name !== 'denied')

  switch (route.name) {
    case 'files':
      return <FilesScreen initialQuery={route.q} initialImport={route.importSource} user={user} />
    case 'editor':
      return (
        <ErrorBoundary key={route.id} fallback={<EditorChunkFailed />}>
          <Suspense fallback={<EditorLoading />}>
            <EditorScreen key={route.id} id={route.id} target={route.target} />
          </Suspense>
        </ErrorBoundary>
      )
    case 'importReport':
      return <ImportReportScreen key={route.id} id={route.id} user={user} />
    case 'linkWizard':
      return (
        <ErrorBoundary key={`link-${route.id}`} fallback={<EditorChunkFailed message={t.wizard.chunkFailed} />}>
          <Suspense fallback={<EditorLoading text={t.wizard.loading} />}>
            <LinkWizardScreen key={route.id} id={route.id} />
          </Suspense>
        </ErrorBoundary>
      )
    case 'settings':
      return <SettingsScreen user={user} />
    case 'peopleMatches':
      return <PeopleMatchesScreen user={user} userSettled={settled} />
    case 'denied':
      return <DeniedScreen reason={route.reason} />
    case 'notFound':
      return <NotFoundScreen user={user} />
  }
}
