import { betterAuth } from 'better-auth'
import { mcp } from '@better-auth/mcp'
import { sso } from '@better-auth/sso'
import { jwt } from 'better-auth/plugins'
import { databasePool } from '../database/pool'
import { ssoProvisioning } from './sso-provisioning'
import { SsoConfiguration } from './sso'
import type { BetterAuthPlugin } from 'better-auth'

const applicationUrl = process.env.APPLICATION_URL ?? 'http://localhost:3000'
const production = process.env.NODE_ENV === 'production'
export const ssoConfiguration = new SsoConfiguration(
  databasePool(),
  applicationUrl,
)

export const auth = betterAuth({
  appName: 'CoStack',
  baseURL: applicationUrl,
  trustedOrigins: ssoConfiguration.trustedOrigins,
  secret: process.env.BETTER_AUTH_SECRET,
  database: databasePool(),
  advanced: { database: { joins: true } },
  emailAndPassword: { enabled: true },
  plugins: [
    jwt(),
    sso(ssoProvisioning(databasePool(), applicationUrl)),
    mcp({
      resource: `${applicationUrl}/mcp`,
      loginPage: '/login',
      consentPage: '/oauth/consent',
      scopes: ['openid', 'profile', 'email', 'offline_access', 'mcp:use'],
      accessTokenExpiresIn: 15 * 60,
      m2mAccessTokenExpiresIn: 10 * 60,
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
    }) as unknown as BetterAuthPlugin,
  ],
})

export function authHandler(request: Request) {
  const path = new URL(request.url).pathname
  if (
    request.method !== 'GET' &&
    ['/sso/register', '/sso/update-provider', '/sso/delete-provider'].some(
      (suffix) => path.endsWith(suffix),
    )
  ) {
    return Response.json(
      { error: 'Use the administration UI' },
      { status: 403 },
    )
  }
  if (production && path.endsWith('/sign-up/email')) {
    return Response.json(
      { error: 'Local registration is disabled' },
      { status: 404 },
    )
  }
  return auth.handler(request)
}
