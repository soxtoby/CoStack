import { betterAuth } from 'better-auth'
import { mcp } from '@better-auth/mcp'
import { sso } from '@better-auth/sso'
import { jwt } from 'better-auth/plugins'
import { databasePool } from '../database/pool'
import { claimPreProvisionedAccess } from './authorization'
import type { BetterAuthPlugin } from 'better-auth'

const applicationUrl = process.env.APPLICATION_URL ?? 'http://localhost:3000'
const production = process.env.NODE_ENV === 'production'

export const auth = betterAuth({
  appName: 'CoStack',
  baseURL: applicationUrl,
  secret: process.env.BETTER_AUTH_SECRET,
  database: databasePool(),
  advanced: { database: { joins: true } },
  emailAndPassword: { enabled: true },
  plugins: [
    jwt(),
    sso({
      async provisionUser({ user, userInfo, provider }) {
        await claimPreProvisionedAccess(
          {
            id: user.id,
            name: user.name,
            email: user.email,
            emailVerified: user.emailVerified,
            issuer: provider.issuer,
            ...(typeof userInfo.sub === 'string'
              ? { subject: userInfo.sub }
              : {}),
          },
          databasePool(),
        )
      },
    }),
    mcp({
      resource: `${applicationUrl}/mcp`,
      loginPage: '/login',
      consentPage: '/oauth/consent',
      scopes: ['openid', 'profile', 'email', 'offline_access', 'mcp:use'],
      accessTokenExpiresIn: 15 * 60,
      m2mAccessTokenExpiresIn: 10 * 60,
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
