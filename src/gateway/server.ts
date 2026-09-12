import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod/v4'
import { evaluateToolPolicy } from '../connections/policy'
import { GatewayError } from './service'
import type { GatewayService } from './service'
import type { GatewayPrincipal, GatewayTool } from './types'
import type { ToolPolicy } from '../connections/types'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

export function createGatewayServer(
  service: GatewayService,
  principal: GatewayPrincipal,
  clientId?: string,
  policies: Array<ToolPolicy> = [{ pattern: '*', effect: 'allow' }],
) {
  const server = new McpServer({ name: 'costack', version: '0.1.0' })
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
        description: 'Search tools available through this gateway',
        inputSchema: { query: z.string().optional().default('') },
      },
      async ({ query }, extra) => {
        await authorize('search_tools', extra.signal)
        return textResult(await service.search(principal, query))
      },
    )
  const callSchema = {
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()).optional().default({}),
  }
  if (evaluateToolPolicy(policies, 'call_tool') !== 'block')
    server.registerTool(
      'call_tool',
      {
        description: 'Call an allowed gateway tool',
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
        description: 'Call a tool after the client has obtained user approval',
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
