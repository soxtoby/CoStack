import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { DiscoveredTool, TransportConfig } from './types'

export interface UpstreamClient {
  listTools: (signal?: AbortSignal) => Promise<Array<DiscoveredTool>>
  callTool: (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>
  close: () => Promise<void>
}

export class McpUpstreamClient implements UpstreamClient {
  private constructor(private readonly client: Client) {}

  static async connect(
    config: TransportConfig,
    secrets: Record<string, string>,
    authProvider?: OAuthClientProvider,
  ) {
    const client = new Client({ name: 'costack', version: '0.1.0' })
    if (config.kind === 'stdio') {
      const env = { ...(config.environment ?? {}), ...secrets }
      await client.connect(
        new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env,
          stderr: 'pipe',
        }),
      )
    } else {
      validateHttpUrl(config.url)
      const headers = new Headers(config.headers)
      for (const [name, value] of Object.entries(secrets))
        headers.set(name, value)
      await client.connect(
        new StreamableHTTPClientTransport(new URL(config.url), {
          ...(authProvider ? { authProvider } : {}),
          requestInit: { headers, redirect: 'manual' },
          fetch: sameOriginFetch,
          reconnectionOptions: {
            initialReconnectionDelay: 1_000,
            maxReconnectionDelay: 1_000,
            reconnectionDelayGrowFactor: 1,
            maxRetries: 1,
          },
        }) as unknown as Transport,
      )
    }
    return new McpUpstreamClient(client)
  }

  async listTools(signal?: AbortSignal) {
    const result = await this.client.listTools(
      undefined,
      signal ? { signal } : undefined,
    )
    return result.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    }))
  }

  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    return this.client.callTool(
      { name, arguments: args },
      undefined,
      signal ? { signal } : undefined,
    )
  }

  close() {
    return this.client.close()
  }
}

export function validateHttpUrl(value: string) {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new Error('HTTP MCP URLs must use HTTPS except on loopback')
}

async function sameOriginFetch(
  input: string | URL | Request,
  init?: RequestInit,
) {
  const initial = input instanceof Request ? input.url : input.toString()
  const response = await fetch(input, { ...init, redirect: 'manual' })
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location')
    if (!location) return response
    const target = new URL(location, initial)
    if (target.origin !== new URL(initial).origin)
      throw new Error('Cross-origin upstream redirect rejected')
    return fetch(target, { ...init, redirect: 'manual' })
  }
  return response
}
