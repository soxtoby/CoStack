import { requireMcpAuth } from '@better-auth/mcp'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod/v4'
import { auth } from '../auth/auth'
import { ConnectionManager } from '../connections/manager'
import { SecretVault } from '../connections/secrets'
import { databasePool } from '../database/pool'
import { GatewayError, GatewayService } from './service'
import type { GatewayPrincipal, GatewayTool } from './types'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { JWTPayload } from 'jose'

const applicationUrl = new URL(
  process.env.APPLICATION_URL ?? 'http://localhost:3000',
)
let servicePromise: Promise<GatewayService> | undefined

async function gatewayService() {
  servicePromise ??= SecretVault.fromBase64(requiredSecretKey()).then(
    (vault) =>
      new GatewayService(
        databasePool(),
        new ConnectionManager(databasePool(), vault),
      ),
  )
  return servicePromise
}

export async function closeGateway() {
  if (!servicePromise) return
  await (await servicePromise).close()
  servicePromise = undefined
}

function requiredSecretKey() {
  const key = process.env.ACCOUNT_SECRET_KEY
  if (!key) throw new Error('ACCOUNT_SECRET_KEY is required')
  return key
}

export function validateGatewayRequest(request: Request) {
  const url = new URL(request.url)
  if (url.host !== applicationUrl.host)
    return new Response('Invalid Host', { status: 400 })
  const origin = request.headers.get('origin')
  if (origin && origin !== applicationUrl.origin)
    return new Response('Invalid Origin', { status: 403 })
  if (request.method !== 'POST')
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'POST' },
    })
}

const protectedMcpHandler = requireMcpAuth(
  auth,
  async (request, claims) => {
    const service = await gatewayService()
    const principal = claims.sub
      ? await service.loadPrincipal(claims.sub, tokenClientId(claims))
      : undefined
    if (!principal) return jsonRpcError(403, 'Principal is disabled or unknown')
    return serveMcpRequest(request, service, principal, tokenClientId(claims))
  },
  {
    resource: applicationUrl.href.replace(/\/$/, '') + '/mcp',
    requiredScopes: ['mcp:use'],
  },
)

export function mcpHandler(request: Request) {
  const invalid = validateGatewayRequest(request)
  return invalid ?? protectedMcpHandler(request)
}

export async function serveMcpRequest(
  request: Request,
  service: GatewayService,
  principal: GatewayPrincipal,
  clientId?: string,
) {
  const server = createGatewayServer(service, principal, clientId)
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  })
  await server.connect(transport)
  return transport.handleRequest(request)
}

export function createGatewayServer(
  service: GatewayService,
  principal: GatewayPrincipal,
  clientId?: string,
) {
  const server = new McpServer({ name: 'costack', version: '0.1.0' })
  server.registerTool(
    'search_tools',
    {
      description: 'Search tools available through this gateway',
      inputSchema: { query: z.string().optional().default('') },
    },
    async ({ query }) => textResult(await service.search(principal, query)),
  )
  const callSchema = {
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()).optional().default({}),
  }
  server.registerTool(
    'call_tool',
    {
      description: 'Call an allowed gateway tool',
      inputSchema: callSchema,
    },
    async ({ name, arguments: args }, extra) => {
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
    async ({ name, arguments: args }, extra) =>
      resultOf(
        await service.call(
          principal,
          name,
          args,
          'approved',
          clientId,
          extra.signal,
        ),
      ),
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

function tokenClientId(claims: JWTPayload) {
  const value = claims.client_id ?? claims.azp
  return typeof value === 'string' ? value : undefined
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
function jsonRpcError(status: number, message: string) {
  return Response.json(
    { jsonrpc: '2.0', error: { code: -32000, message }, id: null },
    { status },
  )
}
