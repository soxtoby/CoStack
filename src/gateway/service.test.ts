import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { Pool } from 'pg'
import { migrate } from '../database/migrate'
import { GatewayError, GatewayService } from './service'
import { builtinConnection, setBuiltinToolPolicies } from './builtin-tools'
import type { GatewayPrincipal } from './types'

const database = await PGlite.create()
const socket = new PGLiteSocketServer({
  db: database,
  host: '127.0.0.1',
  port: 0,
})
await socket.start()
const [, port] = socket.getServerConn().split(':')
const pool = new Pool({
  host: '127.0.0.1',
  port: Number(port),
  database: 'postgres',
  user: 'postgres',
  max: 1,
})
const calls: Array<unknown> = []
const connections = {
  callAccountTool: (...args: Array<unknown>) => {
    calls.push(args)
    return Promise.resolve({ content: [{ type: 'text', text: 'done' }] })
  },
}
const service = new GatewayService(pool, connections as never)
const user: GatewayPrincipal = {
  id: 'user',
  organizationId: 'org',
  kind: 'user',
  displayName: 'User',
  approvalMethod: 'client_managed',
}

beforeAll(async () => {
  await migrate(pool)
  await pool.query(
    "INSERT INTO organizations(id,display_name) VALUES ('org','Org')",
  )
  await pool.query(
    "INSERT INTO principals(id,organization_id,kind,display_name) VALUES ('user','org','user','User'),('other','org','user','Other'),('service','org','service_account','Service')",
  )
  await pool.query(
    "INSERT INTO users(principal_id,email,approval_method) VALUES ('user','u@test','client_managed'),('other','o@test','gateway_enforced')",
  )
  await pool.query(
    "INSERT INTO service_accounts(principal_id) VALUES ('service')",
  )
  await pool.query(
    "INSERT INTO groups(id,organization_id,display_name) VALUES ('readers','org','Readers')",
  )
  await pool.query(
    "INSERT INTO group_memberships(group_id,principal_id) VALUES ('readers','user'),('readers','service')",
  )
  await pool.query(`INSERT INTO mcp_connections(id,organization_id,display_name,namespace,transport,transport_config,state)
    VALUES ('c','org','GitHub','github','streamable_http','{}','enabled')`)
  await pool.query(
    "INSERT INTO connection_groups(connection_id,group_id) VALUES ('c','readers')",
  )
  await pool.query(
    "INSERT INTO connection_tools(connection_id,name,input_schema) VALUES ('c','read_issue','{}'),('c','write_issue','{}'),('c','secret_tool','{}')",
  )
  await pool.query(
    "INSERT INTO tool_policies(id,connection_id,pattern,effect) VALUES ('p1','c','read_*','allow'),('p2','c','write_*','require_approval'),('p3','c','*','block')",
  )
  await pool.query(
    "INSERT INTO connection_health(connection_id,healthy) VALUES ('c',true)",
  )
})

test('built-in tool policies persist and reject stale or invalid edits', async () => {
  const initial = await builtinConnection(pool)
  expect(initial.tools.map((tool) => tool.name)).toEqual([
    'search_tools',
    'call_tool',
    'call_tool_with_approval',
  ])
  expect(initial.tools.every((tool) => tool.policy === 'allow')).toBe(true)
  const policies = [
    { pattern: '*', effect: 'allow' },
    { pattern: 'call_*', effect: 'block' },
  ] as const
  await setBuiltinToolPolicies(pool, initial.revision, [...policies])
  expect(
    (await builtinConnection(pool)).tools.map((tool) => tool.policy),
  ).toEqual(['allow', 'block', 'block'])
  await expect(
    setBuiltinToolPolicies(pool, initial.revision, []),
  ).rejects.toThrow('reload and retry')
  await expect(
    setBuiltinToolPolicies(pool, initial.revision + 1, [
      { pattern: '[bad]', effect: 'allow' },
    ]),
  ).rejects.toThrow('Unsupported')
  await setBuiltinToolPolicies(pool, initial.revision + 1, initial.policies)
})

afterAll(async () => {
  await pool.end()
  await Bun.sleep(10)
  await socket.stop()
  await database.close()
})

describe('GatewayService', () => {
  test('search returns authorized non-blocked tools only', async () => {
    expect(
      (await service.search(user)).map((tool) => [
        tool.qualifiedName,
        tool.policy,
      ]),
    ).toEqual([
      ['github__read_issue', 'allow'],
      ['github__write_issue', 'require_approval'],
    ])
    expect(await service.search({ ...user, id: 'other' })).toEqual([])
  })

  test('routes allow and approval paths without weakening policy', async () => {
    await service.call(
      user,
      'github__read_issue',
      { value: 'secret payload' },
      'ordinary',
    )
    await expect(
      service.call(user, 'github__write_issue', {}, 'ordinary'),
    ).rejects.toMatchObject({ code: 'client_approval_required' })
    await service.call(user, 'github__write_issue', {}, 'approved')
    await expect(
      service.call(
        { ...user, id: 'service', kind: 'service_account' },
        'github__write_issue',
        {},
        'approved',
      ),
    ).rejects.toBeInstanceOf(GatewayError)
    expect(calls).toHaveLength(2)
  })

  test('disabled principals fail lookup and audit stores no payload', async () => {
    await pool.query("UPDATE principals SET disabled_at=now() WHERE id='other'")
    expect(await service.loadPrincipal('other')).toBeUndefined()
    const columns = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name='audit_records'",
    )
    expect(columns.rows.map((row) => row.column_name)).not.toContain(
      'arguments',
    )
    expect(
      JSON.stringify((await pool.query('SELECT * FROM audit_records')).rows),
    ).not.toContain('secret payload')
  })
})
