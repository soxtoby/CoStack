import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { Pool } from 'pg'
import { migrate } from '../database/migrate'
import { deleteServiceAccount } from './service-accounts'

const database = await PGlite.create()
const socket = new PGLiteSocketServer({
  db: database,
  host: '127.0.0.1',
  port: 0,
})
await socket.start()
const [, port] = socket.getServerConn().split(':')
if (!port) throw new Error('PGlite did not bind TCP')
const pool = new Pool({
  host: '127.0.0.1',
  port: Number(port),
  database: 'postgres',
  user: 'postgres',
  max: 1,
})

beforeAll(async () => {
  await migrate(pool)
  await pool.query(
    "INSERT INTO organizations(id,display_name) VALUES('org','Test')",
  )
  await pool.query(
    "INSERT INTO groups(id,organization_id,display_name) VALUES('group','org','Group')",
  )
})
afterAll(async () => {
  await pool.end()
  await Bun.sleep(10)
  await socket.stop()
  await database.close()
})

describe('deleteServiceAccount', () => {
  test('a suspended Service Account is removed with its OAuth client and tokens', async () => {
    await createServiceAccount('suspended', { suspended: true })
    await pool.query(
      "INSERT INTO audit_records(id,organization_id,principal_id,principal_display_name,outcome) VALUES('audit','org','suspended','suspended automation','success')",
    )

    await deleteServiceAccount(pool, 'suspended')

    const remaining = await pool.query(
      `SELECT
        (SELECT count(*)::int FROM principals WHERE id='suspended') principals,
        (SELECT count(*)::int FROM group_memberships WHERE principal_id='suspended') memberships,
        (SELECT count(*)::int FROM "oauthClient" WHERE "clientId"='suspended-client') clients,
        (SELECT count(*)::int FROM "oauthAccessToken" WHERE "clientId"='suspended-client') tokens`,
    )
    expect(remaining.rows).toEqual([
      { principals: 0, memberships: 0, clients: 0, tokens: 0 },
    ])
    const audit = await pool.query(
      "SELECT principal_id, principal_display_name FROM audit_records WHERE id='audit'",
    )
    expect(audit.rows).toEqual([
      { principal_id: null, principal_display_name: 'suspended automation' },
    ])
  })

  test('an active Service Account is kept and the deletion is refused', async () => {
    await createServiceAccount('active', { suspended: false })

    const result = deleteServiceAccount(pool, 'active')

    await expect(result).rejects.toThrow(
      'Suspend the Service Account before deleting it',
    )
    const remaining = await pool.query(
      `SELECT count(*)::int count FROM "oauthClient" c
       JOIN service_accounts s ON s.oauth_client_id=c."clientId"
       WHERE s.principal_id='active'`,
    )
    expect(remaining.rows).toEqual([{ count: 1 }])
  })
})

async function createServiceAccount(
  principalId: string,
  options: { suspended: boolean },
) {
  const clientId = `${principalId}-client`
  await pool.query(
    "INSERT INTO principals(id,organization_id,kind,display_name,disabled_at) VALUES($1,'org','service_account',$2,$3)",
    [
      principalId,
      `${principalId} automation`,
      options.suspended ? new Date() : null,
    ],
  )
  await pool.query(
    `INSERT INTO "oauthClient"(id,"clientId","clientSecret",disabled,"clientCredentialsScopes","redirectUris","grantTypes","createdAt","updatedAt",name,"referenceId")
     VALUES($1,$1,'hash',false,'["mcp:use"]','[]','["client_credentials"]',now(),now(),$2,$2)`,
    [clientId, principalId],
  )
  await pool.query(
    'INSERT INTO service_accounts(principal_id,oauth_client_id) VALUES($1,$2)',
    [principalId, clientId],
  )
  await pool.query(
    "INSERT INTO group_memberships(group_id,principal_id) VALUES('group',$1)",
    [principalId],
  )
  await pool.query(
    `INSERT INTO "oauthAccessToken"(id,token,"clientId","expiresAt","createdAt",scopes)
     VALUES($1,$1,$2,now() + interval '1 hour',now(),'["mcp:use"]')`,
    [`${principalId}-token`, clientId],
  )
}
