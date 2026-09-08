import { OFFICIAL_REGISTRY } from './registry'
import type { RegistryServer } from './registry'
import type { ConnectionInput, TransportConfig } from './types'

export type BundledMcp = {
  id: string
  displayName: string
  icon: string
  description: string
  keywords: Array<string>
  transport: TransportConfig
  documentationUrl: string
  setup: string
  registryIds: Array<string>
}

// Add entries here; discovery, review, and Account setup use this same catalog.
export const bundledMcps: Array<BundledMcp> = [
  {
    id: 'github',
    displayName: 'GitHub',
    icon: '/icons/github.svg',
    description:
      'GitHub’s own MCP server for repositories, issues, pull requests, and workflows.',
    keywords: ['git', 'github', 'repositories', 'pull requests', 'issues'],
    transport: {
      kind: 'streamable_http',
      url: 'https://api.githubcopilot.com/mcp/',
    },
    documentationUrl:
      'https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md',
    setup:
      'After saving, choose Add Account and Use manual credentials instead. Enter {"Authorization":"Bearer YOUR_GITHUB_TOKEN"} in the credentials JSON, using a GitHub personal access token with access to the repositories you need. Then configure the discovered tools and make the connection available.',
    registryIds: ['io.github.github/github-mcp-server'],
  },
]

export function searchBundledMcps(query: string) {
  const words = query.trim().toLowerCase().split(/\s+/)
  return bundledMcps.filter((entry) => {
    const text = [
      entry.displayName,
      entry.description,
      ...entry.keywords,
      ...entry.registryIds,
    ]
      .join(' ')
      .toLowerCase()
    return words.every((word) => text.includes(word))
  })
}

export function bundledPrefill(
  entry: BundledMcp,
  organizationId: string,
): ConnectionInput {
  return {
    organizationId,
    displayName: entry.displayName,
    transport: structuredClone(entry.transport),
    state: 'disabled',
    groupIds: [],
    policies: [{ pattern: '*', effect: 'block' }],
  }
}

export function findBundledMcp(transport: {
  kind?: unknown
  url?: unknown
  command?: unknown
  args?: unknown
}) {
  return bundledMcps.find(({ transport: bundled }) => {
    if (bundled.kind !== transport.kind) return false
    if (bundled.kind === 'streamable_http') return bundled.url === transport.url
    return (
      bundled.command === transport.command &&
      JSON.stringify(bundled.args ?? []) ===
        JSON.stringify(transport.args ?? [])
    )
  })
}

export function isBundledRegistryEntry(
  entry: RegistryServer,
  registryUrl: string,
  query: string,
) {
  return (
    registryUrl.replace(/\/+$/, '') === OFFICIAL_REGISTRY &&
    searchBundledMcps(query).some((bundled) =>
      bundled.registryIds.includes(entry.server.name),
    )
  )
}
