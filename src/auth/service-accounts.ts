import type { Pool } from 'pg'

/**
 * Deletes a suspended Service Account and its OAuth client, which revokes any
 * tokens issued to it. Audit records keep the account's display name.
 */
export async function deleteServiceAccount(pool: Pool, principalId: string) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const deleted = await client.query<{ oauth_client_id: string | null }>(
      `DELETE FROM principals p USING service_accounts s
       WHERE p.id=$1 AND s.principal_id=p.id AND p.disabled_at IS NOT NULL
       RETURNING s.oauth_client_id`,
      [principalId],
    )
    if (!deleted.rowCount)
      throw new Error('Suspend the Service Account before deleting it')

    await client.query('DELETE FROM "oauthClient" WHERE "clientId"=$1', [
      deleted.rows[0]?.oauth_client_id,
    ])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
