import { createHash, randomBytes } from 'node:crypto'
import { databasePool } from '../database/pool'
import { auth } from './auth'
import {
  assertAdministratorChange,
  capabilities,
  loadAuthorization,
  may,
} from './authorization'
import type { Capability } from './authorization'

type Session = { user: { id: string; name: string; email: string } }

async function session(request: Request) {
  return (await auth.api.getSession({
    headers: request.headers,
  })) as Session | null
}

async function requireCapability(request: Request, capability: Capability) {
  const current = await session(request)
  if (!current) throw new Response('Unauthenticated', { status: 401 })
  const authorization = await loadAuthorization(current.user.id, databasePool())
  if (!authorization || !may(authorization, capability))
    throw new Response('Forbidden', { status: 403 })
  return { current, authorization }
}

export async function adminHandler(request: Request) {
  try {
    if (request.method === 'GET') return snapshot(request)
    const body = (await request.json()) as Record<string, unknown>
    const action = String(body.action ?? '')
    if (action === 'sign-out')
      return auth.api.signOut({
        headers: request.headers,
      }) as unknown as Response
    if (action === 'save-sso') return saveSso(request, body)
    await requireCapability(request, 'manage_principals_groups')
    if (action === 'create-group') return createGroup(body)
    if (action === 'create-access') return createAccess(body)
    if (action === 'revoke-access') return revokeAccess(body)
    if (action === 'set-membership') return setMembership(request, body)
    if (action === 'set-capabilities') return setCapabilities(request, body)
    if (action === 'set-disabled') return setDisabled(request, body)
    if (action === 'create-service-account') return createServiceAccount(body)
    return Response.json({ error: 'Unknown action' }, { status: 400 })
  } catch (error) {
    if (error instanceof Response) return error
    return Response.json(
      { error: error instanceof Error ? error.message : 'Request failed' },
      { status: 400 },
    )
  }
}

async function snapshot(request: Request) {
  const pool = databasePool()
  const settings = await pool.query<{ bootstrap_completed_at: Date | null }>(
    'SELECT bootstrap_completed_at FROM gateway_settings WHERE singleton',
  )
  if (!settings.rows[0]?.bootstrap_completed_at)
    return Response.json({ state: 'bootstrap' })
  const current = await session(request)
  if (!current) {
    const provider = await pool.query<{ provider_id: string }>(
      'SELECT "providerId" AS provider_id FROM "ssoProvider" LIMIT 1',
    )
    return Response.json({
      state: 'login',
      loginProviderId: provider.rows[0]?.provider_id,
    })
  }
  const authorization = await loadAuthorization(current.user.id, pool)
  if (!authorization || authorization.disabled)
    return Response.json({ state: 'forbidden' }, { status: 403 })
  const canManage = may(authorization, 'manage_principals_groups')
  const [organization, users, groups, access, services, providers] =
    await Promise.all([
      pool.query('SELECT display_name FROM organizations LIMIT 1'),
      canManage
        ? pool.query(`SELECT p.id, p.display_name, p.disabled_at, u.email,
          COALESCE(array_agg(g.id) FILTER (WHERE g.id IS NOT NULL), '{}') AS group_ids
          FROM principals p JOIN users u ON u.principal_id=p.id
          LEFT JOIN group_memberships gm ON gm.principal_id=p.id LEFT JOIN groups g ON g.id=gm.group_id
          GROUP BY p.id,u.email ORDER BY p.display_name`)
        : Promise.resolve({ rows: [] }),
      canManage
        ? pool.query(`SELECT g.id,g.display_name,g.is_administrators,
          COALESCE(array_agg(gc.capability_name) FILTER (WHERE gc.capability_name IS NOT NULL), '{}') AS capabilities
          FROM groups g LEFT JOIN group_capabilities gc ON gc.group_id=g.id GROUP BY g.id ORDER BY g.is_administrators DESC,g.display_name`)
        : Promise.resolve({ rows: [] }),
      canManage
        ? pool.query(`SELECT p.id,p.normalized_email,p.expires_at,p.claimed_at,p.revoked_at,
          COALESCE(array_agg(pg.group_id) FILTER (WHERE pg.group_id IS NOT NULL), '{}') AS group_ids
          FROM pre_provisioned_access p LEFT JOIN pre_provisioned_access_groups pg ON pg.access_id=p.id
          GROUP BY p.id ORDER BY p.created_at DESC`)
        : Promise.resolve({ rows: [] }),
      canManage
        ? pool.query(`SELECT p.id,p.display_name,p.disabled_at,s.oauth_client_id,
          COALESCE(array_agg(g.id) FILTER (WHERE g.id IS NOT NULL), '{}') AS group_ids
          FROM principals p JOIN service_accounts s ON s.principal_id=p.id
          LEFT JOIN group_memberships gm ON gm.principal_id=p.id LEFT JOIN groups g ON g.id=gm.group_id
          GROUP BY p.id,s.oauth_client_id ORDER BY p.display_name`)
        : Promise.resolve({ rows: [] }),
      may(authorization, 'manage_sso')
        ? pool.query(
            'SELECT providerId AS provider_id, domain, issuer FROM "ssoProvider"',
          )
        : Promise.resolve({ rows: [] }),
    ])
  return Response.json({
    state: 'ready',
    me: current.user,
    authorization: {
      administrator: authorization.administrator,
      capabilities: [...authorization.capabilities],
    },
    organization: organization.rows[0],
    users: users.rows,
    groups: groups.rows,
    access: access.rows,
    serviceAccounts: services.rows,
    providers: providers.rows,
    capabilityOptions: capabilities,
  })
}

async function organizationId() {
  const result = await databasePool().query<{ id: string }>(
    'SELECT id FROM organizations LIMIT 1',
  )
  if (!result.rows[0]) throw new Error('Organization is missing')
  return result.rows[0].id
}

async function createGroup(body: Record<string, unknown>) {
  const name = String(body.name ?? '').trim()
  if (!name) throw new Error('Group name is required')
  await databasePool().query(
    'INSERT INTO groups(id,organization_id,display_name) VALUES($1,$2,$3)',
    [crypto.randomUUID(), await organizationId(), name],
  )
  return Response.json({ ok: true })
}

async function createAccess(body: Record<string, unknown>) {
  const email = String(body.email ?? '')
    .trim()
    .toLowerCase()
  if (!email.includes('@')) throw new Error('Enter a valid email address')
  const id = crypto.randomUUID()
  const pool = databasePool()
  await pool.query(
    `INSERT INTO pre_provisioned_access(id,organization_id,normalized_email,expires_at)
    VALUES($1,$2,$3,now()+interval '7 days')`,
    [id, await organizationId(), email],
  )
  for (const groupId of stringArray(body.groupIds))
    await pool.query(
      'INSERT INTO pre_provisioned_access_groups(access_id,group_id) VALUES($1,$2)',
      [id, groupId],
    )
  return Response.json({ ok: true })
}

async function revokeAccess(body: Record<string, unknown>) {
  await databasePool().query(
    'UPDATE pre_provisioned_access SET revoked_at=now() WHERE id=$1 AND claimed_at IS NULL',
    [String(body.id)],
  )
  return Response.json({ ok: true })
}

async function setMembership(request: Request, body: Record<string, unknown>) {
  const pool = databasePool()
  const group = await pool.query<{ is_administrators: boolean }>(
    'SELECT is_administrators FROM groups WHERE id=$1',
    [String(body.groupId)],
  )
  const adding = Boolean(body.enabled)
  if (group.rows[0]?.is_administrators) {
    const actor = await requireCapability(request, 'manage_principals_groups')
    if (!actor.authorization.administrator)
      throw new Response(
        'Only Administrators may change Administrator membership',
        { status: 403 },
      )
    if (!adding) {
      const count = await pool.query<{ count: string }>(
        `SELECT count(*) FROM group_memberships gm JOIN principals p ON p.id=gm.principal_id WHERE gm.group_id=$1 AND p.disabled_at IS NULL`,
        [String(body.groupId)],
      )
      assertAdministratorChange(Number(count.rows[0]?.count ?? 0), true)
    }
  }
  if (adding)
    await pool.query(
      'INSERT INTO group_memberships(group_id,principal_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [String(body.groupId), String(body.principalId)],
    )
  else
    await pool.query(
      'DELETE FROM group_memberships WHERE group_id=$1 AND principal_id=$2',
      [String(body.groupId), String(body.principalId)],
    )
  return Response.json({ ok: true })
}

async function setCapabilities(
  request: Request,
  body: Record<string, unknown>,
) {
  const actor = await requireCapability(request, 'manage_principals_groups')
  if (!actor.authorization.administrator)
    throw new Response('Only Administrators may assign Capabilities', {
      status: 403,
    })
  const pool = databasePool()
  const groupId = String(body.groupId)
  const protectedGroup = await pool.query<{ is_administrators: boolean }>(
    'SELECT is_administrators FROM groups WHERE id=$1',
    [groupId],
  )
  if (protectedGroup.rows[0]?.is_administrators)
    throw new Error('Administrator Capabilities are fixed')
  await pool.query('DELETE FROM group_capabilities WHERE group_id=$1', [
    groupId,
  ])
  for (const capability of stringArray(body.capabilities))
    if ((capabilities as ReadonlyArray<string>).includes(capability))
      await pool.query(
        'INSERT INTO group_capabilities(group_id,capability_name) VALUES($1,$2)',
        [groupId, capability],
      )
  return Response.json({ ok: true })
}

async function setDisabled(request: Request, body: Record<string, unknown>) {
  const pool = databasePool()
  const id = String(body.id)
  if (body.disabled) {
    const admin = await pool.query<{ is_admin: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM group_memberships gm JOIN groups g ON g.id=gm.group_id WHERE gm.principal_id=$1 AND g.is_administrators) is_admin`,
      [id],
    )
    if (admin.rows[0]?.is_admin) {
      const actor = await requireCapability(request, 'manage_principals_groups')
      if (!actor.authorization.administrator)
        throw new Response('Only Administrators may suspend an Administrator', {
          status: 403,
        })
      const count = await pool.query<{ count: string }>(
        `SELECT count(DISTINCT p.id) FROM principals p JOIN group_memberships gm ON gm.principal_id=p.id JOIN groups g ON g.id=gm.group_id WHERE g.is_administrators AND p.disabled_at IS NULL`,
      )
      assertAdministratorChange(Number(count.rows[0]?.count ?? 0), true)
    }
  }
  await pool.query(
    'UPDATE principals SET disabled_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE id=$1',
    [id, Boolean(body.disabled)],
  )
  if (body.disabled)
    await pool.query('DELETE FROM session WHERE "userId"=$1', [id])
  return Response.json({ ok: true })
}

async function createServiceAccount(body: Record<string, unknown>) {
  const name = String(body.name ?? '').trim()
  if (!name) throw new Error('Service Account name is required')
  const id = crypto.randomUUID()
  const clientId = `costack_${crypto.randomUUID().replaceAll('-', '')}`
  const secret = randomBytes(32).toString('base64url')
  const storedSecret = createHash('sha256').update(secret).digest('base64url')
  const pool = databasePool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      "INSERT INTO principals(id,organization_id,kind,display_name) VALUES($1,$2,'service_account',$3)",
      [id, await organizationId(), name],
    )
    await client.query(
      'INSERT INTO service_accounts(principal_id,oauth_client_id) VALUES($1,$2)',
      [id, clientId],
    )
    await client.query(
      `INSERT INTO "oauthClient"(id,"clientId","clientSecret",disabled,"clientCredentialsScopes","redirectUris","grantTypes","createdAt","updatedAt",name,"referenceId") VALUES($1,$2,$3,false,$4,$5,$6,now(),now(),$7,$8)`,
      [
        crypto.randomUUID(),
        clientId,
        storedSecret,
        JSON.stringify(['mcp:use']),
        JSON.stringify([]),
        JSON.stringify(['client_credentials']),
        name,
        id,
      ],
    )
    for (const groupId of stringArray(body.groupIds))
      await client.query(
        'INSERT INTO group_memberships(group_id,principal_id) VALUES($1,$2)',
        [groupId, id],
      )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  return Response.json({
    ok: true,
    credential: { clientId, clientSecret: secret },
  })
}

async function saveSso(request: Request, body: Record<string, unknown>) {
  await requireCapability(request, 'manage_sso')
  const providerId = String(body.providerId ?? '').trim()
  const domain = String(body.domain ?? '').trim()
  const issuer = String(body.issuer ?? '').trim()
  if (!providerId || !domain || !issuer)
    throw new Error('Provider ID, domain, and issuer are required')
  const pool = databasePool()
  const existing = await pool.query<{ providerId: string }>(
    'SELECT "providerId" FROM "ssoProvider" LIMIT 1',
  )
  const path = existing.rows[0]
    ? '/api/auth/sso/update-provider'
    : '/api/auth/sso/register'
  const payload = existing.rows[0]
    ? {
        providerId: existing.rows[0].providerId,
        issuer,
        domain,
        oidcConfig: {
          clientId: String(body.clientId),
          clientSecret: String(body.clientSecret),
          issuer,
        },
      }
    : {
        providerId,
        issuer,
        domain,
        oidcConfig: {
          clientId: String(body.clientId),
          clientSecret: String(body.clientSecret),
          issuer,
        },
      }
  const upstream = new Request(new URL(path, request.url), {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(payload),
  })
  return auth.handler(upstream)
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String) : []
}
