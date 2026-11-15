// Who may do what (spec §3). Authentication is central (naf-id), permissions
// are local: the platform role in `members.role`.
//
//   admin  → creates, changes and removes links; maps names; members; appearance
//   editor, viewer → read only (the station has no editing role of its own)

import type { PlatformRole } from '@naf-sheets/shared'

export interface Caller {
  id: string
  role: PlatformRole
}
