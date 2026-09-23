import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
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
  private constructor(
    private readonly client: Client,
    private readonly stderr?: OutputTail,
  ) {}

  static async connect(
    config: TransportConfig,
    secrets: Record<string, string>,
    authProvider?: OAuthClientProvider,
  ) {
    const client = new Client({ name: 'costack', version: '0.1.0' })
    if (config.kind === 'stdio') {
      const env = {
        ...toolchainEnvironment(),
        ...(config.environment ?? {}),
        ...secrets,
      }
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env,
        stderr: 'pipe',
      })
      // The SDK only reports "Connection closed" when the process exits, so
      // keep its final stderr output to explain why (missing command, crash).
      const stderr = new OutputTail()
      transport.stderr?.on('data', (chunk: Buffer | string) =>
        stderr.append(String(chunk)),
      )
      try {
        await client.connect(transport)
      } catch (error) {
        throw stderr.explain(error)
      }
      return new McpUpstreamClient(client, stderr)
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
    const result = await this.client
      .listTools(undefined, signal ? { signal } : undefined)
      .catch((error: unknown) => {
        throw this.stderr?.explain(error) ?? error
      })
    return result.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    }))
  }

  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    return this.client
      .callTool(
        { name, arguments: args },
        undefined,
        signal ? { signal } : undefined,
      )
      .catch((error: unknown) => {
        throw this.stderr?.explain(error) ?? error
      })
  }

  close() {
    return this.client.close()
  }
}

/**
 * The MCP SDK only passes a fixed allowlist (PATH, HOME, ...) to server
 * processes, which drops the cache and first-run settings the container image
 * configures for `dnx`, `dotnet`, and `bunx`. Forward those without exposing
 * the rest of CoStack's environment (database URL, secret key, tokens).
 */
function toolchainEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        /^(DOTNET|NUGET|BUN)_/.test(entry[0]) && entry[1] !== undefined,
    ),
  )
}

/** Keeps the last few lines a server process wrote to stderr. */
class OutputTail {
  private text = ''

  append(chunk: string) {
    this.text = (this.text + chunk).slice(-4_096)
  }

  explain(error: unknown) {
    if (
      !(error instanceof McpError) ||
      error.code !== ErrorCode.ConnectionClosed
    )
      return error
    const output = this.text.trim().split(/\r?\n/).slice(-5).join('\n')
    return new Error(
      output
        ? `Server process exited: ${output}`
        : 'Server process exited without writing anything to stderr',
      { cause: error },
    )
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
