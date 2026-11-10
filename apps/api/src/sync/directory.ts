// Names of the people a sheet can hold (spec §8.2, §9.5): Basecamp people
// from the caches and the platform's external contacts. sheet-model reads and
// writes the assignee cell with them; sync-engine names them in the managed
// block of a to-do's description.

import type { ExternalContact } from '@naf-sheets/shared'
import type { AssigneeDirectory } from '@naf-sheets/sheet-model'
import type { Directory } from '@naf-sheets/sync-engine'

export interface SyncDirectory {
  assignee: AssigneeDirectory
  block: Directory
}

interface PersonRow {
  bc_person_id: number
  name: string
}

interface ContactRow {
  id: string
  name: string
  organization: string | null
  email: string | null
  phone: string | null
}

/**
 * Project people first (a person removed from the project keeps their name:
 * they may still be assigned, §9.5), then account people not in the project.
 * External contacts include archived ones for the same reason.
 * `projectId` null: account people only (an unlinked workbook).
 */
export async function loadDirectory(db: D1Database, projectId: number | null): Promise<SyncDirectory> {
  const [projectResult, accountResult, contactResult] = await db.batch([
    db.prepare(`SELECT bc_person_id, name FROM bc_people_cache WHERE bc_project_id = ?1 ORDER BY removed_at IS NOT NULL, name, bc_person_id`).bind(projectId ?? -1),
    db.prepare(`SELECT bc_person_id, name FROM bc_account_people_cache ORDER BY removed_at IS NOT NULL, name, bc_person_id`),
    db.prepare(`SELECT id, name, organization, email, phone FROM external_contacts ORDER BY created_at, id`),
  ])
  const people: PersonRow[] = []
  const seen = new Set<number>()
  for (const row of [...((projectResult?.results ?? []) as unknown as PersonRow[]), ...((accountResult?.results ?? []) as unknown as PersonRow[])]) {
    if (seen.has(row.bc_person_id)) continue
    seen.add(row.bc_person_id)
    people.push(row)
  }
  const contacts = (contactResult?.results ?? []) as unknown as ContactRow[]
  const externals: ExternalContact[] = contacts.map((c) => ({ id: c.id, name: c.name, organization: c.organization, email: c.email, phone: c.phone }))
  return {
    assignee: { people: people.map((p) => ({ id: p.bc_person_id, name: p.name })), externals: externals.map((e) => ({ id: e.id, name: e.name })) },
    block: {
      externalContacts: new Map(externals.map((e) => [e.id, e])),
      personNames: new Map(people.map((p) => [p.bc_person_id, p.name])),
    },
  }
}
