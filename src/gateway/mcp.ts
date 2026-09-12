import { requireMcpAuth } from '@better-auth/mcp'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { auth } from '../auth/auth'
import { ConnectionManager } from '../connections/manager'
import { SecretVault } from '../connections/secrets'
import { databasePool } from '../database/pool'
import { GatewayService } from './service'
import { createGatewayServer } from './server'
import type { GatewayPrincipal } from './types'
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
  const server = createGatewayServer(
    service,
    principal,
    clientId,
    await service.builtinToolPolicies(),
  )
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  })
  await server.connect(transport)
  return transport.handleRequest(request)
}

function tokenClientId(claims: JWTPayload) {
  const value = claims.client_id ?? claims.azp
  return typeof value === 'string' ? value : undefined
}

function jsonRpcError(status: number, message: string) {
  return Response.json(
    { jsonrpc: '2.0', error: { code: -32000, message }, id: null },
    { status },
  )
}
