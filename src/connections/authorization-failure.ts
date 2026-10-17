import type { Pool } from 'pg'

/** The upstream server will not accept the Account's credentials until a person re-authorizes or reconfigures it. */
export class UpstreamAuthorizationRequiredError extends Error {}

/** Keeps the first recorded failure until the credentials change, so later symptoms do not hide the cause. */
export async function recordAuthorizationFailure(
  pool: Pool,
  accountId: string,
  reason: string,
) {
  await pool.query(
    `UPDATE mcp_accounts SET authorization_error=$2, authorization_failed_at=now()
     WHERE id=$1 AND authorization_error IS NULL`,
    [accountId, reason],
  )
}

export async function clearAuthorizationFailure(pool: Pool, accountId: string) {
  await pool.query(
    `UPDATE mcp_accounts SET authorization_error=NULL, authorization_failed_at=NULL
     WHERE id=$1 AND authorization_error IS NOT NULL`,
    [accountId],
  )
}
