import { afterEach, describe, expect, test } from 'bun:test'
import { bootstrap } from './setup'
import type { Pool, PoolClient, QueryResult } from 'pg'

const originalToken = process.env.BOOTSTRAP_TOKEN

afterEach(() => {
  process.env.BOOTSTRAP_TOKEN = originalToken
})

describe('bootstrap', () => {
  test('creates the Better Auth user before opening the application transaction', async () => {
    process.env.BOOTSTRAP_TOKEN = 'bootstrap-token'
    const events: Array<string> = []
    const result = (rows: Array<unknown> = []) =>
      ({ rows, rowCount: rows.length }) as QueryResult
    const client = {
      query: (sql: string) => {
        events.push(sql.split(/\s+/).filter(Boolean).slice(0, 3).join(' '))
        if (sql.includes('bootstrap_completed_at'))
          return Promise.resolve(result([{ bootstrap_completed_at: null }]))
        return Promise.resolve(result())
      },
      release: () => undefined,
    } as unknown as PoolClient
    const pool = {
      query: client.query,
      connect: () => Promise.resolve(client),
    } as unknown as Pool

    await bootstrap(
      {
        token: 'bootstrap-token',
        organizationName: 'Example',
        administratorName: 'Admin',
        administratorEmail: 'admin@example.test',
        administratorPassword: 'password',
      },
      {
        pool,
        signUp: () => {
          events.push('SIGN UP')
          return Promise.resolve({
            user: {
              id: 'user-id',
              name: 'Admin',
              email: 'admin@example.test',
            },
          })
        },
      },
    )

    expect(events.indexOf('SIGN UP')).toBeLessThan(events.indexOf('BEGIN'))
  })
})
