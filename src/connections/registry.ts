import { defaultToolPolicies } from './policy'
import type { ConnectionInput, TransportConfig } from './types'

export const OFFICIAL_REGISTRY = 'https://registry.modelcontextprotocol.io'

export type RegistryServer = {
  server: {
    name: string
    title?: string
    icons?: Array<{ src: string; mimeType?: string; theme?: 'light' | 'dark' }>
    description?: string
    version: string
    packages?: Array<{
      registryType: string
      identifier: string
      version: string
      runtimeHint?: string
      packageArguments?: Array<{ value: string }>
    }>
    remotes?: Array<{ type: string; url: string }>
  }
}

export class RegistryClient {
  constructor(
    private readonly baseUrl = OFFICIAL_REGISTRY,
    private readonly request: typeof fetch = fetch,
  ) {}

  async list(
    search = '',
    cursor?: string,
  ): Promise<{
    servers: Array<RegistryServer>
    metadata?: { nextCursor?: string }
  }> {
    const url = new URL('/v0.1/servers', this.baseUrl)
    url.searchParams.set('version', 'latest')
    url.searchParams.set('limit', '20')
    if (search.trim()) url.searchParams.set('search', search.trim())
    if (cursor) url.searchParams.set('cursor', cursor)
    const response = await this.request(url)
    if (!response.ok) throw new Error(`Registry returned ${response.status}`)
    return response.json()
  }

  async get(serverName: string, version = 'latest'): Promise<RegistryServer> {
    const url = new URL(
      `/v0.1/servers/${encodeURIComponent(serverName)}/versions/${encodeURIComponent(version)}`,
      this.baseUrl,
    )
    const response = await this.request(url)
    if (!response.ok) throw new Error(`Registry returned ${response.status}`)
    return (await response.json()) as RegistryServer
  }

  prefill(
    entry: RegistryServer,
    organizationId: string,
    sourceId: string,
  ): ConnectionInput {
    const server = entry.server
    return {
      organizationId,
      displayName: server.title || server.name.split('/').at(-1) || server.name,
      transport: registryTransport(server),
      state: 'enabled',
      groupIds: [],
      policies: defaultToolPolicies(),
      registry: { sourceId, serverId: server.name, version: server.version },
    }
  }

  async hasUpdate(serverId: string, currentVersion: string) {
    const latest = await this.get(serverId)
    return latest.server.version === currentVersion
      ? undefined
      : latest.server.version
  }
}

function registryTransport(server: RegistryServer['server']): TransportConfig {
  const remote = server.remotes?.find(
    (candidate) => candidate.type === 'streamable-http',
  )
  if (remote) return { kind: 'streamable_http', url: remote.url }
  const pkg = server.packages?.find((candidate) =>
    ['npm', 'nuget'].includes(candidate.registryType),
  )
  if (!pkg)
    throw new Error(
      'Registry entry has no supported HTTP, Bun/npm, or .NET transport',
    )
  const values = pkg.packageArguments?.map(({ value }) => value) ?? []
  if (pkg.registryType === 'npm')
    return {
      kind: 'stdio',
      command: 'bunx',
      args: [`${pkg.identifier}@${pkg.version}`, ...values],
    }
  return {
    kind: 'stdio',
    command: 'dnx',
    args: ['--yes', `${pkg.identifier}@${pkg.version}`, '--', ...values],
  }
}
