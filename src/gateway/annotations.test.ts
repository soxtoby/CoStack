import { expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { Pool } from 'pg'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ConnectionManager } from '../connections/manager'
import { SecretVault } from '../connections/secrets'
import { connectionSnapshot } from '../connections/control-snapshot'
import { policyFromRow } from '../connections/policy'
import { migrate } from '../database/migrate'
import { GatewayService } from './service'
import { createGatewayServer } from './server'
import type { ToolPolicy } from '../connections/types'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

test('upstream annotations survive HTTP discovery, persistence, gateway listing and refresh', async () => {
  let upstreamTools: Array<Tool> = [
    {
      name: 'read',
      inputSchema: { type: 'object' },
      annotations: {
        title: 'Read records',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: 'delete',
      inputSchema: { type: 'object' },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    {
      name: 'append',
      inputSchema: { type: 'object' },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    { name: 'unknown', inputSchema: { type: 'object' } },
  ]
  let forwarded = 0
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method !== 'POST') return new Response(null, { status: 405 })
      const body = (await request.json()) as { id?: number; method: string }
      if (body.id === undefined) return new Response(null, { status: 202 })
      if (body.method === 'tools/call') {
        forwarded++
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: { content: [{ type: 'text', text: 'done' }] },
        })
      }
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result:
          body.method === 'initialize'
            ? {
                protocolVersion: '2025-11-25',
                capabilities: { tools: {} },
                serverInfo: { name: 'fixture', version: '1' },
              }
            : { tools: upstreamTools },
      })
    },
  })
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
  const vault = await SecretVault.fromBase64(
    crypto.getRandomValues(new Uint8Array(32)).toBase64(),
  )
  const manager = new ConnectionManager(pool, vault)
  const service = new GatewayService(pool, manager)
  const principal = {
    id: 'user',
    organizationId: 'org',
    kind: 'user',
    displayName: 'User',
    approvalMethod: 'client_managed',
  } as const
  async function listTools() {
    const server = await createGatewayServer(service, principal)
    const client = new Client({ name: 'annotations-test', version: '1' })
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      return (await client.listTools()).tools
    } finally {
      await client.close()
      await server.close()
    }
  }
  try {
    await migrate(pool)
    await pool.query(
      "INSERT INTO organizations(id,display_name) VALUES ('org','Org')",
    )
    await pool.query(
      "INSERT INTO principals(id,organization_id,kind,display_name) VALUES ('user','org','user','User')",
    )
    await pool.query(
      "INSERT INTO groups(id,organization_id,display_name) VALUES ('group','org','Readers')",
    )
    await pool.query(
      "INSERT INTO group_memberships(group_id,principal_id) VALUES ('group','user')",
    )
    const connection = await manager.create({
      organizationId: 'org',
      displayName: 'Fixture',
      transport: {
        kind: 'streamable_http',
        url: `http://127.0.0.1:${upstream.port}/mcp`,
      },
      groupIds: ['group'],
      policies: [
        { pattern: '*', effect: 'allow' },
        { pattern: 'delete', effect: 'require_approval' },
      ],
      state: 'enabled',
    })
    const listed = await listTools()
    const searched = await service.search(principal)
    for (const tool of upstreamTools) {
      expect(
        listed.find((candidate) => candidate.name === `fixture.${tool.name}`)
          ?.annotations,
      ).toEqual(tool.annotations)
      expect(
        searched.find((candidate) => candidate.toolName === tool.name),
      ).toHaveProperty(
        'policy',
        tool.name === 'delete' ? 'require_approval' : 'allow',
      )
      expect(
        searched.find((candidate) => candidate.toolName === tool.name),
      ).toMatchObject(tool.annotations ? { annotations: tool.annotations } : {})
    }
    expect(
      listed.find((tool) => tool.name === 'search_tools')?.annotations,
    ).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    })
    expect(
      listed.find((tool) => tool.name === 'call_tool_with_approval')
        ?.annotations?.destructiveHint,
    ).toBe(true)
    const policies: Array<ToolPolicy> = [
      { pattern: '*', effect: 'block' },
      { annotation: 'read_only', effect: 'allow' },
      { annotation: 'destructive', effect: 'require_approval' },
    ]
    await manager.setToolPolicies(connection.id, connection.revision, policies)
    const clone = await manager.clone(connection.id, 'Clone')
    expect(
      (
        await pool.query(
          'SELECT pattern,annotation,effect FROM tool_policies WHERE connection_id=$1 ORDER BY annotation NULLS FIRST',
          [clone.id],
        )
      ).rows.map(policyFromRow),
    ).toEqual([policies[0]!, policies[2]!, policies[1]!])
    const snapshot = await connectionSnapshot(
      pool,
      {
        id: principal.id,
        disabled: false,
        administrator: false,
        capabilities: new Set(['manage_connections']),
      },
      new URL(`http://localhost/api/control?connection=${connection.id}`),
      () => Promise.resolve({ rows: [] }),
    )
    const detail = (await snapshot.json()).detail
    expect(detail.policies).toContainEqual(policies[1])
    expect(
      detail.tools.find((tool: { name: string }) => tool.name === 'read')
        .policy,
    ).toBe('allow')
    expect(
      detail.tools.find((tool: { name: string }) => tool.name === 'delete')
        .policy,
    ).toBe('require_approval')
    expect(
      (await service.search(principal)).find(
        (tool) => tool.qualifiedName === 'fixture__append',
      ),
    ).toBeUndefined()
    const server = await createGatewayServer(service, {
      ...principal,
      approvalMethod: 'gateway_enforced',
    })
    const client = new Client({ name: 'policy-enforcement', version: '1' })
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      expect(
        (
          await client.callTool({
            name: 'fixture.read',
            arguments: { arguments: {} },
          })
        ).isError,
      ).not.toBe(true)
      expect(
        (
          await client.callTool({
            name: 'fixture.delete',
            arguments: { arguments: {} },
          })
        ).isError,
      ).toBe(true)
      expect(
        (
          await client.callTool({
            name: 'call_tool',
            arguments: { name: 'fixture__delete', arguments: {} },
          })
        ).isError,
      ).toBe(true)
      expect(forwarded).toBe(1)
      await manager.setToolPolicies(connection.id, connection.revision + 1, [
        ...policies,
        { pattern: 'delete', effect: 'allow' },
      ])
      expect(
        (
          await client.callTool({
            name: 'fixture.delete',
            arguments: { arguments: {} },
          })
        ).isError,
      ).not.toBe(true)
      expect(forwarded).toBe(2)
    } finally {
      await client.close()
      await server.close()
    }
    upstreamTools = [{ name: 'read', inputSchema: { type: 'object' } }]
    await manager.refreshConnection(connection.id)
    expect(
      (await listTools()).find((tool) => tool.name === 'fixture.read'),
    ).not.toHaveProperty('annotations')
    expect(
      (await service.search(principal)).find(
        (tool) => tool.qualifiedName === 'fixture__read',
      )?.policy,
    ).toBe('require_approval')
  } finally {
    await manager.close()
    await pool.end()
    await Bun.sleep(10)
    await socket.stop()
    await database.close()
    upstream.stop(true)
  }
})
