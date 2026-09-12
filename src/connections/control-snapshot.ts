import { may } from '../auth/authorization'
import {
  builtinConnection,
  builtinConnectionId,
} from '../gateway/builtin-tools'
import { findBundledMcp } from './bundled-mcps'
import { evaluateToolPolicy } from './policy'
import type { PrincipalAuthorization } from '../auth/authorization'
import type { ToolPolicy, TransportConfig } from './types'
import type { Pool } from 'pg'

export async function connectionSnapshot(
  pool: Pool,
  authorization: PrincipalAuthorization,
  url: URL,
  auditRows: (pool: Pool, url: URL) => Promise<{ rows: Array<unknown> }>,
) {
  const canConnections = may(authorization, 'manage_connections')
  const canAccounts = may(authorization, 'manage_accounts')
  const canAudit = may(authorization, 'view_audit')
  const organization = await pool.query<{ id: string }>(
    'SELECT id FROM organizations LIMIT 1',
  )
  const organizationId = organization.rows[0]?.id
  const [connections, sources, settings, audit] = await Promise.all([
    pool.query(
      `SELECT c.id,c.display_name,c.namespace,c.transport,c.transport_config,c.state,c.revision,
      c.registry_server_id,c.registry_version,h.healthy,h.error,h.checked_at,
      (SELECT COUNT(*)::int FROM mcp_accounts a WHERE a.connection_id=c.id AND (a.kind='shared' OR a.owner_user_id=$2)) account_count,
      COALESCE(array_agg(DISTINCT cg.group_id) FILTER (WHERE cg.group_id IS NOT NULL),'{}') group_ids
      FROM mcp_connections c LEFT JOIN connection_groups cg ON cg.connection_id=c.id
      LEFT JOIN connection_health h ON h.connection_id=c.id
      WHERE $1 OR EXISTS (SELECT 1 FROM connection_groups visible_cg JOIN group_memberships visible_gm ON visible_gm.group_id=visible_cg.group_id WHERE visible_cg.connection_id=c.id AND visible_gm.principal_id=$2)
      GROUP BY c.id,h.healthy,h.error,h.checked_at ORDER BY c.display_name`,
      [canConnections || canAccounts, authorization.id],
    ),
    canConnections
      ? pool.query(
          'SELECT id,display_name,base_url,is_official FROM registry_sources ORDER BY is_official DESC,display_name',
        )
      : Promise.resolve({ rows: [] }),
    pool.query(
      'SELECT audit_retention_days FROM gateway_settings WHERE singleton',
    ),
    canAudit ? auditRows(pool, url) : Promise.resolve({ rows: [] }),
  ])
  const detailId = url.searchParams.get('connection')
  const builtin = canConnections ? await builtinConnection(pool) : undefined
  const detail =
    detailId === builtinConnectionId
      ? builtin
      : detailId
        ? await connectionDetail(
            pool,
            detailId,
            authorization.id,
            canConnections || canAccounts,
          )
        : undefined
  return Response.json({
    authorization: {
      administrator: authorization.administrator,
      capabilities: [...authorization.capabilities],
    },
    approvalMethod: (
      await pool.query(
        'SELECT approval_method FROM users WHERE principal_id=$1',
        [authorization.id],
      )
    ).rows[0]?.approval_method,
    organizationId,
    connections: [
      ...(builtin ? [builtin] : []),
      ...connections.rows.map(({ transport_config, ...connection }) => ({
        ...connection,
        icon: findBundledMcp(
          scrubTransport(transport_config as TransportConfig),
        )?.icon,
      })),
    ],
    registrySources: sources.rows,
    auditRetentionDays: settings.rows[0]?.audit_retention_days ?? 90,
    audit: audit.rows,
    detail,
  })
}

async function connectionDetail(
  pool: Pool,
  id: string,
  userId: string,
  canViewAll: boolean,
) {
  const [connection, policies, tools, accounts] = await Promise.all([
    pool.query(
      `SELECT id,display_name,namespace,transport,transport_config,state,revision,
       registry_source_id,registry_server_id,registry_version,
       oauth_client_ciphertext IS NOT NULL has_oauth,
       ARRAY(SELECT group_id FROM connection_groups WHERE connection_id=c.id) group_ids,
       EXISTS (SELECT 1 FROM connection_groups cg JOIN group_memberships gm ON gm.group_id=cg.group_id WHERE cg.connection_id=c.id AND gm.principal_id=$3) personal_account_eligible
       FROM mcp_connections c WHERE id=$1 AND ($2 OR EXISTS (
         SELECT 1 FROM connection_groups cg
         JOIN group_memberships gm ON gm.group_id=cg.group_id
         WHERE cg.connection_id=c.id AND gm.principal_id=$3))`,
      [id, canViewAll, userId],
    ),
    pool.query(
      'SELECT pattern,effect FROM tool_policies WHERE connection_id=$1 ORDER BY pattern',
      [id],
    ),
    pool.query(
      'SELECT name,description,input_schema,output_schema FROM connection_tools WHERE connection_id=$1 ORDER BY name',
      [id],
    ),
    pool.query(
      `SELECT id,kind,owner_user_id,display_name,namespace,secret_ciphertext IS NOT NULL has_secret
      FROM mcp_accounts WHERE connection_id=$1 AND (kind='shared' OR owner_user_id=$2) ORDER BY display_name`,
      [id, userId],
    ),
  ])
  const row = connection.rows[0]
  if (!row) return undefined
  const transport = scrubTransport(row.transport_config as TransportConfig)
  return {
    ...row,
    transport_config: transport,
    policies: policies.rows,
    tools: tools.rows.map((tool) => ({
      ...tool,
      policy: evaluateToolPolicy(
        policies.rows as Array<ToolPolicy>,
        tool.name as string,
      ),
    })),
    accounts: accounts.rows,
  }
}

function scrubTransport(transport: TransportConfig): TransportConfig {
  if (transport.kind === 'stdio')
    return {
      ...transport,
      ...(transport.environment
        ? {
            environment: Object.fromEntries(
              Object.keys(transport.environment).map((key) => [key, '']),
            ),
          }
        : {}),
    }
  return {
    ...transport,
    ...(transport.headers
      ? {
          headers: Object.fromEntries(
            Object.keys(transport.headers).map((key) => [key, '']),
          ),
        }
      : {}),
  }
}
