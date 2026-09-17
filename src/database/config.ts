import { ManagedIdentityCredential } from '@azure/identity'
import { parseIntoClientConfig } from 'pg-connection-string'
import type { PoolConfig } from 'pg'

type DatabaseCredential = Pick<ManagedIdentityCredential, 'getToken'>

export function databaseConfig(
  environment: NodeJS.ProcessEnv,
  createCredential: (clientId?: string) => DatabaseCredential = (clientId) =>
    new ManagedIdentityCredential(clientId ? { clientId } : {}),
): PoolConfig {
  const connectionString = environment.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is required')

  const max = Number(environment.DATABASE_POOL_MAX ?? 10)
  const authentication = environment.DATABASE_AUTHENTICATION ?? 'password'
  if (authentication === 'password') return { connectionString, max }
  if (authentication !== 'azure-managed-identity') {
    throw new Error('Unsupported DATABASE_AUTHENTICATION')
  }

  // Parse first: pg's connectionString would otherwise override the callback.
  const config = parseIntoClientConfig(connectionString)
  if (config.password) {
    throw new Error('Managed identity DATABASE_URL must not contain a password')
  }
  if (!config.host || !config.user || !config.database) {
    throw new Error(
      'Managed identity DATABASE_URL requires host, user, and database',
    )
  }
  if (
    config.ssl === false ||
    (typeof config.ssl === 'object' && config.ssl.rejectUnauthorized === false)
  ) {
    throw new Error('Managed identity requires verified PostgreSQL TLS')
  }

  const credential = createCredential(environment.DATABASE_IDENTITY_CLIENT_ID)
  return {
    ...config,
    max,
    ssl: {
      ...(typeof config.ssl === 'object' ? config.ssl : {}),
      rejectUnauthorized: true,
    },
    password: async () => {
      const token = await credential.getToken(
        'https://ossrdbms-aad.database.windows.net/.default',
      )
      if (!token.token)
        throw new Error('No PostgreSQL managed identity token returned')
      return token.token
    },
  }
}
