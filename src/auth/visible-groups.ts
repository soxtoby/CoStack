import { may } from './authorization'
import type { PrincipalAuthorization } from './authorization'
import type { Pool } from 'pg'

export interface VisibleGroup {
  id: string
  display_name: string
  is_administrators: boolean
  capabilities: Array<string>
}

/**
 * Lists the Groups a Principal may see. Connection managers need every Group to
 * assign Group access, but only Group managers see which Capabilities each holds.
 */
export async function visibleGroups(
  pool: Pool,
  authorization: PrincipalAuthorization,
): Promise<Array<VisibleGroup>> {
  if (may(authorization, 'manage_principals_groups')) {
    const groups =
      await pool.query<VisibleGroup>(`SELECT g.id,g.display_name,g.is_administrators,
      COALESCE(array_agg(gc.capability_name) FILTER (WHERE gc.capability_name IS NOT NULL), '{}') AS capabilities
      FROM groups g LEFT JOIN group_capabilities gc ON gc.group_id=g.id GROUP BY g.id ORDER BY g.is_administrators DESC,g.display_name`)
    return groups.rows
  } else if (may(authorization, 'manage_connections')) {
    const groups =
      await pool.query<VisibleGroup>(`SELECT id,display_name,is_administrators,'{}'::text[] AS capabilities
      FROM groups ORDER BY is_administrators DESC,display_name`)
    return groups.rows
  } else {
    return []
  }
}
