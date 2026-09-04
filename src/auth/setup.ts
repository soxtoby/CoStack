import { hashPassword } from 'better-auth/crypto'
import { databasePool } from '../database/pool'
import { OFFICIAL_REGISTRY } from '../connections/registry'
import type { Pool } from 'pg'

interface BootstrapInput {
  token: string
  organizationName: string
  administratorName: string
  administratorEmail: string
  administratorPassword: string
}

interface BootstrapDependencies {
  pool: Pool
  signUp: (input: {
    name: string
    email: string
    password: string
  }) => Promise<{
    user: { id: string; name: string; email: string }
  }>
}

export async function bootstrap(
  input: BootstrapInput,
  dependencies?: BootstrapDependencies,
) {
  const expected = process.env.BOOTSTRAP_TOKEN
  if (!expected || input.token !== expected)
    throw new Error('Invalid bootstrap token')

  const pool = dependencies?.pool ?? databasePool()
  const initial = await pool.query<{ bootstrap_completed_at: Date | null }>(
    'SELECT bootstrap_completed_at FROM gateway_settings WHERE singleton',
  )
  if (initial.rows[0]?.bootstrap_completed_at)
    throw new Error('Bootstrap has already completed')

  const credentials = {
    name: input.administratorName,
    email: input.administratorEmail,
    password: input.administratorPassword,
  }
  const created = dependencies
    ? await dependencies.signUp(credentials)
    : await (await import('./auth')).auth.api.signUpEmail({ body: credentials })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const settings = await client.query<{
      bootstrap_completed_at: Date | null
    }>(
      'SELECT bootstrap_completed_at FROM gateway_settings WHERE singleton FOR UPDATE',
    )
    if (settings.rows[0]?.bootstrap_completed_at) {
      throw new Error('Bootstrap has already completed')
    }

    const organizationId = crypto.randomUUID()
    const groupId = crypto.randomUUID()
    await client.query(
      'INSERT INTO organizations (id, display_name) VALUES ($1, $2)',
      [organizationId, input.organizationName],
    )
    await client.query(
      `INSERT INTO principals (id, organization_id, kind, display_name)
       VALUES ($1, $2, 'user', $3)`,
      [created.user.id, organizationId, created.user.name],
    )
    await client.query(
      'INSERT INTO users (principal_id, email) VALUES ($1, $2)',
      [created.user.id, created.user.email],
    )
    await client.query(
      `INSERT INTO groups (id, organization_id, display_name, is_administrators)
       VALUES ($1, $2, 'Administrators', true)`,
      [groupId, organizationId],
    )
    await client.query(
      'INSERT INTO group_memberships (group_id, principal_id) VALUES ($1, $2)',
      [groupId, created.user.id],
    )
    await client.query(
      `UPDATE gateway_settings SET bootstrap_completed_at = now(), recovery_user_id = $1
       WHERE singleton`,
      [created.user.id],
    )
    await client.query(
      `INSERT INTO registry_sources(id,organization_id,display_name,base_url,is_official)
       VALUES($1,$2,'Official MCP Registry',$3,true)
       ON CONFLICT (organization_id,base_url) DO NOTHING`,
      [crypto.randomUUID(), organizationId, OFFICIAL_REGISTRY],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function resetRecoveryPassword(token: string, password: string) {
  const expected = process.env.RECOVERY_TOKEN
  if (!expected || token !== expected) throw new Error('Invalid recovery token')
  const pool = databasePool()
  const settings = await pool.query<{ recovery_user_id: string | null }>(
    'SELECT recovery_user_id FROM gateway_settings WHERE singleton',
  )
  const userId = settings.rows[0]?.recovery_user_id
  if (!userId) throw new Error('Recovery Administrator is not configured')
  const hashed = await hashPassword(password)
  await pool.query(
    `UPDATE account SET password = $1, "updatedAt" = now()
     WHERE "userId" = $2 AND "providerId" = 'credential'`,
    [hashed, userId],
  )
}

export async function setupHandler(request: Request) {
  if (request.method !== 'POST') return new Response(null, { status: 405 })
  try {
    const body = (await request.json()) as Record<string, unknown>
    if (new URL(request.url).pathname.endsWith('/bootstrap')) {
      await bootstrap(body as unknown as BootstrapInput)
    } else {
      await resetRecoveryPassword(
        String(body.token ?? ''),
        String(body.password ?? ''),
      )
    }
    return Response.json({ ok: true })
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Request failed' },
      { status: 400 },
    )
  }
}
