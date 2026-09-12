import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createGatewayServer } from './server'
import type { GatewayService } from './service'
import type { ToolPolicy } from '../connections/types'

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
  const server = createGatewayServer(
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
