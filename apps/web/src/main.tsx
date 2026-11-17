import { createRoot } from 'react-dom/client'
// OPEN: community packaging of the Thmanyah font whose CSS loads the files
// from jsDelivr (phase 0 choice). Production must self-host the official files
// once their licence (font.thmanyah.com/licenses) is confirmed to allow web
// embedding — docs/phase-0-report.md §2.6, apps/web/OPEN_QUESTIONS.md.
import '@dawod/thmanyah-font-web/sans.css'
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
