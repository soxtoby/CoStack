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
  manualCredentials?: string
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
      'After saving, choose Add Account and Use manual credentials instead. Enter {"Authorization":"Bearer YOUR_GITHUB_TOKEN"} in the credentials JSON, using a GitHub personal access token with access to the repositories you need. Then configure the discovered tools.',
    registryIds: ['io.github.github/github-mcp-server'],
  },
  {
    id: 'slack',
    displayName: 'Slack',
    icon: '/icons/slack.ico',
    description:
      'Slack’s own MCP server for searching conversations, sending messages, and managing canvases.',
    keywords: ['slack', 'chat', 'messages', 'channels', 'search', 'canvases'],
    transport: {
      kind: 'streamable_http',
      url: 'https://mcp.slack.com/mcp',
    },
    documentationUrl: 'https://docs.slack.dev/ai/slack-mcp-server/',
    setup:
      'Requires an internal or Slack Marketplace app; unlisted apps cannot use MCP. After saving, open Advanced OAuth application and enter your Slack app’s Client ID, Client secret, and user scopes for the tools you need. Register the gateway’s OAuth callback URL in your Slack app, then choose Add Account to authorize. Slack does not support dynamic client registration. Configure the discovered tools.',
    registryIds: [],
  },
  {
    id: 'microsoft-teams',
    displayName: 'Microsoft Teams',
    icon: '/icons/teams.ico',
    description:
      'Microsoft’s Agent 365 MCP server for Teams chats, channels, and messages. Requires tenant setup and preview access.',
    keywords: ['microsoft', 'teams', 'chat', 'messages', 'channels', '365'],
    transport: {
      kind: 'streamable_http',
      url: 'https://agent365.svc.cloud.microsoft/agents/tenants/{tenantId}/servers/mcp_TeamsServer',
    },
    documentationUrl:
      'https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-teams-tools',
    setup:
      'Before saving, enter your Microsoft Entra tenant ID in the tenant ID field. Requires an eligible Agent 365 Frontier tenant and administrator consent for the Agent 365 Tools permission McpServers.Teams.All. After saving, choose Add Account and Use manual credentials instead. Enter {"Authorization":"Bearer YOUR_AGENT_365_ACCESS_TOKEN"} using an access token for Agent 365 Tools with that permission. Replace the token when it expires. Configure the discovered tools.',
    registryIds: [],
  },
  {
    id: 'linear',
    displayName: 'Linear',
    icon: '/icons/linear.svg',
    description:
      'Linear’s own MCP server for finding, creating, and updating issues, projects, and comments.',
    keywords: [
      'linear',
      'issues',
      'projects',
      'tickets',
      'roadmap',
      'comments',
    ],
    transport: {
      kind: 'streamable_http',
      url: 'https://mcp.linear.app/mcp',
    },
    documentationUrl: 'https://linear.app/docs/mcp',
    setup: 'Connect using Linear OAuth or a personal API key.',
    manualCredentials: '{"Authorization":"Bearer YOUR_LINEAR_API_KEY"}',
    registryIds: [],
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
    state: 'enabled',
    groupIds: [],
    policies: [{ pattern: '*', effect: 'block' }],
  }
}

export const tenantIdPattern =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'

export function resolveBundledTransport(
  transport: TransportConfig,
  tenantId: string,
): TransportConfig {
  if (
    transport.kind !== 'streamable_http' ||
    !transport.url.includes('{tenantId}')
  )
    return transport
  const value = tenantId.trim()
  if (!new RegExp(`^${tenantIdPattern}$`).test(value))
    throw new Error('Enter a valid Microsoft Entra tenant ID (UUID).')
  return { ...transport, url: transport.url.replace('{tenantId}', value) }
}

export function findBundledMcp(transport: {
  kind?: unknown
  url?: unknown
  command?: unknown
  args?: unknown
}) {
  return bundledMcps.find(({ transport: bundled }) => {
    if (bundled.kind !== transport.kind) return false
    if (bundled.kind === 'streamable_http') {
      if (bundled.url === transport.url) return true
      // Keep setup guidance available after a tenant-specific URL is filled in.
      if (
        !bundled.url.includes('{tenantId}') ||
        typeof transport.url !== 'string'
      )
        return false
      const [prefix, suffix] = bundled.url.split('{tenantId}')
      if (prefix === undefined || suffix === undefined) return false
      if (!transport.url.startsWith(prefix) || !transport.url.endsWith(suffix))
        return false
      const tenantId = transport.url.slice(
        prefix.length,
        transport.url.length - suffix.length,
      )
      return /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
        tenantId,
      )
    }
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
