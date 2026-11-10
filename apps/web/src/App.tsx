import { lazy, Suspense, useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { CurrentUser } from '@naf-sheets/shared'
import { api } from './lib/api'
import { useRoute } from './lib/router'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Notice } from './components/Notice'
import { FilesScreen } from './screens/FilesScreen'
import { DeniedScreen, NotFoundScreen } from './screens/MessageScreens'
import { t } from './strings'

// Univer (~2 MB gzip) is reachable only through this chunk.
const EditorScreen = lazy(() => import('./editor/EditorScreen'))

/** The signed-in user, for the app bar and for hiding actions a platform viewer cannot take. */
function useCurrentUser(enabled: boolean): CurrentUser | null {
  const [user, setUser] = useState<CurrentUser | null>(null)
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    // A 401 redirects to sign-in inside the client; any other failure only
    // means the name is not shown: every screen still works, and the API
    // enforces permissions on its own.
    api.me(controller.signal).then(
      (res) => setUser(res.user),
      () => undefined,
    )
    return () => controller.abort()
  }, [enabled])
  return user
}

function EditorLoading() {
  return (
    <div className="editor">
      <div className="panel panel--plain editor-message" role="status">
        <LoaderCircle className="panel__icon spin" aria-hidden="true" />
        <p>{t.editor.loading}</p>
      </div>
    </div>
  )
}

function EditorChunkFailed() {
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
        <p>{t.editor.chunkFailed}</p>
      </Notice>
    </div>
  )
}

export function App() {
  const route = useRoute()
  const user = useCurrentUser(route.name !== 'denied')

  switch (route.name) {
    case 'files':
      return <FilesScreen initialQuery={route.q} user={user} />
    case 'editor':
      return (
        <ErrorBoundary key={route.id} fallback={<EditorChunkFailed />}>
          <Suspense fallback={<EditorLoading />}>
            <EditorScreen key={route.id} id={route.id} />
          </Suspense>
        </ErrorBoundary>
      )
    case 'denied':
      return <DeniedScreen reason={route.reason} />
    case 'notFound':
      return <NotFoundScreen user={user} />
  }
}
