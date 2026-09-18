import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'

export type ToolPolicyEffect = 'allow' | 'require_approval' | 'block'
export type ConnectionState = 'enabled' | 'disabled'

export type StdioConfig = {
  kind: 'stdio'
  command: string
  args?: Array<string>
  environment?: Record<string, string>
}

export type HttpConfig = {
  kind: 'streamable_http'
  url: string
  headers?: Record<string, string>
}

export type OAuthClientConfig = {
  clientId: string
  clientSecret: string
  scope?: string
}

export type OAuthClientSummary = {
  clientId: string
  scope?: string
  hasSecret: boolean
}

export type TransportConfig = StdioConfig | HttpConfig
export type ToolPolicyAnnotation = 'read_only' | 'destructive' | 'open_world'
export type ToolPolicy = { effect: ToolPolicyEffect } & (
  | { pattern: string; annotation?: never }
  | { annotation: ToolPolicyAnnotation; pattern?: never }
)

export type ConnectionInput = {
  organizationId: string
  displayName: string
  namespace?: string
  transport: TransportConfig
  groupIds: Array<string>
  policies: Array<ToolPolicy>
  state: ConnectionState
  registry?: { sourceId: string; serverId: string; version: string }
}

export type DiscoveredTool = {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: ToolAnnotations
}

export type AccountSummary = {
  id: string
  connectionId: string
  kind: 'shared' | 'personal'
  ownerUserId?: string
  displayName: string
  namespace: string
  hasSecret: boolean
}
