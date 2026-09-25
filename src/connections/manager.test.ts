import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { Pool } from 'pg'
import { migrate } from '../database/migrate'
import { ConnectionManager, RevisionConflictError } from './manager'
import { SecretVault } from './secrets'
import type { UpstreamClient } from './upstream'

const database = await PGlite.create()
const socket = new PGLiteSocketServer({
  db: database,
  host: '127.0.0.1',
  port: 0,
})
await socket.start()
const [, port] = socket.getServerConn().split(':')
if (!port) throw new Error('PGlite did not bind TCP')
const pool = new Pool({
  host: '127.0.0.1',
  port: Number(port),
  database: 'postgres',
  user: 'postgres',
  max: 1,
})
const vault = await SecretVault.fromBase64(
  crypto.getRandomValues(new Uint8Array(32)).toBase64(),
)
const fake: UpstreamClient = {
  listTools: () =>
    Promise.resolve([{ name: 'read_issue', inputSchema: { type: 'object' } }]),
  callTool: (_name, args) => Promise.resolve({ args }),
  close: () => Promise.resolve(),
}
const manager = new ConnectionManager(pool, vault, () => Promise.resolve(fake))

beforeAll(async () => {
  await migrate(pool)
  await pool.query(
    "INSERT INTO organizations (id, display_name) VALUES ('org', 'Test')",
  )
  await pool.query(
    "INSERT INTO groups (id, organization_id, display_name) VALUES ('group', 'org', 'Readers')",
  )
})

afterAll(async () => {
  await manager.close()
  await pool.end()
  await Bun.sleep(10)
  await socket.stop()
  await database.close()
})

describe('ConnectionManager', () => {
  test('saves enabled connections before credentials are available', async () => {
    const local = new ConnectionManager(pool, vault, () =>
      Promise.reject(new Error('Authentication required')),
    )
    let connectionId: string | undefined
    try {
      const created = await local.create({
        organizationId: 'org',
        displayName: 'Needs credentials',
        transport: { kind: 'streamable_http', url: 'https://mcp.example.test' },
        groupIds: ['group'],
        policies: [{ pattern: '*', effect: 'block' }],
        state: 'enabled',
      })
      connectionId = created.id
      expect(created.tools).toEqual([])
      expect(
        (
          await pool.query(
            `SELECT c.state,h.healthy,h.error FROM mcp_connections c
           JOIN connection_health h ON h.connection_id=c.id WHERE c.id=$1`,
            [created.id],
          )
        ).rows,
      ).toEqual([
        { state: 'enabled', healthy: false, error: 'Authentication required' },
      ])
      await local.setEnabled(created.id, false)
      expect(await local.setEnabled(created.id, true)).toBe(3)
      expect(
        (
          await pool.query(
            `SELECT c.state,h.healthy FROM mcp_connections c
           JOIN connection_health h ON h.connection_id=c.id WHERE c.id=$1`,
            [created.id],
          )
        ).rows,
      ).toEqual([{ state: 'enabled', healthy: false }])
    } finally {
      await local.close()
      if (connectionId)
        await pool.query('DELETE FROM mcp_connections WHERE id=$1', [
          connectionId,
        ])
    }
  })

  test('saves policy edits without rediscovery or changing transport, Groups, or tool inventory', async () => {
    let connectionId: string | undefined
    let discoveries = 0
    const local = new ConnectionManager(pool, vault, () => {
      discoveries++
      return Promise.resolve(fake)
    })
    try {
      const connection = await local.create({
        organizationId: 'org',
        displayName: 'Policy editor',
        transport: {
          kind: 'streamable_http',
          url: 'https://mcp.example.test/policies',
        },
        groupIds: ['group'],
        policies: [{ pattern: '*', effect: 'block' }],
        state: 'disabled',
      })
      connectionId = connection.id
      await local.setToolPolicies(connection.id, connection.revision, [
        { pattern: 'read_issue', effect: 'allow' },
      ])
      expect(discoveries).toBe(1)
      const row = (
        await pool.query(
          'SELECT transport_config,state,revision FROM mcp_connections WHERE id=$1',
          [connection.id],
        )
      ).rows[0]
      expect(row.transport_config.url).toBe('https://mcp.example.test/policies')
      expect(row.state).toBe('disabled')
      expect(row.revision).toBe(2)
      expect(
        (
          await pool.query(
            'SELECT group_id FROM connection_groups WHERE connection_id=$1',
            [connection.id],
          )
        ).rows,
      ).toEqual([{ group_id: 'group' }])
      expect(
        (
          await pool.query(
            'SELECT name FROM connection_tools WHERE connection_id=$1',
            [connection.id],
          )
        ).rows,
      ).toEqual([{ name: 'read_issue' }])
      await expect(
        local.setToolPolicies(connection.id, 1, [
          { pattern: '*', effect: 'block' },
        ]),
      ).rejects.toBeInstanceOf(RevisionConflictError)
      expect(
        (
          await pool.query(
            'SELECT pattern,effect FROM tool_policies WHERE connection_id=$1',
            [connection.id],
          )
        ).rows,
      ).toEqual([{ pattern: 'read_issue', effect: 'allow' }])
    } finally {
      await local.close()
      if (connectionId)
        await pool.query('DELETE FROM mcp_connections WHERE id=$1', [
          connectionId,
        ])
    }
  })
  test('validates before save, discovers tools, and protects revisions', async () => {
    const created = await manager.create({
      organizationId: 'org',
      displayName: 'GitHub',
      transport: { kind: 'streamable_http', url: 'https://mcp.example.test' },
      groupIds: ['group'],
      policies: [{ pattern: 'read_*', effect: 'allow' }],
      state: 'enabled',
    })
    expect(created.namespace).toBe('github')
    expect(
      (await pool.query('SELECT name FROM connection_tools')).rows,
    ).toEqual([{ name: 'read_issue' }])
    await manager.edit(created.id, 1, {
      organizationId: 'org',
      displayName: 'GitHub renamed',
      transport: { kind: 'streamable_http', url: 'https://mcp.example.test' },
      groupIds: ['group'],
      policies: [{ pattern: '*', effect: 'block' }],
      state: 'enabled',
    })
    await expect(
      manager.edit(created.id, 1, {
        organizationId: 'org',
        displayName: 'Stale',
        transport: { kind: 'streamable_http', url: 'https://mcp.example.test' },
        groupIds: [],
        policies: [],
        state: 'enabled',
      }),
    ).rejects.toBeInstanceOf(RevisionConflictError)
  })

  test('never returns Account plaintext and scopes Personal namespaces by owner', async () => {
    for (const id of ['one', 'two']) {
      await pool.query(
        `INSERT INTO principals (id, organization_id, kind, display_name)
         VALUES ($1, 'org', 'user', $1)`,
        [id],
      )
      await pool.query(
        'INSERT INTO users (principal_id, email) VALUES ($1,$2)',
        [id, `${id}@example.test`],
      )
    }
    const connectionId = (
      await pool.query(
        "SELECT id FROM mcp_connections WHERE namespace='github'",
      )
    ).rows[0].id as string
    for (const ownerUserId of ['one', 'two']) {
      const account = await manager.addAccount({
        connectionId,
        kind: 'personal',
        ownerUserId,
        displayName: 'Work',
        secrets: { Authorization: 'secret' },
      })
      expect(account).not.toHaveProperty('secrets')
      expect(account.namespace).toBe('github_work')
    }
    expect(await manager.visibleAccounts(connectionId, 'one')).toHaveLength(1)
  })

  test('deletes a connection with its Accounts, closes live clients, and keeps audit history', async () => {
    let closed = 0
    const local = new ConnectionManager(pool, vault, () =>
      Promise.resolve({
        ...fake,
        close: () => {
          closed += 1
          return Promise.resolve()
        },
      }),
    )
    await pool.query(
      `INSERT INTO principals (id, organization_id, kind, display_name)
       VALUES ('deleter', 'org', 'user', 'Deleter')`,
    )
    await pool.query(
      "INSERT INTO users (principal_id, email) VALUES ('deleter', 'deleter@example.test')",
    )
    const created = await local.create({
      organizationId: 'org',
      displayName: 'Doomed',
      transport: { kind: 'streamable_http', url: 'https://doomed.example' },
      groupIds: ['group'],
      policies: [{ pattern: '*', effect: 'allow' }],
      state: 'enabled',
    })
    const shared = await local.addAccount({
      connectionId: created.id,
      kind: 'shared',
      displayName: 'Team',
      secrets: { Authorization: 'secret' },
    })
    const personal = await local.addAccount({
      connectionId: created.id,
      kind: 'personal',
      ownerUserId: 'deleter',
      displayName: 'Mine',
      secrets: { Authorization: 'secret' },
    })
    await pool.query(
      `INSERT INTO audit_records (id, organization_id, principal_id, connection_id, account_id, tool_name, outcome)
       VALUES ('audit-doomed', 'org', 'deleter', $1, $2, 'read_issue', 'success')`,
      [created.id, shared.id],
    )
    await local.callAccountTool(created.id, shared.id, 'read_issue', {})
    closed = 0

    await local.delete(created.id)

    expect(closed).toBe(1)
    const rows = async (sql: string, values: Array<unknown> = []) =>
      (await pool.query(sql, values)).rowCount
    expect(
      await rows('SELECT 1 FROM mcp_connections WHERE id=$1', [created.id]),
    ).toBe(0)
    expect(
      await rows('SELECT 1 FROM mcp_accounts WHERE connection_id=$1', [
        created.id,
      ]),
    ).toBe(0)
    expect(
      await rows(
        'SELECT 1 FROM account_namespace_claims WHERE namespace = ANY($1)',
        [[shared.namespace, personal.namespace]],
      ),
    ).toBe(0)
    for (const table of [
      'connection_groups',
      'tool_policies',
      'connection_tools',
      'connection_health',
    ])
      expect(
        await rows(`SELECT 1 FROM ${table} WHERE connection_id=$1`, [
          created.id,
        ]),
      ).toBe(0)
    const audit = await pool.query(
      "SELECT connection_id, account_id, tool_name FROM audit_records WHERE id='audit-doomed'",
    )
    expect(audit.rows[0]).toEqual({
      connection_id: null,
      account_id: null,
      tool_name: 'read_issue',
    })
    await expect(local.delete(created.id)).rejects.toThrow(
      'Connection not found',
    )
    await expect(
      local.callAccountTool(created.id, shared.id, 'read_issue', {}),
    ).rejects.toThrow('Connection or Account not found')
  })

  test('reports credential names and keeps values left blank on replace', async () => {
    const connectionId = (
      await pool.query(
        "SELECT id FROM mcp_connections WHERE namespace='github'",
      )
    ).rows[0].id as string
    const account = await manager.addAccount({
      connectionId,
      kind: 'shared',
      displayName: 'Names',
      secrets: { API_KEY: 'first', REGION: 'eu' },
      variables: { BASE_URL: 'https://api.example.test', REGION: 'plain' },
    })
    try {
      expect(await manager.accountSecretNames(account.id)).toEqual([
        'API_KEY',
        'REGION',
      ])
      await manager.replaceAccountSecrets(
        account.id,
        { API_KEY: '', TOKEN: 'new' },
        { BASE_URL: 'https://api.example.test/v2' },
      )
      const row = (
        await pool.query(
          'SELECT secret_ciphertext, secret_nonce, secret_format_version, variables FROM mcp_accounts WHERE id=$1',
          [account.id],
        )
      ).rows[0]
      expect(
        await vault.open({
          ciphertext: new Uint8Array(row.secret_ciphertext),
          nonce: new Uint8Array(row.secret_nonce),
          version: row.secret_format_version as number,
        }),
      ).toEqual({ API_KEY: 'first', TOKEN: 'new' })
      expect(row.variables).toEqual({ BASE_URL: 'https://api.example.test/v2' })
    } finally {
      await pool.query('DELETE FROM mcp_accounts WHERE id=$1', [account.id])
    }
  })

  test('passes plain variables to the server beneath secrets', async () => {
    const environments: Array<Record<string, string>> = []
    const capturing = new ConnectionManager(pool, vault, (_config, secrets) => {
      environments.push(secrets)
      return Promise.resolve(fake)
    })
    const created = await capturing.create({
      organizationId: 'org',
      displayName: 'Variables',
      transport: { kind: 'streamable_http', url: 'https://mcp.example.test' },
      groupIds: ['group'],
      policies: [{ pattern: '*', effect: 'allow' }],
      state: 'enabled',
    })
    const account = await capturing.addAccount({
      connectionId: created.id,
      kind: 'shared',
      displayName: 'Team',
      secrets: { API_KEY: 'secret', SHARED: 'from-secret' },
      variables: { BASE_URL: 'https://api.example.test', SHARED: 'from-plain' },
    })
    try {
      await capturing.callAccountTool(created.id, account.id, 'read_issue', {})
      expect(environments.at(-1)).toEqual({
        BASE_URL: 'https://api.example.test',
        SHARED: 'from-secret',
        API_KEY: 'secret',
      })
    } finally {
      await capturing.close()
      await pool.query('DELETE FROM mcp_connections WHERE id=$1', [created.id])
    }
  })

  test('account creation reports namespace conflicts without exposing another account', async () => {
    const connectionId = (
      await pool.query(
        "SELECT id FROM mcp_connections WHERE namespace='github'",
      )
    ).rows[0].id as string
    await expect(
      manager.addAccount({ connectionId, kind: 'shared', displayName: 'Work' }),
    ).rejects.toThrow('choose a different account name')
    const shared = await manager.addAccount({
      connectionId,
      kind: 'shared',
      displayName: 'Team',
    })
    try {
      await expect(
        manager.addAccount({
          connectionId,
          kind: 'personal',
          ownerUserId: 'one',
          displayName: 'Team',
        }),
      ).rejects.toThrow('choose a different account name')
      expect(await manager.visibleAccounts(connectionId, 'one')).toHaveLength(2)
    } finally {
      await pool.query('DELETE FROM mcp_accounts WHERE id=$1', [shared.id])
    }
  })

  test('discovers with Shared Accounts before Personal Accounts', async () => {
    const attempts: Array<string | undefined> = []
    const authenticated = new ConnectionManager(
      pool,
      vault,
      (_config, secrets) => {
        const token = secrets.Authorization
        attempts.push(token)
        return Promise.resolve({
          listTools: () =>
            token
              ? Promise.resolve([
                  { name: `tool_${token}`, inputSchema: { type: 'object' } },
                ])
              : Promise.reject(new Error('authentication required')),
          callTool: () => Promise.resolve({}),
          close: () => Promise.resolve(),
        })
      },
    )
    const created = await authenticated.create({
      organizationId: 'org',
      displayName: 'Authenticated',
      transport: { kind: 'streamable_http', url: 'https://mcp.example.test' },
      groupIds: ['group'],
      policies: [{ pattern: '*', effect: 'allow' }],
      state: 'disabled',
    })
    expect(
      (
        await pool.query(
          'SELECT healthy FROM connection_health WHERE connection_id=$1',
          [created.id],
        )
      ).rows[0]?.healthy,
    ).toBe(false)
    await authenticated.addAccount({
      connectionId: created.id,
      kind: 'personal',
      ownerUserId: 'one',
      displayName: 'Mine',
      secrets: { Authorization: 'personal' },
    })
    await authenticated.addAccount({
      connectionId: created.id,
      kind: 'shared',
      displayName: 'Team',
      secrets: { Authorization: 'shared' },
    })
    attempts.length = 0
    await authenticated.refreshConnection(created.id, 'one')
    expect(attempts).toEqual(['shared'])
    expect(
      (
        await pool.query(
          'SELECT name FROM connection_tools WHERE connection_id=$1',
          [created.id],
        )
      ).rows,
    ).toEqual([{ name: 'tool_shared' }])
    await authenticated.close()
  })

  test('preserves the authenticated discovery error when anonymous fallback also fails', async () => {
    const authenticated = new ConnectionManager(
      pool,
      vault,
      (_config, secrets) =>
        Promise.reject(
          new Error(secrets.Authorization ? 'missing_scope' : 'missing_token'),
        ),
    )
    const created = await authenticated.create({
      organizationId: 'org',
      displayName: 'Discovery errors',
      transport: { kind: 'streamable_http', url: 'https://mcp.example.test' },
      groupIds: ['group'],
      policies: [],
      state: 'disabled',
    })
    await authenticated.addAccount({
      connectionId: created.id,
      kind: 'personal',
      ownerUserId: 'one',
      displayName: 'Mine',
      secrets: { Authorization: 'test-token' },
    })
    await expect(
      authenticated.refreshConnection(created.id, 'one'),
    ).rejects.toThrow('missing_scope')
    const health = await pool.query(
      'SELECT error FROM connection_health WHERE connection_id=$1',
      [created.id],
    )
    expect(health.rows[0].error).toBe('missing_scope')
    await authenticated.close()
  })

  test("never uses another user's Personal Account for discovery", async () => {
    const attempts: Array<string | undefined> = []
    const authenticated = new ConnectionManager(
      pool,
      vault,
      (_config, secrets) => {
        attempts.push(secrets.Authorization)
        return Promise.resolve({
          listTools: () =>
            secrets.Authorization
              ? Promise.resolve([{ name: 'private', inputSchema: {} }])
              : Promise.reject(new Error('authentication required')),
          callTool: () => Promise.resolve({}),
          close: () => Promise.resolve(),
        })
      },
    )
    const created = await authenticated.create({
      organizationId: 'org',
      displayName: 'Personal only',
      transport: { kind: 'streamable_http', url: 'https://mcp.example.test' },
      groupIds: ['group'],
      policies: [{ pattern: '*', effect: 'allow' }],
      state: 'disabled',
    })
    await authenticated.addAccount({
      connectionId: created.id,
      kind: 'personal',
      ownerUserId: 'one',
      displayName: 'Mine',
      secrets: { Authorization: 'personal' },
    })
    attempts.length = 0
    await expect(
      authenticated.refreshConnection(created.id, 'two'),
    ).rejects.toThrow('authentication required')
    expect(attempts).toEqual([undefined])
    attempts.length = 0
    await authenticated.refreshConnection(created.id, 'one')
    expect(attempts).toEqual(['personal'])
    await authenticated.close()
  })
})
