import { describe, expect, test } from 'bun:test'
import { Client } from 'pg'
import { databaseConfig } from './config'

const environment = {
  DATABASE_AUTHENTICATION: 'azure-managed-identity',
  DATABASE_URL:
    'postgresql://costack%20identity@server.postgres.database.azure.com:5432/costack?sslmode=verify-full',
}

describe('database authentication', () => {
  test('preserves password and local development configuration', () => {
    const url = 'postgresql://postgres:local@127.0.0.1/postgres?sslmode=disable'
    expect(
      databaseConfig({ DATABASE_URL: url, DATABASE_POOL_MAX: '1' }),
    ).toEqual({
      connectionString: url,
      max: 1,
    })
  })

  test('pg retains the token callback and obtains tokens for new connections', async () => {
    const scopes: Array<string | Array<string>> = []
    let selectedIdentity: string | undefined
    const config = databaseConfig(
      { ...environment, DATABASE_IDENTITY_CLIENT_ID: 'identity-client-id' },
      (clientId) => {
        selectedIdentity = clientId
        return {
          getToken: (scope) => {
            scopes.push(scope)
            return Promise.resolve({
              token: `token-${scopes.length}`,
              expiresOnTimestamp: Date.now() + 60000,
            })
          },
        }
      },
    )
    expect(selectedIdentity).toBe('identity-client-id')
    expect(config.user).toBe('costack identity')
    expect(config.ssl).toEqual({ rejectUnauthorized: true })
    expect(config.connectionString).toBeUndefined()
    for (const expected of ['token-1', 'token-2']) {
      const client = new Client(config)
      const password: unknown = client.password
      if (typeof password !== 'function')
        throw new Error('pg lost the token callback')
      expect(await password()).toBe(expected)
    }
    expect(scopes).toEqual([
      'https://ossrdbms-aad.database.windows.net/.default',
      'https://ossrdbms-aad.database.windows.net/.default',
    ])
  })

  test('uses system identity by default and propagates token failures', async () => {
    const config = databaseConfig(environment, (clientId) => {
      expect(clientId).toBeUndefined()
      return {
        getToken: () => Promise.reject(new Error('Identity unavailable')),
      }
    })
    if (typeof config.password !== 'function')
      throw new Error('Missing callback')
    await expect(config.password()).rejects.toThrow('Identity unavailable')
  })

  test('rejects mixed credentials and unverified TLS', () => {
    for (const url of [
      'postgresql://costack:secret@server/costack',
      'postgresql://costack@server/costack?sslmode=disable',
      'postgresql://costack@server/costack?sslmode=no-verify',
    ]) {
      expect(() =>
        databaseConfig({ ...environment, DATABASE_URL: url }),
      ).toThrow()
    }
  })

  test('rejects unknown authentication modes', () => {
    expect(() =>
      databaseConfig({ ...environment, DATABASE_AUTHENTICATION: 'typo' }),
    ).toThrow('Unsupported DATABASE_AUTHENTICATION')
  })
})
