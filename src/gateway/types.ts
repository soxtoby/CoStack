import type { ToolPolicyEffect } from '../connections/types'
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'

export type GatewayPrincipal = {
  id: string
  organizationId: string
  kind: 'user' | 'service_account'
  displayName: string
  approvalMethod?: 'gateway_enforced' | 'client_managed'
}

export type GatewayTool = {
  qualifiedName: string
  connectionId: string
  connectionNamespace: string
  accountId?: string
  accountNamespace?: string
  accountKind?: 'personal' | 'shared'
  connectionName: string
  accountName?: string
  toolName: string
  description?: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: ToolAnnotations
  policy: Exclude<ToolPolicyEffect, 'block'>
  available: boolean
  healthError?: string
}

export type GatewayToolTarget = Pick<
  GatewayTool,
  'connectionId' | 'accountId' | 'toolName'
>
