import type { Pool } from 'pg'

export async function grantAccess(
  pool: Pool,
  organizationId: string,
  email: string,
  groupIds: Array<string>,
) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const access = await client.query<{ id: string }>(
      `INSERT INTO pre_provisioned_access(id,organization_id,normalized_email,expires_at)
       VALUES($1,$2,$3,now()+interval '7 days')
       ON CONFLICT (organization_id,normalized_email) DO UPDATE SET
         expires_at=EXCLUDED.expires_at,
         revoked_at=NULL
       WHERE pre_provisioned_access.claimed_at IS NULL
       RETURNING id`,
      [crypto.randomUUID(), organizationId, email],
    )
    const id = access.rows[0]?.id
    if (!id) throw new Error('This user has already claimed access')
    await client.query(
      'DELETE FROM pre_provisioned_access_groups WHERE access_id=$1',
      [id],
    )
    for (const groupId of new Set(groupIds))
      await client.query(
        'INSERT INTO pre_provisioned_access_groups(access_id,group_id) VALUES($1,$2)',
        [id, groupId],
      )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
