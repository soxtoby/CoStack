import { createHash, randomUUID } from 'node:crypto'
import { evaluateToolPolicy } from '../connections/policy'
import { writeAudit } from './audit'
import { builtinConnection } from './builtin-tools'
import type { ConnectionManager } from '../connections/manager'
import type { ToolPolicy } from '../connections/types'
import type { GatewayPrincipal, GatewayTool, GatewayToolTarget } from './types'
import type { Pool } from 'pg'

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

export class GatewayService {
  async builtinToolPolicies() {
    return (await builtinConnection(this.pool)).policies
  }
  constructor(
    private pool: Pool,
    private connections: ConnectionManager,
  ) {}

  close() {
    return this.connections.close()
  }

  async loadPrincipal(
    subject: string,
    clientId?: string,
  ): Promise<GatewayPrincipal | undefined> {
    const result = await this.pool.query(
      `SELECT p.id, p.organization_id, p.kind, p.display_name, p.disabled_at,
              u.approval_method
       FROM principals p LEFT JOIN users u ON u.principal_id=p.id
       LEFT JOIN service_accounts sa ON sa.principal_id=p.id
       WHERE (p.id=$1 OR ($2::text IS NOT NULL AND sa.oauth_client_id=$2))
       LIMIT 1`,
      [subject, clientId ?? null],
    )
    const row = result.rows[0]
    if (!row || row.disabled_at) return undefined
    return {
      id: row.id as string,
      organizationId: row.organization_id as string,
      kind: row.kind,
      displayName: row.display_name as string,
      ...(row.approval_method ? { approvalMethod: row.approval_method } : {}),
    }
  }

  async search(
    principal: GatewayPrincipal,
    query = '',
  ): Promise<Array<GatewayTool>> {
    const result = await this.pool.query(
      `SELECT c.id connection_id, c.display_name connection_name, c.namespace connection_namespace,
              t.name tool_name, t.description, t.input_schema, t.output_schema,
              h.healthy, h.error health_error,
              a.id account_id, a.display_name account_name, a.namespace account_namespace, a.kind account_kind,
              p.pattern, p.effect
       FROM mcp_connections c
       JOIN connection_groups cg ON cg.connection_id=c.id
       JOIN group_memberships gm ON gm.group_id=cg.group_id AND gm.principal_id=$1
       JOIN connection_tools t ON t.connection_id=c.id
       JOIN tool_policies p ON p.connection_id=c.id
       LEFT JOIN connection_health h ON h.connection_id=c.id
       LEFT JOIN mcp_accounts a ON a.connection_id=c.id AND
         (a.kind='shared' OR (a.kind='personal' AND a.owner_user_id=$1))
       WHERE c.organization_id=$2 AND c.state='enabled'
         AND (a.id IS NOT NULL OR NOT EXISTS
           (SELECT 1 FROM mcp_accounts any_account WHERE any_account.connection_id=c.id))
       ORDER BY c.id, a.id, t.name`,
      [principal.id, principal.organizationId],
    )
    const grouped = new Map<
      string,
      { row: Record<string, unknown>; policies: Array<ToolPolicy> }
    >()
    for (const row of result.rows) {
      const key = `${row.connection_id}:${row.account_id ?? ''}:${row.tool_name}`
      const item: {
        row: Record<string, unknown>
        policies: Array<ToolPolicy>
      } = grouped.get(key) ?? { row, policies: [] }
      item.policies.push({
        pattern: row.pattern as string,
        effect: row.effect as ToolPolicy['effect'],
      })
      grouped.set(key, item)
    }
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const tools = [...grouped.values()].flatMap(({ row, policies }) => {
      const policy = evaluateToolPolicy(policies, row.tool_name as string)
      if (policy === 'block') return []
      const namespace = (row.account_namespace ??
        row.connection_namespace) as string
      const qualifiedName = `${namespace}__${row.tool_name}`
      return [
        {
          qualifiedName,
          connectionId: row.connection_id as string,
          connectionNamespace: row.connection_namespace as string,
          ...(row.account_id ? { accountId: row.account_id as string } : {}),
          ...(row.account_kind
            ? { accountKind: row.account_kind as 'personal' | 'shared' }
            : {}),
          ...(row.account_namespace
            ? { accountNamespace: row.account_namespace as string }
            : {}),
          connectionName: row.connection_name as string,
          ...(row.account_name
            ? { accountName: row.account_name as string }
            : {}),
          toolName: row.tool_name as string,
          ...(row.description
            ? { description: row.description as string }
            : {}),
          inputSchema: row.input_schema as Record<string, unknown>,
          ...(row.output_schema
            ? { outputSchema: row.output_schema as Record<string, unknown> }
            : {}),
          policy,
          available: row.healthy !== false,
          ...(row.health_error
            ? { healthError: row.health_error as string }
            : {}),
        } satisfies GatewayTool,
      ]
    })
    if (!terms.length) return tools
    const shortestPrefix = terms.length > 3 ? 2 : terms.length
    for (let length = terms.length; length >= shortestPrefix; length--) {
      const prefix = terms.slice(0, length)
      const matches = tools.filter((tool) => {
        const searchable =
          `${tool.qualifiedName} ${tool.connectionName} ${tool.accountName ?? ''} ${tool.description ?? ''}`.toLowerCase()
        return prefix.every((term) => searchable.includes(term))
      })
      if (matches.length) return matches
    }
    return []
  }

  async resolve(
    principal: GatewayPrincipal,
    target: string | GatewayToolTarget,
  ) {
    const tools = await this.search(principal)
    const matches = tools.filter((tool) =>
      typeof target === 'string'
        ? tool.qualifiedName === target
        : tool.connectionId === target.connectionId &&
          tool.accountId === target.accountId &&
          tool.toolName === target.toolName,
    )
    if (matches.length !== 1)
      throw new GatewayError(
        'Tool is unavailable or not authorized',
        'tool_not_found',
      )
    return matches[0]!
  }

  async call(
    principal: GatewayPrincipal,
    target: string | GatewayToolTarget,
    args: Record<string, unknown>,
    path: 'ordinary' | 'approved',
    clientId?: string,
    signal?: AbortSignal,
  ) {
    const started = performance.now()
    let tool: GatewayTool | undefined
    try {
      tool = await this.resolve(principal, target)
      if (!tool.available)
        throw new GatewayError(
          'Upstream MCP is unavailable',
          'connection_unavailable',
        )
      if (tool.policy === 'require_approval') {
        if (principal.kind === 'service_account')
          throw new GatewayError(
            'Service Accounts cannot use approval-required tools',
            'approval_unavailable',
          )
        if (
          principal.approvalMethod === 'client_managed' &&
          path !== 'approved'
        )
          throw new GatewayError(
            'Use call_tool_with_approval for this tool',
            'client_approval_required',
          )
        if (
          principal.approvalMethod !== 'client_managed' &&
          path !== 'approved'
        )
          throw new GatewayError(
            'Client approval is required',
            'gateway_approval_required',
          )
      } else if (path === 'approved') {
        throw new GatewayError(
          'This tool does not require approval',
          'approval_not_required',
        )
      }
      const result = await this.connections.callAccountTool(
        tool.connectionId,
        tool.accountId,
        tool.toolName,
        args,
        signal,
      )
      await this.audit(
        principal,
        tool,
        clientId,
        'success',
        performance.now() - started,
      )
      return result
    } catch (error) {
      await this.audit(
        principal,
        tool,
        clientId,
        'failure',
        performance.now() - started,
        error instanceof GatewayError ? error.code : 'upstream_error',
      )
      throw error
    }
  }

  async createApproval(
    principal: GatewayPrincipal,
    tool: GatewayTool,
    args: Record<string, unknown>,
  ) {
    const id = randomUUID(),
      nonce = randomUUID()
    await this.pool.query(
      `INSERT INTO approval_requests
       (id,principal_id,connection_id,account_id,tool_name,arguments_hash,policy_effect,nonce,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'require_approval',$7,now()+interval '5 minutes')`,
      [
        id,
        principal.id,
        tool.connectionId,
        tool.accountId ?? null,
        tool.toolName,
        hashArguments(args),
        nonce,
      ],
    )
    return { id, nonce }
  }

  async consumeApproval(
    principal: GatewayPrincipal,
    id: string,
    nonce: string,
    tool: GatewayTool,
    args: Record<string, unknown>,
  ) {
    const result = await this.pool.query(
      `UPDATE approval_requests SET consumed_at=now()
       WHERE id=$1 AND nonce=$2 AND principal_id=$3 AND connection_id=$4
         AND account_id IS NOT DISTINCT FROM $5 AND tool_name=$6 AND arguments_hash=$7
         AND policy_effect='require_approval' AND consumed_at IS NULL AND expires_at>now()
       RETURNING id`,
      [
        id,
        nonce,
        principal.id,
        tool.connectionId,
        tool.accountId ?? null,
        tool.toolName,
        hashArguments(args),
      ],
    )
    if (!result.rows[0])
      throw new GatewayError(
        'Approval is invalid, expired, or already used',
        'invalid_approval',
      )
  }

  private audit(
    principal: GatewayPrincipal,
    tool: GatewayTool | undefined,
    clientId: string | undefined,
    outcome: string,
    duration: number,
    errorCode?: string,
  ) {
    return writeAudit(this.pool, {
      organizationId: principal.organizationId,
      principalId: principal.id,
      principalDisplayName: principal.displayName,
      ...(clientId ? { clientId } : {}),
      ...(tool
        ? {
            connectionId: tool.connectionId,
            ...(tool.accountId ? { accountId: tool.accountId } : {}),
            toolName: tool.toolName,
            policy: tool.policy,
          }
        : {}),
      outcome,
      durationMs: Math.max(0, Math.round(duration)),
      ...(errorCode ? { errorCode } : {}),
    })
  }
}

function hashArguments(args: Record<string, unknown>) {
  return createHash('sha256').update(canonicalJson(args)).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
