import { APIError } from 'better-auth/api'
import { SsoAccessDenied } from './access-denied'
import { claimPreProvisionedAccess } from './authorization'
import type { sso } from '@better-auth/sso'
import type { Pool } from 'pg'

export function ssoProvisioning(
  pool: Pool,
  applicationUrl: string,
): NonNullable<Parameters<typeof sso>[0]> {
  return {
    schema: {
      ssoProvider: {
        additionalFields: {
          requireVerifiedEmail: {
            type: 'boolean',
            required: false,
            defaultValue: true,
            input: true,
          },
        },
      },
    },
    trustEmailVerified: true,
    provisionUserOnEveryLogin: true,
    async provisionUser({ user, userInfo, provider }) {
      try {
        if (typeof userInfo.email !== 'string')
          throw new SsoAccessDenied('email-unverified')
        const policy = await pool.query<{ requireVerifiedEmail: boolean }>(
          'SELECT "requireVerifiedEmail" FROM "ssoProvider" WHERE "providerId" = $1',
          [provider.providerId],
        )
        await claimPreProvisionedAccess(
          {
            id: user.id,
            name: user.name,
            email: userInfo.email,
            emailVerified: userInfo.emailVerified === true,
            issuer: provider.issuer,
            ...(typeof userInfo.id === 'string'
              ? { subject: userInfo.id }
              : {}),
          },
          pool,
          {
            requireVerifiedEmail: policy.rows[0]?.requireVerifiedEmail ?? true,
          },
        )
      } catch (error) {
        if (!(error instanceof SsoAccessDenied)) throw error
        const location = new URL('/access-denied', applicationUrl)
        location.searchParams.set('reason', error.reason)
        if (typeof userInfo.email === 'string')
          location.searchParams.set('email', userInfo.email)
        throw new APIError('FOUND', undefined, { location: location.href })
      }
    },
  }
}
