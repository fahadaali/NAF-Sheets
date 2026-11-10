// Google Sheets import (spec §7.2): OAuth for the importing user, read-only
// spreadsheets.get, conversion with @naf-sheets/gsheets-import, and the
// import report. Wire it in createApp() after the auth guard:
//
//   registerGoogleImportRoutes(app)

export { registerGoogleImportRoutes } from './routes'
export { DEFAULT_LIMITS, type GoogleImportEnv, type GoogleImportLimits, type GoogleImportOptions } from './config'
export { GOOGLE_MESSAGES, type GoogleErrorBody, type GoogleImportErrorCode } from './errors'
