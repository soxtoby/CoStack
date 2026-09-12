import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createGatewayServer } from './server'
import type { GatewayService } from './service'
import type { ToolPolicy } from '../connections/types'

test('restricted discovery does not load or advertise connected services', async () => {
  for (const effect of ['block', 'require_approval'] as const) {
    const service = {
      search: () => {
        throw new Error('Discovery must not run without authorization')
      },
    } as unknown as GatewayService
    const server = await createGatewayServer(
      service,
      {
        id: 'user',
        organizationId: 'org',
        displayName: 'User',
        kind: 'user',
        approvalMethod: 'gateway_enforced',
      },
      undefined,
      [
        { pattern: '*', effect: 'allow' },
        { pattern: 'search_tools', effect },
      ],
    )
    const client = new Client({ name: 'test', version: '1' })
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const search = (await client.listTools()).tools.find(
        (tool) => tool.name === 'search_tools',
      )
      expect(Boolean(search)).toBe(effect !== 'block')
      expect(search?.description ?? '').not.toContain('Connected services')
      expect(client.getInstructions()).toContain('gateway requests approval')
    } finally {
      await client.close()
      await server.close()
    }
  }
})

test('built-in policies control discovery, calls, and approval before execution', async () => {
  let policies: Array<ToolPolicy> = [
    { pattern: '*', effect: 'allow' },
    { pattern: 'call_*', effect: 'block' },
  ]
  let searches = 0
  let approve = false
  const service = {
    builtinToolPolicies: () => Promise.resolve(policies),
    search: () => {
      searches++
      return Promise.resolve([])
    },
  } as unknown as GatewayService
  const server = await createGatewayServer(
    service,
    {
      id: 'user',
      organizationId: 'org',
      displayName: 'User',
      kind: 'user',
      approvalMethod: 'client_managed',
    },
    undefined,
    policies,
  )
  const client = new Client(
    { name: 'test', version: '1' },
    { capabilities: { elicitation: { form: {} } } },
  )
  client.setRequestHandler(ElicitRequestSchema, () =>
    Promise.resolve({
      action: approve ? 'accept' : 'decline',
      content: { approve },
    }),
  )
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  searches = 0
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'search_tools',
    ])
    expect(
      (
        await client.callTool({
          name: 'call_tool',
          arguments: { name: 'upstream' },
        })
      ).isError,
    ).toBe(true)
    await client.callTool({ name: 'search_tools', arguments: {} })
    expect(searches).toBe(1)
    policies = [{ pattern: '*', effect: 'block' }]
    expect(
      (await client.callTool({ name: 'search_tools', arguments: {} })).isError,
    ).toBe(true)
    expect(searches).toBe(1)
    policies = [{ pattern: '*', effect: 'require_approval' }]
    expect(
      (await client.callTool({ name: 'search_tools', arguments: {} })).isError,
    ).toBe(true)
    expect(searches).toBe(1)
    approve = true
    expect(
      (await client.callTool({ name: 'search_tools', arguments: {} })).isError,
    ).not.toBe(true)
    expect(searches).toBe(2)
  } finally {
    await client.close()
    await server.close()
  }
})
