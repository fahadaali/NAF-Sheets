// Phase 7 (spec §15): templates (§7.1), the internal API (§13) and its
// service tokens, backups (§14). The sync-health report the admin screen reads
// is src/sync/routes.ts (GET /api/admin/sync-health, §9.4).

export { adminTemplateRoutes, createWorkbookFromTemplate, templateKey, templateRoutes } from './templates'
export { apiTokenRoutes, newTokenSecret, sha256Hex, tokenFromRequest, TOKEN_PREFIX } from './api-tokens'
export { dayOf, internalApiRoutes, statusOf, workbookTasks } from './internal-api'
export { backupRoutes, runBackup, BACKUP_PAGE_ROWS, type BackupResult } from './backup'
