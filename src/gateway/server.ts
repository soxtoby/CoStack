import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { directTools, selectAccount } from './direct-tools'
import { GatewayError } from './service'
import type { GatewayService } from './service'
import type { GatewayPrincipal, GatewayTool } from './types'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'

export async function createGatewayServer(
  service: GatewayService,
  principal: GatewayPrincipal,
  clientId?: string,
) {
  const catalog = await service.accessibleTools(principal)
  const server = new Server(
    { name: 'costack', version: '0.1.0' },
    {
      instructions:
        'Connected service operations are directly callable, with one definition per connection operation. Pass upstream parameters in arguments and select account by namespace when multiple accounts are listed. Respect availability and approval requirements. ' +
        (principal.kind === 'service_account'
          ? 'Service Accounts cannot invoke approval-required tools.'
          : principal.approvalMethod === 'client_managed'
            ? 'For approval-required tools, obtain user approval for the exact account and arguments before calling.'
            : 'The gateway requests approval when required.'),
    },
  )
  const registered = new Map<
    string,
    {
      definition: Tool
      call: (
        args: Record<string, unknown>,
        signal: AbortSignal,
      ) => Promise<CallToolResult>
    }
  >()
  const direct = directTools(catalog)
  for (const tool of direct) {
    registered.set(tool.definition.name, {
      definition: tool.definition,
      call: async (input, signal) => {
        // Re-resolve against current access, accounts and policies on every call.
        const current = directTools(
          await service.accessibleTools(principal),
        ).find(
          (candidate) => candidate.definition.name === tool.definition.name,
        )
        if (!current)
          throw new GatewayError(
            'Tool is unavailable or not authorized',
            'tool_not_found',
          )
        const selected = selectAccount(current, input.account)
        if (
          Object.keys(input).some(
            (key) => key !== 'account' && key !== 'arguments',
          ) ||
          !input.arguments ||
          typeof input.arguments !== 'object' ||
          Array.isArray(input.arguments)
        )
          throw new GatewayError(
            'Pass upstream parameters as an arguments object',
            'invalid_arguments',
          )
        const args = input.arguments as Record<string, unknown>
        const validation = new AjvJsonSchemaValidator().getValidator(
          selected.inputSchema,
        )(args)
        if (!validation.valid)
          throw new GatewayError(validation.errorMessage, 'invalid_arguments')
        if (
          selected.policy === 'require_approval' &&
          principal.approvalMethod !== 'client_managed'
        )
          return gatewayApprovedCall(
            server,
            service,
            principal,
            selected,
            args,
            clientId,
            signal,
          )
        return resultOf(
          await service.call(
            principal,
            selected,
            args,
            selected.policy === 'require_approval' &&
              principal.approvalMethod === 'client_managed'
              ? 'approved'
              : 'ordinary',
            clientId,
            signal,
          ),
        )
      },
    })
  }
  server.registerCapabilities({ tools: {} })
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...registered.values()].map((tool) => tool.definition),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const tool = registered.get(request.params.name)
      if (!tool)
        throw new GatewayError(
          'Tool is unavailable or not authorized',
          'tool_not_found',
        )
      return await tool.call(request.params.arguments ?? {}, extra.signal)
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      }
    }
  })
  return server
}

async function gatewayApprovedCall(
  server: Server,
  service: GatewayService,
  principal: GatewayPrincipal,
  tool: GatewayTool,
  args: Record<string, unknown>,
  clientId: string | undefined,
  signal: AbortSignal,
) {
  if (principal.kind !== 'user')
    throw new GatewayError(
      'Service Accounts cannot use approval-required tools',
      'approval_unavailable',
    )
  if (!server.getClientCapabilities()?.elicitation)
    throw new GatewayError(
      'This client does not support gateway-enforced approval',
      'approval_unsupported',
    )
  const approval = await service.createApproval(principal, tool, args)
  const response = await server.elicitInput(
    {
      mode: 'form',
      message: `Approve ${tool.toolName} on ${tool.connectionName}${tool.accountId ? ` using ${tool.accountName} (${tool.accountKind}, ${tool.accountNamespace})` : ''}? The gateway never stores tool arguments.`,
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
    await service.call(principal, tool, args, 'approved', clientId, signal),
  )
}

function resultOf(value: unknown): CallToolResult {
  if (
    value &&
    typeof value === 'object' &&
    Array.isArray((value as CallToolResult).content)
  )
    return value as CallToolResult
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}
