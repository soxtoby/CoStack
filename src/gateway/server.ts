import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { z } from 'zod/v4'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { directTools, selectAccount } from './direct-tools'
import { GatewayError } from './service'
import { builtinTools, evaluateBuiltinToolPolicy } from './builtin-tools'
import type { GatewayService } from './service'
import type { GatewayPrincipal, GatewayTool } from './types'
import type { ToolPolicy } from '../connections/types'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'

export async function createGatewayServer(
  service: GatewayService,
  principal: GatewayPrincipal,
  clientId?: string,
  policies: Array<ToolPolicy> = [{ pattern: '*', effect: 'allow' }],
) {
  const searchPolicy = evaluateBuiltinToolPolicy(policies, 'search_tools')
  const catalog =
    searchPolicy === 'allow' ? await service.search(principal) : []
  const connectionNames =
    searchPolicy === 'allow'
      ? [...new Set(catalog.map((tool) => tool.connectionName))].sort()
      : []
  const server = new Server(
    { name: 'costack', version: '0.1.0' },
    {
      instructions:
        'Connected service operations are directly callable, with one definition per connection operation. Pass upstream parameters in arguments and select account by namespace when multiple accounts are listed. Prefer direct tools; use search_tools and call_tool as a compatibility fallback. ' +
        (searchPolicy === 'block'
          ? 'Tool discovery is currently blocked by policy. '
          : '') +
        'For compatibility search results, use the returned qualifiedName and inputSchema to construct meta-tool calls. Respect availability and approval requirements. ' +
        (principal.kind === 'service_account'
          ? 'Service Accounts cannot invoke approval-required tools.'
          : principal.approvalMethod === 'client_managed'
            ? 'For approval-required direct tools, obtain user approval for the exact account and arguments before calling. For compatibility search results, use call_tool_with_approval.'
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
  function registerTool<T extends z.ZodRawShape>(
    name: string,
    config: {
      description: string
      inputSchema: T
      annotations?: Tool['annotations']
    },
    handler: (
      args: z.infer<z.ZodObject<T>>,
      extra: { signal: AbortSignal },
    ) => Promise<CallToolResult>,
  ) {
    const schema = z.object(config.inputSchema)
    registered.set(name, {
      definition: {
        name,
        description: config.description,
        inputSchema: z.toJSONSchema(schema, {
          io: 'input',
        }) as Tool['inputSchema'],
        annotations: config.annotations,
      },
      call: async (args, signal) =>
        handler(await schema.parseAsync(args), { signal }),
    })
  }
  async function authorize(name: string, signal: AbortSignal) {
    const effect = evaluateBuiltinToolPolicy(
      await service.builtinToolPolicies(),
      name,
    )
    if (effect === 'block')
      throw new GatewayError('Tool is blocked', 'tool_blocked')
    if (effect !== 'require_approval') return
    if (
      principal.kind !== 'user' ||
      !server.getClientCapabilities()?.elicitation
    )
      throw new GatewayError(
        'This client does not support gateway-enforced approval',
        'approval_unsupported',
      )
    const response = await server.elicitInput(
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
      evaluateBuiltinToolPolicy(await service.builtinToolPolicies(), name) ===
      'block'
    )
      throw new GatewayError('Tool is blocked', 'tool_blocked')
  }
  if (evaluateBuiltinToolPolicy(policies, 'search_tools') !== 'block')
    registerTool(
      'search_tools',
      {
        annotations: builtinTools[0]!.annotations,
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
  if (evaluateBuiltinToolPolicy(policies, 'call_tool') !== 'block')
    registerTool(
      'call_tool',
      {
        description: builtinTools[1]!.description,
        annotations: builtinTools[1]!.annotations,
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
  if (
    evaluateBuiltinToolPolicy(policies, 'call_tool_with_approval') !== 'block'
  )
    registerTool(
      'call_tool_with_approval',
      {
        description: builtinTools[2]!.description,
        inputSchema: callSchema,
        annotations: builtinTools[2]!.annotations,
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
  const direct = directTools(catalog)
  const callPath = (tool: GatewayTool) =>
    tool.policy === 'require_approval' &&
    principal.approvalMethod === 'client_managed'
      ? 'call_tool_with_approval'
      : 'call_tool'
  for (const tool of direct) {
    if (
      evaluateBuiltinToolPolicy(policies, callPath(tool.accounts[0]!)) ===
      'block'
    )
      continue
    registered.set(tool.definition.name, {
      definition: tool.definition,
      call: async (input, signal) => {
        // Re-resolve against current access, accounts and policies on every call.
        const currentPolicies = await service.builtinToolPolicies()
        if (
          evaluateBuiltinToolPolicy(currentPolicies, 'search_tools') !== 'allow'
        )
          throw new GatewayError(
            'Direct discovery is restricted; use authorized meta-tools',
            'tool_blocked',
          )
        const current = directTools(await service.search(principal)).find(
          (candidate) => candidate.definition.name === tool.definition.name,
        )
        if (!current)
          throw new GatewayError(
            'Tool is unavailable or not authorized',
            'tool_not_found',
          )
        const selected = selectAccount(current, input.account)
        await authorize(callPath(selected), signal)
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
            selected.policy === 'require_approval' ? 'approved' : 'ordinary',
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
