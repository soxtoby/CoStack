import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod/v4'
import { evaluateToolPolicy } from '../connections/policy'
import { GatewayError } from './service'
import { builtinTools } from './builtin-tools'
import type { GatewayService } from './service'
import type { GatewayPrincipal, GatewayTool } from './types'
import type { ToolPolicy } from '../connections/types'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

export async function createGatewayServer(
  service: GatewayService,
  principal: GatewayPrincipal,
  clientId?: string,
  policies: Array<ToolPolicy> = [{ pattern: '*', effect: 'allow' }],
) {
  const searchPolicy = evaluateToolPolicy(policies, 'search_tools')
  const connectionNames =
    searchPolicy === 'allow'
      ? [
          ...new Set(
            (await service.search(principal)).map(
              (tool) => tool.connectionName,
            ),
          ),
        ].sort()
      : []
  const server = new McpServer(
    { name: 'costack', version: '0.1.0' },
    {
      instructions:
        'CoStack provides access to connected services through discovery and execution tools. ' +
        (searchPolicy === 'block'
          ? 'Tool discovery is currently blocked by policy. '
          : 'For tasks involving external services, use search_tools to check available capabilities before reporting that access is unavailable. Search for the service and requested operation together, with those terms first; omit task filters such as assignee and recency. Search results include complete schemas: invoke a matching result through the call tools without searching again to confirm it. Reuse discovered tools for subsequent calls. If no tool matches, remove query terms to broaden the search. ') +
        'Use the returned qualifiedName and inputSchema to construct calls. Respect availability and approval requirements. ' +
        (principal.kind === 'service_account'
          ? 'Service Accounts cannot invoke approval-required tools.'
          : principal.approvalMethod === 'client_managed'
            ? 'For require_approval results, obtain user approval for the exact call, then use call_tool_with_approval. Otherwise use call_tool.'
            : 'Use call_tool; the gateway requests approval when required.'),
    },
  )
  async function authorize(name: string, signal: AbortSignal) {
    const effect = evaluateToolPolicy(await service.builtinToolPolicies(), name)
    if (effect === 'block')
      throw new GatewayError('Tool is blocked', 'tool_blocked')
    if (effect !== 'require_approval') return
    if (
      principal.kind !== 'user' ||
      !server.server.getClientCapabilities()?.elicitation
    )
      throw new GatewayError(
        'This client does not support gateway-enforced approval',
        'approval_unsupported',
      )
    const response = await server.server.elicitInput(
      {
        mode: 'form',
        message: `Approve ${name}?`,
        requestedSchema: {
          type: 'object',
          properties: {
            approve: {
              type: 'boolean',
              title: 'Approve this call',
              default: false,
            },
          },
          required: ['approve'],
        },
      },
      { signal },
    )
    if (response.action !== 'accept' || response.content?.approve !== true)
      throw new GatewayError('User declined approval', 'approval_declined')
    if (
      evaluateToolPolicy(await service.builtinToolPolicies(), name) === 'block'
    )
      throw new GatewayError('Tool is blocked', 'tool_blocked')
  }
  if (evaluateToolPolicy(policies, 'search_tools') !== 'block')
    server.registerTool(
      'search_tools',
      {
        description:
          builtinTools[0]!.description +
          (connectionNames.length
            ? ` Connected services (display names): ${JSON.stringify(connectionNames)}.`
            : ''),
        inputSchema: {
          query: z
            .string()
            .describe(
              'Task-specific keywords with service and operation first, e.g. "linear list teams". Omit filters such as assignee and recency. Terms match service name, tool name, account name, or description case-insensitively. Omit only to list the full accessible catalog.',
            )
            .optional()
            .default(''),
        },
      },
      async ({ query }, extra) => {
        await authorize('search_tools', extra.signal)
        return textResult(await service.search(principal, query))
      },
    )
  const callSchema = {
    name: z.string().describe('Exact qualifiedName returned by search_tools.'),
    arguments: z
      .record(z.string(), z.unknown())
      .describe('Arguments matching the discovered tool inputSchema.')
      .optional()
      .default({}),
  }
  if (evaluateToolPolicy(policies, 'call_tool') !== 'block')
    server.registerTool(
      'call_tool',
      {
        description: builtinTools[1]!.description,
        inputSchema: callSchema,
      },
      async ({ name, arguments: args }, extra) => {
        await authorize('call_tool', extra.signal)
        const tool = await service.resolve(principal, name)
        if (
          tool.policy === 'require_approval' &&
          principal.approvalMethod === 'gateway_enforced'
        )
          return gatewayApprovedCall(
            server,
            service,
            principal,
            tool,
            args,
            clientId,
            extra.signal,
          )
        return resultOf(
          await service.call(
            principal,
            name,
            args,
            'ordinary',
            clientId,
            extra.signal,
          ),
        )
      },
    )
  if (evaluateToolPolicy(policies, 'call_tool_with_approval') !== 'block')
    server.registerTool(
      'call_tool_with_approval',
      {
        description: builtinTools[2]!.description,
        inputSchema: callSchema,
        annotations: {
          title: 'Call tool with approval',
          destructiveHint: true,
          openWorldHint: true,
        },
      },
      async ({ name, arguments: args }, extra) => {
        await authorize('call_tool_with_approval', extra.signal)
        return resultOf(
          await service.call(
            principal,
            name,
            args,
            'approved',
            clientId,
            extra.signal,
          ),
        )
      },
    )
  return server
}

async function gatewayApprovedCall(
  server: McpServer,
  service: GatewayService,
  principal: GatewayPrincipal,
  tool: GatewayTool,
  args: Record<string, unknown>,
  clientId: string | undefined,
  signal: AbortSignal,
) {
  if (!server.server.getClientCapabilities()?.elicitation)
    throw new GatewayError(
      'This client does not support gateway-enforced approval',
      'approval_unsupported',
    )
  const approval = await service.createApproval(principal, tool, args)
  const response = await server.server.elicitInput(
    {
      mode: 'form',
      message: `Approve ${tool.qualifiedName}? The gateway never stores tool arguments.`,
      requestedSchema: {
        type: 'object',
        properties: {
          approve: {
            type: 'boolean',
            title: 'Approve this call',
            default: false,
          },
        },
        required: ['approve'],
      },
    },
    { signal },
  )
  if (response.action !== 'accept' || response.content?.approve !== true)
    throw new GatewayError('User declined approval', 'approval_declined')
  await service.consumeApproval(
    principal,
    approval.id,
    approval.nonce,
    tool,
    args,
  )
  return resultOf(
    await service.call(
      principal,
      tool.qualifiedName,
      args,
      'approved',
      clientId,
      signal,
    ),
  )
}

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}
function resultOf(value: unknown): CallToolResult {
  if (
    value &&
    typeof value === 'object' &&
    Array.isArray((value as CallToolResult).content)
  )
    return value as CallToolResult
  return textResult(value)
}
