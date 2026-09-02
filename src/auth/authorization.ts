import type { Pool, PoolClient } from 'pg'

export const capabilities = [
  'manage_connections',
  'manage_accounts',
  'manage_principals_groups',
  'manage_sso',
  'view_audit',
] as const

export type Capability = (typeof capabilities)[number]

export interface PrincipalAuthorization {
  id: string
  disabled: boolean
  administrator: boolean
  capabilities: ReadonlySet<Capability>
}

export function may(principal: PrincipalAuthorization, capability: Capability) {
  return (
    !principal.disabled &&
    (principal.administrator || principal.capabilities.has(capability))
  )
}

export function assertAdministratorChange(
  activeAdministratorCount: number,
  removesActiveAdministrator: boolean,
) {
  if (removesActiveAdministrator && activeAdministratorCount <= 1) {
    throw new Error(
      'The final active Administrator cannot be removed or disabled',
    )
  }
}

export async function loadAuthorization(
  principalId: string,
  pool: Pool,
): Promise<PrincipalAuthorization | undefined> {
  const result = await pool.query<{
    id: string
    disabled: boolean
    administrator: boolean
    capability: Capability | null
  }>(
    `SELECT p.id, p.disabled_at IS NOT NULL AS disabled,
      bool_or(g.is_administrators) AS administrator,
      gc.capability_name AS capability
     FROM principals p
     LEFT JOIN group_memberships gm ON gm.principal_id = p.id
     LEFT JOIN groups g ON g.id = gm.group_id
     LEFT JOIN group_capabilities gc ON gc.group_id = g.id
     WHERE p.id = $1
     GROUP BY p.id, p.disabled_at, gc.capability_name`,
    [principalId],
  )
  if (!result.rows[0]) return undefined
  return {
    id: principalId,
    disabled: result.rows[0].disabled,
    administrator: result.rows.some(({ administrator }) => administrator),
    capabilities: new Set(
      result.rows.flatMap(({ capability }) => (capability ? [capability] : [])),
    ),
  }
}

export async function claimPreProvisionedAccess(
  user: {
    id: string
    name: string
    email: string
    emailVerified: boolean
    issuer?: string
    subject?: string
  },
  pool: Pool,
) {
  if (!user.emailVerified) throw new Error('SSO email must be verified')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const organization = await client.query<{ id: string }>(
      'SELECT id FROM organizations LIMIT 1',
    )
    const organizationId = organization.rows[0]?.id
    if (!organizationId) throw new Error('Gateway bootstrap is incomplete')
    const existing = await client.query<{
      oidc_issuer: string | null
      oidc_subject: string | null
    }>(
      'SELECT oidc_issuer, oidc_subject FROM users WHERE principal_id = $1 FOR UPDATE',
      [user.id],
    )
    const identity = existing.rows[0]
    if (
      identity &&
      ((identity.oidc_issuer && identity.oidc_issuer !== user.issuer) ||
        (identity.oidc_subject && identity.oidc_subject !== user.subject))
    )
      throw new Error('SSO identity does not match the bound identity')
    await client.query(
      `INSERT INTO principals (id, organization_id, kind, display_name)
       VALUES ($1, $2, 'user', $3)
       ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`,
      [user.id, organizationId, user.name],
    )
    await client.query(
      `INSERT INTO users (principal_id, email, oidc_issuer, oidc_subject)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (principal_id) DO UPDATE SET
         email = EXCLUDED.email,
         oidc_issuer = COALESCE(users.oidc_issuer, EXCLUDED.oidc_issuer),
         oidc_subject = COALESCE(users.oidc_subject, EXCLUDED.oidc_subject)`,
      [user.id, user.email, user.issuer ?? null, user.subject ?? null],
    )
    const access = await client.query<{ id: string }>(
      `UPDATE pre_provisioned_access
       SET claimed_by_user_id = $1, claimed_at = now()
       WHERE organization_id = $2 AND normalized_email = lower(trim($3))
         AND claimed_at IS NULL AND revoked_at IS NULL AND expires_at > now()
       RETURNING id`,
      [user.id, organizationId, user.email],
    )
    if (access.rows[0])
      await assignPreparedGroups(client, access.rows[0].id, user.id)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function assignPreparedGroups(
  client: PoolClient,
  accessId: string,
  principalId: string,
) {
  await client.query(
    `INSERT INTO group_memberships (group_id, principal_id)
     SELECT group_id, $2 FROM pre_provisioned_access_groups WHERE access_id = $1
     ON CONFLICT DO NOTHING`,
    [accessId, principalId],
  )
}
