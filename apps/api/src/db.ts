// Small D1 reads shared by the route modules.

export interface MemberIdentity {
  user_id: string
  display_name: string | null
  email: string | null
  role: string
}

export async function getMemberIdentity(db: D1Database, userId: string): Promise<MemberIdentity | null> {
  return db
    .prepare('SELECT user_id, display_name, email, role FROM members WHERE user_id = ?1')
    .bind(userId)
    .first<MemberIdentity>()
}
