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
