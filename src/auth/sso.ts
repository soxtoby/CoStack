import { lookup } from 'node:dns/promises'
import {
  classifyHost,
  isPublicRoutableHost,
} from '@better-auth/core/utils/host'
import { discoverOIDCConfig } from '@better-auth/sso'
import { loadAuthorization, may } from './authorization'
import type { Pool } from 'pg'

interface SsoAuth {
  api: {
    getSession: (input: { headers: Headers }) => Promise<{
      user: { id: string }
    } | null>
  }
  handler: (request: Request) => Promise<Response>
}

const endpointFields = [
  'discoveryEndpoint',
  'authorizationEndpoint',
  'tokenEndpoint',
  'jwksEndpoint',
  'userInfoEndpoint',
] as const

function publicHttpsUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('SSO requires a valid public HTTPS URL')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !isPublicRoutableHost(url.hostname)
  )
    throw new Error('SSO requires public HTTPS URLs without credentials')
  return url
}

/** Trust belongs to the authorized save request or the persisted SSO provider. */
export class SsoConfiguration {
  private readonly saves = new WeakMap<Request, Array<string>>()

  constructor(
    private readonly pool: Pool,
    private readonly applicationUrl: string,
    private readonly resolveAddresses: (
      hostname: string,
    ) => Promise<Array<{ address: string }>> = (hostname) =>
      lookup(hostname, { all: true }),
  ) {}

  redirectUri(providerId = 'organization') {
    return new URL(
      `/api/auth/sso/callback/${encodeURIComponent(providerId)}`,
      this.applicationUrl,
    ).href
  }

  private async publicOrigin(value: string) {
    const url = publicHttpsUrl(value)
    if (classifyHost(url.hostname).literal === 'fqdn') {
      const addresses = await this.resolveAddresses(url.hostname)
      if (
        !addresses.length ||
        addresses.some(({ address }) => !isPublicRoutableHost(address))
      )
        throw new Error(
          `SSO host ${url.hostname} must resolve to public addresses`,
        )
    }
    return url.origin
  }

  readonly trustedOrigins = async (
    request?: Request,
  ): Promise<Array<string>> => {
    if (!request) return []
    const saving = this.saves.get(request)
    if (saving) return saving
    const path = new URL(request.url).pathname
    if (
      path !== '/api/auth/sign-in/sso' &&
      !path.startsWith('/api/auth/sso/callback/')
    )
      return []

    const result = await this.pool.query<{
      issuer: string
      oidcConfig: string | null
    }>('SELECT issuer, "oidcConfig" FROM "ssoProvider" LIMIT 1')
    const provider = result.rows[0]
    if (!provider) return []
    const config = JSON.parse(provider.oidcConfig ?? '{}') as Record<
      string,
      unknown
    >
    const urls = [
      provider.issuer,
      ...endpointFields.flatMap((field) =>
        typeof config[field] === 'string' && config[field]
          ? [config[field]]
          : [],
      ),
    ]
    return this.publicOrigins(urls)
  }

  private async publicOrigins(urls: Array<string>) {
    // Validate every URL, but resolve each origin only once per request.
    const origins = [...new Set(urls.map((url) => publicHttpsUrl(url).origin))]
    return Promise.all(origins.map((origin) => this.publicOrigin(origin)))
  }

  async save(request: Request, body: Record<string, unknown>, auth: SsoAuth) {
    // Check browser origin before giving the submitted provider any trust.
    if (request.headers.get('origin') !== new URL(this.applicationUrl).origin)
      throw new Response('Invalid request origin', { status: 403 })
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session) throw new Response('Unauthenticated', { status: 401 })
    const authorization = await loadAuthorization(session.user.id, this.pool)
    if (!authorization || !may(authorization, 'manage_sso'))
      throw new Response('Forbidden', { status: 403 })

    const issuer = String(body.issuer ?? '').trim()
    const issuerUrl = publicHttpsUrl(issuer)
    if (issuerUrl.search || issuerUrl.hash)
      throw new Error('Issuer URL must not contain a query or fragment')
    await this.publicOrigin(issuer)

    // Use Better Auth's discovery and issuer validation. An issuer can advertise
    // endpoints on other public HTTPS origins (e.g. Entra's Graph user-info URL).
    const discoveredUrls = new Set([issuer])
    const config = await discoverOIDCConfig({
      issuer,
      isTrustedOrigin: (value) => {
        publicHttpsUrl(value)
        discoveredUrls.add(value)
        return true
      },
    })
    const origins = await this.publicOrigins([...discoveredUrls])
    const existing = await this.pool.query<{
      providerId: string
      domain: string
      oidcConfig: string | null
      requireVerifiedEmail: boolean
    }>(
      'SELECT "providerId", domain, "oidcConfig", "requireVerifiedEmail" FROM "ssoProvider" LIMIT 1',
    )
    const provider = existing.rows[0]
    if (
      body.requireVerifiedEmail !== undefined &&
      typeof body.requireVerifiedEmail !== 'boolean'
    )
      throw new Error('Require verified email must be true or false')
    const previousConfig = JSON.parse(provider?.oidcConfig ?? '{}')
    const clientSecret =
      String(body.clientSecret ?? '') || previousConfig.clientSecret
    if (!clientSecret) throw new Error('Client secret is required')
    // Better Auth's partial-update API cannot clear an optional endpoint. Fail
    // explicitly instead of retaining an endpoint from the previous issuer.
    if (provider && previousConfig.userInfoEndpoint && !config.userInfoEndpoint)
      throw new Error(
        'The new configuration has no user-info endpoint. Remove the existing SSO provider before configuring this provider.',
      )
    const upstream = new Request(
      new URL(
        provider ? '/api/auth/sso/update-provider' : '/api/auth/sso/register',
        this.applicationUrl,
      ),
      {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify({
          providerId: provider?.providerId ?? 'organization',
          issuer,
          domain: provider?.domain ?? 'organization.invalid',
          requireVerifiedEmail:
            body.requireVerifiedEmail ?? provider?.requireVerifiedEmail ?? true,
          oidcConfig: {
            ...config,
            clientId: String(body.clientId ?? ''),
            clientSecret,
            // Discovery above is validated even on update; Better Auth's update
            // API otherwise retains the previous provider's endpoints.
            skipDiscovery: true,
          },
        }),
      },
    )
    this.saves.set(upstream, origins)
    try {
      return await auth.handler(upstream)
    } finally {
      this.saves.delete(upstream)
    }
  }
}
