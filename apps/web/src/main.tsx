import { createRoot } from 'react-dom/client'
// Thmanyah Sans, served from this Worker (public/fonts): no request leaves the platform.
import './styles/fonts.css'
import './styles/theme.css'
import './styles/app.css'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { t } from './strings'

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

// A render failure anywhere shows an Arabic message with a way out, never a blank page.
const crashed = (
  <main id="main" className="page" data-screen="crash">
    <section className="panel">
      <h1>{t.crash.title}</h1>
      <p>{t.crash.body}</p>
      <button type="button" className="button" onClick={() => window.location.reload()}>
        {t.crash.reload}
      </button>
    </section>
  </main>
)

createRoot(root).render(
  <ErrorBoundary fallback={crashed}>
    <App />
  </ErrorBoundary>,
)
