import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { Pool } from 'pg'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { migrate } from '../database/migrate'
import { GatewayError, GatewayService } from './service'
import { builtinConnection, setBuiltinToolPolicies } from './builtin-tools'
import { createGatewayServer } from './server'
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

test('built-in annotation policies persist and use the built-in tool annotations', async () => {
  const initial = await builtinConnection(pool)
  try {
    await setBuiltinToolPolicies(pool, initial.revision, [
      { pattern: '*', effect: 'block' },
      { annotation: 'read_only', effect: 'allow' },
      { annotation: 'destructive', effect: 'require_approval' },
    ])
    expect(
      (await builtinConnection(pool)).tools.map((tool) => tool.policy),
    ).toEqual(['allow', 'require_approval', 'require_approval'])
  } finally {
    const current = await builtinConnection(pool)
    await setBuiltinToolPolicies(pool, current.revision, initial.policies)
  }
})

afterAll(async () => {
  await pool.end()
  await Bun.sleep(10)
  await socket.stop()
  await database.close()
})

describe('GatewayService', () => {
  test('MCP discovery advertises only the principal accessible services and explains execution', async () => {
    for (const principal of [user, { ...user, id: 'other' }]) {
      const server = await createGatewayServer(service, principal)
      const client = new Client({ name: 'discovery-test', version: '1' })
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      try {
        expect(client.getInstructions()).toContain('use search_tools')
        expect(client.getInstructions()).toContain('obtain user approval')
        const tools = (await client.listTools()).tools
        const search = tools.find((tool) => tool.name === 'search_tools')!
        expect(search.description).toContain('Prefer directly exposed')
        expect(tools.some((tool) => tool.name === 'github.read_issue')).toBe(
          principal.id === user.id,
        )
        expect(
          search.description!.includes(
            'Connected services (display names): ["GitHub"]',
          ),
        ).toBe(principal.id === user.id)
        expect(
          tools.find((tool) => tool.name === 'call_tool')!.description,
        ).toContain('qualifiedName')
      } finally {
        await client.close()
        await server.close()
      }
    }
  })

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

  test('search matches all query words across fields regardless of order or whitespace', async () => {
    for (const query of [
      'GitHub read issue',
      ' ISSUE\tgithub\nREAD ',
      'github__read_issue',
    ]) {
      expect(
        (await service.search(user, query)).map((tool) => tool.qualifiedName),
      ).toEqual(['github__read_issue'])
    }
    expect(await service.search(user, 'github read missing')).toEqual([])
    expect(
      (
        await service.search(
          user,
          'github read issue assigned me recently updated',
        )
      ).map((tool) => tool.qualifiedName),
    ).toEqual(['github__read_issue'])
    expect(await service.search(user, 'github secret')).toEqual([])
    expect(
      await service.search({ ...user, id: 'other' }, 'github read'),
    ).toEqual([])
    expect(await service.search(user, ' \t\n')).toEqual(
      await service.search(user),
    )
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

  test('direct tools share schemas, route accounts, validate arguments and recheck access', async () => {
    const schema = {
      type: 'object',
      $defs: { identifier: { type: 'string', pattern: '^SOX-[0-9]+$' } },
      properties: {
        id: { $ref: '#/$defs/identifier' },
        account: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    }
    await pool.query(
      "UPDATE connection_tools SET input_schema=$1 WHERE connection_id='c' AND name='read_issue'",
      [schema],
    )
    await pool.query(`INSERT INTO mcp_accounts(id,connection_id,kind,owner_user_id,display_name,namespace) VALUES
      ('personal','c','personal','user','Personal','github_personal'),
      ('shared','c','shared',NULL,'Personal','github_shared'),
      ('hidden','c','personal','other','Private','github_hidden')`)
    const server = await createGatewayServer(service, user)
    const client = new Client({ name: 'direct-test', version: '1' })
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const before = calls.length
    try {
      const tools = (await client.listTools()).tools
      expect(
        tools.filter((tool) => tool.name === 'github.read_issue'),
      ).toHaveLength(1)
      expect(
        tools.filter((tool) => tool.name.startsWith('github')),
      ).toHaveLength(2)
      const read = tools.find((tool) => tool.name === 'github.read_issue')!
      expect(read.inputSchema.required).toEqual(['account', 'arguments'])
      expect(read.inputSchema.properties!.account).toMatchObject({
        enum: ['github_personal', 'github_shared'],
      })
      expect(JSON.stringify(tools)).not.toContain('github_hidden')
      const validate = new AjvJsonSchemaValidator().getValidator(
        read.inputSchema as Record<string, unknown>,
      )
      expect(
        validate({ account: 'github_personal', arguments: { id: 'SOX-135' } })
          .valid,
      ).toBe(true)
      expect(
        validate({ account: 'github_personal', arguments: { id: 'wrong' } })
          .valid,
      ).toBe(false)
      for (const args of [
        { arguments: { id: 'SOX-135' } },
        { account: 'github_hidden', arguments: { id: 'SOX-135' } },
        { account: 'Personal', arguments: { id: 'SOX-135' } },
        { account: 'github_personal', arguments: { id: 135 } },
        {
          account: 'github_personal',
          arguments: { id: 'SOX-135', extra: true },
        },
      ])
        expect(
          (await client.callTool({ name: read.name, arguments: args })).isError,
        ).toBe(true)
      expect(calls.length).toBe(before)
      for (const account of ['github_personal', 'github_shared']) {
        expect(
          (
            await client.callTool({
              name: read.name,
              arguments: {
                account,
                arguments: { id: 'SOX-135', account: 'upstream-value' },
              },
            })
          ).isError,
        ).not.toBe(true)
      }
      expect(
        calls.slice(before).map((call) => (call as Array<unknown>).slice(0, 4)),
      ).toEqual([
        [
          'c',
          'personal',
          'read_issue',
          { id: 'SOX-135', account: 'upstream-value' },
        ],
        [
          'c',
          'shared',
          'read_issue',
          { id: 'SOX-135', account: 'upstream-value' },
        ],
      ])
      await pool.query("DELETE FROM mcp_accounts WHERE id='personal'")
      expect(
        (
          await client.callTool({
            name: read.name,
            arguments: {
              account: 'github_personal',
              arguments: { id: 'SOX-135' },
            },
          })
        ).isError,
      ).toBe(true)
      await pool.query(
        "DELETE FROM group_memberships WHERE group_id='readers' AND principal_id='user'",
      )
      expect(
        (
          await client.callTool({
            name: read.name,
            arguments: {
              account: 'github_shared',
              arguments: { id: 'SOX-135' },
            },
          })
        ).isError,
      ).toBe(true)
      expect(calls.length).toBe(before + 2)
    } finally {
      await client.close()
      await server.close()
      await pool.query(
        "INSERT INTO group_memberships(group_id,principal_id) VALUES ('readers','user') ON CONFLICT DO NOTHING",
      )
      await pool.query("DELETE FROM mcp_accounts WHERE connection_id='c'")
      await pool.query(
        "UPDATE connection_tools SET input_schema='{}' WHERE connection_id='c'",
      )
    }
  })

  test('direct calls preserve both approval methods and service account restrictions', async () => {
    for (const principal of [
      user,
      { ...user, approvalMethod: 'gateway_enforced' as const },
      { ...user, id: 'service', kind: 'service_account' as const },
    ]) {
      let approve = false
      let prompts = 0
      const server = await createGatewayServer(service, principal)
      const client = new Client(
        { name: 'approval-test', version: '1' },
        { capabilities: { elicitation: { form: {} } } },
      )
      client.setRequestHandler(ElicitRequestSchema, () => {
        prompts++
        return Promise.resolve({
          action: approve ? 'accept' : 'decline',
          content: { approve },
        })
      })
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      try {
        const before = calls.length
        const invoke = () =>
          client.callTool({
            name: 'github.write_issue',
            arguments: { arguments: { value: 'change' } },
          })
        if (principal.approvalMethod === 'gateway_enforced') {
          expect((await invoke()).isError).toBe(true)
          expect(calls.length).toBe(before)
          approve = true
        }
        expect((await invoke()).isError === true).toBe(
          principal.kind === 'service_account',
        )
        expect(calls.length).toBe(
          before + (principal.kind === 'service_account' ? 0 : 1),
        )
        expect(prompts).toBe(
          principal.approvalMethod === 'gateway_enforced' ? 2 : 0,
        )
      } finally {
        await client.close()
        await server.close()
      }
    }
  })

  test('single-account direct calls omit selectors and honor changed built-in policies', async () => {
    await pool.query(
      "INSERT INTO mcp_accounts(id,connection_id,kind,display_name,namespace) VALUES ('only','c','shared','Only','github_only')",
    )
    const initial = await builtinConnection(pool)
    const server = await createGatewayServer(service, user)
    const client = new Client({ name: 'single-account-test', version: '1' })
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const read = (await client.listTools()).tools.find(
        (tool) => tool.name === 'github.read_issue',
      )!
      expect(read.inputSchema.required).toEqual(['arguments'])
      expect(
        (
          await client.callTool({
            name: read.name,
            arguments: { arguments: {} },
          })
        ).isError,
      ).not.toBe(true)
      expect((calls.at(-1) as Array<unknown>).slice(0, 3)).toEqual([
        'c',
        'only',
        'read_issue',
      ])
      const before = calls.length
      await setBuiltinToolPolicies(pool, initial.revision, [
        { pattern: '*', effect: 'allow' },
        { pattern: 'call_tool', effect: 'block' },
      ])
      expect(
        (
          await client.callTool({
            name: read.name,
            arguments: { arguments: {} },
          })
        ).isError,
      ).toBe(true)
      expect(calls.length).toBe(before)
    } finally {
      await client.close()
      await server.close()
      const current = await builtinConnection(pool)
      await setBuiltinToolPolicies(pool, current.revision, initial.policies)
      await pool.query("DELETE FROM mcp_accounts WHERE id='only'")
    }
  })
})
