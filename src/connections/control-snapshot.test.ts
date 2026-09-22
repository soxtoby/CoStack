import { afterAll, beforeAll, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { Pool } from 'pg'
import { migrate } from '../database/migrate'
import { connectionSnapshot } from './control-snapshot'
import type { Capability } from '../auth/authorization'

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

beforeAll(async () => migrate(pool))
afterAll(async () => {
  await pool.end()
  await Bun.sleep(10)
  await socket.stop()
  await database.close()
})

beforeAll(async () => {
  await pool.query(
    "INSERT INTO organizations (id, display_name) VALUES ('org', 'Test')",
  )
  await pool.query(
    "INSERT INTO groups (id, organization_id, display_name) VALUES ('readers', 'org', 'Readers')",
  )
  await pool.query(`INSERT INTO mcp_connections
    (id, organization_id, display_name, namespace, transport, transport_config, state)
    VALUES ('connection', 'org', 'GitHub', 'github', 'streamable_http', '{"kind":"streamable_http","url":"https://example.test/mcp"}', 'enabled')`)
  await pool.query(
    "INSERT INTO connection_groups (connection_id, group_id) VALUES ('connection', 'readers')",
  )
  for (const id of ['recovery-admin', 'other-user']) {
    await pool.query(
      "INSERT INTO principals (id, organization_id, kind, display_name) VALUES ($1, 'org', 'user', $1)",
      [id],
    )
    await pool.query(
      'INSERT INTO users (principal_id, email) VALUES ($1, $2)',
      [id, id + '@example.test'],
    )
    await pool.query(
      "INSERT INTO group_memberships (group_id, principal_id) VALUES ('readers', $1)",
      [id],
    )
    await pool.query(
      `INSERT INTO mcp_accounts (id, connection_id, kind, owner_user_id, display_name, namespace)
      VALUES ($1, 'connection', 'personal', $1, $1, 'github_personal')`,
      [id],
    )
  }
  await pool.query(`INSERT INTO mcp_accounts (id, connection_id, kind, display_name, namespace)
    VALUES ('shared', 'connection', 'shared', 'Shared', 'github_shared')`)
})

for (const [role, administrator, capabilities] of [
  ['member', false, []],
  ['account manager', false, ['manage_accounts']],
  ['connection manager', false, ['manage_connections']],
  ['administrator', true, []],
] as const) {
  test(
    role + ' receives OAuth metadata only with account management access',
    async () => {
      await pool.query(
        "UPDATE mcp_connections SET oauth_client_ciphertext=$1, oauth_client_nonce=$1, oauth_client_format_version=1 WHERE id='connection'",
        [new Uint8Array([1])],
      )
      let reads = 0
      try {
        const response = await connectionSnapshot(
          pool,
          {
            id: 'other-user',
            disabled: false,
            administrator,
            capabilities: new Set<Capability>(capabilities),
          },
          new URL('http://localhost/api/control?connection=connection'),
          () => Promise.resolve({ rows: [] }),
          () => {
            reads++
            return Promise.resolve({
              clientId: 'saved-client',
              scope: 'read',
              hasSecret: true,
            })
          },
        )
        const data = await response.json()
        const allowed = administrator || role === 'account manager'
        expect(reads).toBe(allowed ? 1 : 0)
        expect(data.detail.oauth_application).toEqual(
          allowed
            ? { clientId: 'saved-client', scope: 'read', hasSecret: true }
            : undefined,
        )
        expect(JSON.stringify(data)).not.toContain('oauth_client_ciphertext')
      } finally {
        await pool.query(
          "UPDATE mcp_connections SET oauth_client_ciphertext=null, oauth_client_nonce=null, oauth_client_format_version=null WHERE id='connection'",
        )
      }
    },
  )
  test(
    role +
      ' receives credential names and plain variables only for reconfigurable accounts',
    async () => {
      await pool.query(
        "UPDATE mcp_accounts SET secret_ciphertext=$1, secret_nonce=$1, secret_format_version=1, variables=jsonb_build_object('BASE_URL', id) WHERE id IN ('shared', 'other-user', 'recovery-admin')",
        [new Uint8Array([1])],
      )
      try {
        const response = await connectionSnapshot(
          pool,
          {
            id: 'other-user',
            disabled: false,
            administrator,
            capabilities: new Set<Capability>(capabilities),
          },
          new URL('http://localhost/api/control?connection=connection'),
          () => Promise.resolve({ rows: [] }),
          undefined,
          (id) => Promise.resolve([`${id}_KEY`]),
        )
        const data = await response.json()
        const accounts = Object.fromEntries(
          data.detail.accounts.map(
            (account: {
              id: string
              secret_names?: Array<string>
              variables?: Record<string, string>
            }) => [
              account.id,
              { names: account.secret_names, variables: account.variables },
            ],
          ),
        )
        expect(accounts['other-user']).toEqual({
          names: ['other-user_KEY'],
          variables: { BASE_URL: 'other-user' },
        })
        expect(accounts.shared).toEqual(
          administrator || role === 'account manager'
            ? { names: ['shared_KEY'], variables: { BASE_URL: 'shared' } }
            : { names: undefined, variables: undefined },
        )
        expect(JSON.stringify(data)).not.toContain('secret_ciphertext')
      } finally {
        await pool.query(
          "UPDATE mcp_accounts SET secret_ciphertext=null, secret_nonce=null, secret_format_version=null, variables='{}'",
        )
      }
    },
  )
  test(role + ' sees only shared and their own personal accounts', async () => {
    for (const id of ['other-user', 'recovery-admin']) {
      const response = await connectionSnapshot(
        pool,
        {
          id,
          disabled: false,
          administrator,
          capabilities: new Set<Capability>(capabilities),
        },
        new URL('http://localhost/api/control?connection=connection'),
        () => Promise.resolve({ rows: [] }),
      )
      const data = await response.json()
      expect(
        data.connections.map((connection: { id: string }) => connection.id),
      ).toEqual(['connection'])
      expect(
        data.detail.accounts
          .map((account: { id: string }) => account.id)
          .sort(),
      ).toEqual([id, 'shared'].sort())
      expect(
        data.connections.find(
          (connection: { id: string }) => connection.id === 'connection',
        ).account_count,
      ).toBe(2)
    }
  })
}
