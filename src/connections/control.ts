import { databasePool } from '../database/pool'
import { auth } from '../auth/auth'
import { loadAuthorization, may } from '../auth/authorization'
import { ConnectionManager, RevisionConflictError } from './manager'
import { OFFICIAL_REGISTRY, RegistryClient } from './registry'
import { SecretVault } from './secrets'
import { upstreamOAuthHandler } from './oauth-handler'
import { connectionSnapshot } from './control-snapshot'
import {
  controlActionAccess,
  mayPerformControlAction,
} from './control-authorization'
import type { Capability } from '../auth/authorization'
import type { ConnectionInput, ToolPolicy } from './types'
import type { Pool } from 'pg'

type Session = { user: { id: string; name: string; email: string } }
let managerPromise: Promise<ConnectionManager> | undefined

function manager() {
  managerPromise ??= SecretVault.fromBase64().then(
    (vault) => new ConnectionManager(databasePool(), vault),
  )
  return managerPromise
}

export async function refreshDueConnections() {
  await (await manager()).refreshDue()
}

export async function closeConnectionControl() {
  if (!managerPromise) return
  await (await managerPromise).close()
  managerPromise = undefined
}

async function principal(request: Request, capability?: Capability) {
  const current = (await auth.api.getSession({
    headers: request.headers,
  })) as Session | null
  if (!current) throw new Response('Unauthenticated', { status: 401 })
  const authorization = await loadAuthorization(current.user.id, databasePool())
  if (!authorization || authorization.disabled)
    throw new Response('Forbidden', { status: 403 })
  if (capability && !may(authorization, capability))
    throw new Response('Forbidden', { status: 403 })
  return { current, authorization }
}

export async function controlHandler(request: Request) {
  try {
    const url = new URL(request.url)
    if (
      request.method === 'GET' &&
      url.searchParams.get('download') === 'audit'
    )
      return downloadAudit(request, url)
    if (request.method === 'GET') return snapshot(request, url)
    const body = (await request.json()) as Record<string, unknown>
    const action = String(body.action ?? '')
    if (action === 'set-approval-method')
      return setApprovalMethod(request, body)
    if (action === 'create-personal-account')
      return await createPersonalAccount(request, body)
    if (
      action === 'replace-personal-secret' ||
      action === 'delete-personal-secret' ||
      action === 'delete-personal-account'
    )
      return await managePersonalAccount(request, body, action)
    if (controlActionAccess(action) === 'manage_connections') {
      const actor = await principal(request, 'manage_connections')
      return await connectionAction(body, action, actor.current.user.id)
    }
    if (controlActionAccess(action) === 'manage_accounts') {
      await principal(request, 'manage_accounts')
      return await accountAction(body, action)
    }
    if (action === 'set-audit-retention') {
      const actor = await principal(request)
      if (!mayPerformControlAction(actor.authorization, action))
        throw new Response('Forbidden', { status: 403 })
      return setAuditRetention(body)
    }
    throw new Error('Unknown action')
  } catch (error) {
    if (error instanceof Response) return error
    return Response.json(
      { error: error instanceof Error ? error.message : 'Request failed' },
      { status: error instanceof RevisionConflictError ? 409 : 400 },
    )
  }
}

export async function upstreamOAuthRequestHandler(request: Request) {
  try {
    if (request.method === 'GET')
      return await upstreamOAuthHandler(request, await manager())
    const actor = await principal(request)
    return await upstreamOAuthHandler(
      request,
      await manager(),
      actor.current.user.id,
    )
  } catch (error) {
    if (error instanceof Response) return error
    return Response.json(
      { error: error instanceof Error ? error.message : 'OAuth failed' },
      { status: 400 },
    )
  }
}

async function snapshot(request: Request, url: URL) {
  const actor = await principal(request)
  await ensureOfficialRegistrySource()
  return connectionSnapshot(databasePool(), actor.authorization, url, auditRows)
}

async function connectionAction(
  body: Record<string, unknown>,
  action: string,
  userId: string,
) {
  const service = await manager()
  if (action === 'set-tool-policies')
    return Response.json(
      await service.setToolPolicies(
        String(body.id),
        Number(body.revision),
        body.policies as Array<ToolPolicy>,
      ),
    )
  if (action === 'create-connection')
    return Response.json(await service.create(body.input as ConnectionInput))
  if (action === 'edit-connection')
    return Response.json(
      await service.edit(
        String(body.id),
        Number(body.revision),
        body.input as ConnectionInput,
        userId,
      ),
    )
  if (action === 'clone-connection')
    return Response.json(
      await service.clone(
        String(body.id),
        String(body.displayName),
        body.namespace ? String(body.namespace) : undefined,
      ),
    )
  if (action === 'set-enabled')
    return Response.json({
      revision: await service.setEnabled(
        String(body.id),
        Boolean(body.enabled),
      ),
    })
  if (action === 'refresh-connection') {
    await service.refreshConnection(String(body.id), userId)
    return Response.json({ ok: true })
  }
  if (action === 'create-registry-source') {
    const baseUrl = new URL(String(body.baseUrl)).toString().replace(/\/$/, '')
    await databasePool().query(
      'INSERT INTO registry_sources(id,organization_id,display_name,base_url) VALUES($1,$2,$3,$4)',
      [
        crypto.randomUUID(),
        String(body.organizationId),
        String(body.displayName).trim(),
        baseUrl,
      ],
    )
    return Response.json({ ok: true })
  }
  const source = await databasePool().query(
    'SELECT id,base_url FROM registry_sources WHERE id=$1',
    [String(body.sourceId)],
  )
  if (!source.rows[0]) throw new Error('Registry Source not found')
  if (action === 'browse-registry')
    return Response.json(
      await new RegistryClient(source.rows[0].base_url as string).list(
        String(body.search ?? ''),
        body.cursor ? String(body.cursor) : undefined,
      ),
    )
  const entry = await new RegistryClient(source.rows[0].base_url as string).get(
    String(body.serverName),
    String(body.version ?? 'latest'),
  )
  return Response.json({
    input: new RegistryClient().prefill(
      entry,
      String(body.organizationId),
      source.rows[0].id as string,
    ),
  })
}

async function accountAction(body: Record<string, unknown>, action: string) {
  const service = await manager()
  if (action === 'create-shared-account') {
    const secrets = objectStrings(body.secrets)
    return Response.json(
      await service.addAccount({
        connectionId: String(body.connectionId),
        kind: 'shared',
        displayName: String(body.displayName),
        ...(secrets ? { secrets } : {}),
      }),
    )
  }
  if (action === 'replace-shared-secret') {
    await assertAccountKind(body.id, 'shared')
    await service.replaceAccountSecrets(
      String(body.id),
      objectStrings(body.secrets) ?? {},
    )
    return Response.json({ ok: true })
  }
  if (action === 'delete-shared-secret') {
    await assertAccountKind(body.id, 'shared')
    await service.clearAccountSecrets(String(body.id))
    return Response.json({ ok: true })
  }
  if (action === 'delete-shared-account') {
    await assertAccountKind(body.id, 'shared')
    await service.deleteAccount(String(body.id))
    return Response.json({ ok: true })
  }
  await service.configureOAuth(String(body.connectionId), body.config as never)
  return Response.json({ ok: true })
}

async function createPersonalAccount(
  request: Request,
  body: Record<string, unknown>,
) {
  const actor = await principal(request)
  await assertEligible(String(body.connectionId), actor.current.user.id)
  const secrets = objectStrings(body.secrets)
  return Response.json(
    await (
      await manager()
    ).addAccount({
      connectionId: String(body.connectionId),
      kind: 'personal',
      ownerUserId: actor.current.user.id,
      displayName: String(body.displayName),
      ...(secrets ? { secrets } : {}),
    }),
  )
}

async function managePersonalAccount(
  request: Request,
  body: Record<string, unknown>,
  action: string,
) {
  const actor = await principal(request)
  const id = String(body.id)
  const found = await databasePool().query(
    "SELECT 1 FROM mcp_accounts WHERE id=$1 AND kind='personal' AND owner_user_id=$2",
    [id, actor.current.user.id],
  )
  if (!found.rows[0]) throw new Response('Forbidden', { status: 403 })
  const service = await manager()
  if (action === 'replace-personal-secret')
    await service.replaceAccountSecrets(id, objectStrings(body.secrets) ?? {})
  else if (action === 'delete-personal-secret')
    await service.clearAccountSecrets(id)
  else await service.deleteAccount(id)
  return Response.json({ ok: true })
}

async function assertEligible(connectionId: string, principalId: string) {
  const result = await databasePool().query(
    `SELECT 1 FROM connection_groups cg JOIN group_memberships gm ON gm.group_id=cg.group_id WHERE cg.connection_id=$1 AND gm.principal_id=$2 LIMIT 1`,
    [connectionId, principalId],
  )
  if (!result.rows[0])
    throw Response.json(
      {
        error:
          'Personal sign-in requires membership in a Group assigned to this connection. Edit Group access to assign one of your Groups, then try again.',
      },
      { status: 403 },
    )
}
async function assertAccountKind(id: unknown, kind: string) {
  const found = await databasePool().query(
    'SELECT 1 FROM mcp_accounts WHERE id=$1 AND kind=$2',
    [String(id), kind],
  )
  if (!found.rows[0]) throw new Error('Account not found')
}
async function setApprovalMethod(
  request: Request,
  body: Record<string, unknown>,
) {
  const actor = await principal(request)
  const method = String(body.method)
  if (!['gateway_enforced', 'client_managed'].includes(method))
    throw new Error('Invalid Approval Method')
  await databasePool().query(
    'UPDATE users SET approval_method=$1 WHERE principal_id=$2',
    [method, actor.current.user.id],
  )
  return Response.json({ ok: true })
}
async function setAuditRetention(body: Record<string, unknown>) {
  const days = Number(body.days)
  if (![30, 90, 180, 365].includes(days)) throw new Error('Invalid retention')
  await databasePool().query(
    'UPDATE gateway_settings SET audit_retention_days=$1 WHERE singleton',
    [days],
  )
  await databasePool().query(
    "DELETE FROM audit_records WHERE occurred_at < now() - ($1 * interval '1 day')",
    [days],
  )
  return Response.json({ ok: true })
}
function auditRows(pool: Pool, url: URL) {
  const values: Array<unknown> = []
  const clauses = ['organization_id=(SELECT id FROM organizations LIMIT 1)']
  for (const [key, column] of [
    ['principal', 'principal_id'],
    ['connection', 'connection_id'],
    ['outcome', 'outcome'],
  ] as const) {
    const value = url.searchParams.get(key)
    if (value) {
      values.push(value)
      clauses.push(`${column}=$${values.length}`)
    }
  }
  return pool.query(
    `SELECT occurred_at,principal_display_name,connection_id,account_id,tool_name,policy_effect,outcome,duration_ms,error_code FROM audit_records WHERE ${clauses.join(' AND ')} ORDER BY occurred_at DESC LIMIT 500`,
    values,
  )
}
async function downloadAudit(request: Request, url: URL) {
  await principal(request, 'view_audit')
  const rows = (await auditRows(databasePool(), url)).rows
  return new Response(rows.map((row) => JSON.stringify(row)).join('\n'), {
    headers: {
      'content-type': 'application/x-ndjson',
      'content-disposition': 'attachment; filename="costack-audit.jsonl"',
    },
  })
}
function objectStrings(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, String(item)]),
  )
}

export async function ensureOfficialRegistrySource() {
  const pool = databasePool()
  const org = await pool.query<{ id: string }>(
    'SELECT id FROM organizations LIMIT 1',
  )
  if (org.rows[0])
    await pool.query(
      `INSERT INTO registry_sources(id,organization_id,display_name,base_url,is_official) VALUES($1,$2,'Official MCP Registry',$3,true) ON CONFLICT (organization_id,base_url) DO NOTHING`,
      [crypto.randomUUID(), org.rows[0].id, OFFICIAL_REGISTRY],
    )
}
