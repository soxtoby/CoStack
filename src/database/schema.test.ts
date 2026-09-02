import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { Pool } from 'pg'
import { migrate } from './migrate'

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

describe('database schema', () => {
  test('migrations are repeatable', async () => {
    await migrate(pool)
    const result = await pool.query('SELECT name FROM schema_migrations')
    expect(result.rows).toEqual([
      { name: '0001_initial.sql' },
      { name: '0002_better_auth.sql' },
      { name: '0003_auth_foundation.sql' },
      { name: '0004_connection_runtime.sql' },
      { name: '0005_upstream_oauth.sql' },
      { name: '0006_gateway.sql' },
    ])
  })

  test('personal namespaces are scoped to their owner', async () => {
    await seedUsers()
    await pool.query(`
      INSERT INTO mcp_connections
        (id, organization_id, display_name, namespace, transport, transport_config, state)
      VALUES ('connection', 'org', 'GitHub', 'github', 'streamable_http', '{}', 'enabled')
    `)
    for (const owner of ['user-1', 'user-2']) {
      await pool.query(
        `INSERT INTO mcp_accounts
          (id, connection_id, kind, owner_user_id, display_name, namespace)
         VALUES ($1, 'connection', 'personal', $2, 'Work', 'github_work')`,
        [`account-${owner}`, owner],
      )
    }
    expect((await pool.query('SELECT id FROM mcp_accounts')).rowCount).toBe(2)
  })

  test('an account secret envelope is stored atomically', async () => {
    await expect(
      pool.query(`
        INSERT INTO mcp_accounts
          (id, connection_id, kind, display_name, namespace, secret_ciphertext)
        VALUES ('bad-secret', 'connection', 'shared', 'Broken', 'broken', '\\x01')
      `),
    ).rejects.toThrow()
  })
})

async function seedUsers() {
  await pool.query(
    "INSERT INTO organizations (id, display_name) VALUES ('org', 'Test')",
  )
  for (const id of ['user-1', 'user-2']) {
    await pool.query(
      `INSERT INTO principals (id, organization_id, kind, display_name)
       VALUES ($1, 'org', 'user', $1)`,
      [id],
    )
    await pool.query(
      `INSERT INTO users (principal_id, email) VALUES ($1, $2)`,
      [id, `${id}@example.test`],
    )
  }
}
