import { afterAll, beforeAll, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { Pool } from 'pg'
import { migrate } from '../database/migrate'
import { visibleGroups } from './visible-groups'
import type { Capability } from './authorization'

const database = await PGlite.create()
const socket = new PGLiteSocketServer({
  db: database,
  host: '127.0.0.1',
  port: 0,
})
await socket.start()
const pool = new Pool({
  host: '127.0.0.1',
  port: Number(socket.getServerConn().split(':')[1]),
  database: 'postgres',
  user: 'postgres',
  max: 1,
})

beforeAll(async () => {
  await migrate(pool)
  await pool.query(
    "INSERT INTO organizations (id, display_name) VALUES ('org', 'Test')",
  )
  await pool.query(
    "INSERT INTO groups (id, organization_id, display_name) VALUES ('ops', 'org', 'Ops')",
  )
  await pool.query(
    "INSERT INTO group_capabilities (group_id, capability_name) VALUES ('ops', 'manage_accounts')",
  )
})
afterAll(async () => {
  await pool.end()
  await Bun.sleep(10)
  await socket.stop()
  await database.close()
})

test('visibleGroups for a Group manager includes Group Capabilities', async () => {
  const result = await visibleGroups(
    pool,
    principal(['manage_principals_groups']),
  )

  expect(result).toEqual([
    {
      id: 'ops',
      display_name: 'Ops',
      is_administrators: false,
      capabilities: ['manage_accounts'],
    },
  ])
})

test('visibleGroups for a connection manager lists Groups without Capabilities', async () => {
  const result = await visibleGroups(pool, principal(['manage_connections']))

  expect(result).toEqual([
    {
      id: 'ops',
      display_name: 'Ops',
      is_administrators: false,
      capabilities: [],
    },
  ])
})

test('visibleGroups for a member lists no Groups', async () => {
  expect(await visibleGroups(pool, principal([]))).toEqual([])
})

function principal(capabilities: Array<Capability>) {
  return {
    id: 'person',
    disabled: false,
    administrator: false,
    capabilities: new Set(capabilities),
  }
}
