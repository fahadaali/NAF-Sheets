// Append-only audit log (spec §14): every deletion, link and permission change.
// The statement is returned rather than run, so it goes into the same D1
// batch (one transaction) as the change it records.

export interface AuditEntry {
  /** members.user_id; null for the system (cron, queue). */
  actorId: string | null
  /** Dotted name, e.g. 'workbook.create', 'workbook.members.replace'. */
  action: string
  entityType: string
  entityId: string
  workbookId: string | null
  details: unknown
}

export function auditStatement(db: D1Database, entry: AuditEntry, at: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_log (at, actor_id, action, entity_type, entity_id, workbook_id, details_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(at, entry.actorId, entry.action, entry.entityType, entry.entityId, entry.workbookId, JSON.stringify(entry.details ?? {}))
}
