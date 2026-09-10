import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { Pool } from 'pg'
import { migrate } from '../database/migrate'
import { grantAccess } from './access'

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
    "INSERT INTO groups(id,organization_id,display_name) VALUES('old','org','Old'),('new','org','New')",
  )
})
afterAll(async () => {
  await pool.end()
  await Bun.sleep(10)
  await socket.stop()
  await database.close()
})

describe('pre-provisioned access', () => {
  test('a revoked email can be granted access again with new Groups', async () => {
    await grantAccess(pool, 'org', 'user@example.test', ['old'])
    await pool.query(
      "UPDATE pre_provisioned_access SET revoked_at=now() WHERE normalized_email='user@example.test'",
    )

    await grantAccess(pool, 'org', 'user@example.test', ['new'])

    const access = await pool.query(
      `SELECT p.revoked_at, array_agg(pg.group_id ORDER BY pg.group_id) AS group_ids
       FROM pre_provisioned_access p
       JOIN pre_provisioned_access_groups pg ON pg.access_id=p.id
       WHERE p.normalized_email='user@example.test'
       GROUP BY p.id`,
    )
    expect(access.rows).toEqual([{ revoked_at: null, group_ids: ['new'] }])
  })
})
