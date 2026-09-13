import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createGatewayServer } from './server'
import type { GatewayService } from './service'

test('advertises no CoStack tools when no connection tools are accessible', async () => {
  const service = {
    accessibleTools: () => Promise.resolve([]),
  } as unknown as GatewayService
  const server = await createGatewayServer(service, {
    id: 'user',
    organizationId: 'org',
    displayName: 'User',
    kind: 'user',
    approvalMethod: 'client_managed',
  })
  const client = new Client({ name: 'test', version: '1' })
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    expect((await client.listTools()).tools).toEqual([])
  } finally {
    await client.close()
    await server.close()
  }
})
