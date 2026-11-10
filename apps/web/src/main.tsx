import { createRoot } from 'react-dom/client'
// OPEN: community packaging of the Thmanyah font whose CSS loads the files
// from jsDelivr (phase 0 choice). Production must self-host the official files
// once their licence (font.thmanyah.com/licenses) is confirmed to allow web
// embedding — docs/phase-0-report.md §2.6, apps/web/OPEN_QUESTIONS.md.
import '@dawod/thmanyah-font-web/sans.css'
import './styles/theme.css'
import './styles/app.css'
import { App } from './App'

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

// No <StrictMode>: its development double-mount would create and destroy a
// whole Univer instance (and re-run the RTL grid layer) on every editor open.
createRoot(root).render(<App />)
