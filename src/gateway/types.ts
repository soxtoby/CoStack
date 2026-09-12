import type { ToolPolicyEffect } from '../connections/types'

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
  policy: Exclude<ToolPolicyEffect, 'block'>
  available: boolean
  healthError?: string
}

export type GatewayToolTarget = Pick<
  GatewayTool,
  'connectionId' | 'accountId' | 'toolName'
>
