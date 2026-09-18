import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { Pool } from 'pg'
import { migrate } from '../database/migrate'
import { ConnectionManager } from './manager'
import { UpstreamOAuth } from './oauth'
import { SecretVault } from './secrets'
import { upstreamOAuthHandler } from './oauth-handler'
import type { UpstreamClient } from './upstream'

const database = await PGlite.create()
const socket = new PGLiteSocketServer({
  db: database,
  host: '127.0.0.1',
  port: 0,
})
await socket.start()
const [, databasePort] = socket.getServerConn().split(':')
const pool = new Pool({
  host: '127.0.0.1',
  port: Number(databasePort),
  database: 'postgres',
  user: 'postgres',
  max: 1,
})
const vault = await SecretVault.fromBase64(
  crypto.getRandomValues(new Uint8Array(32)).toBase64(),
)
const fakeUpstream: UpstreamClient = {
  listTools: () => Promise.resolve([]),
  callTool: () => Promise.resolve({}),
  close: () => Promise.resolve(),
}
const manager = new ConnectionManager(pool, vault, () =>
  Promise.resolve(fakeUpstream),
)
let tokenRequest = new URLSearchParams()
let oauthBase = ''
let registrations = 0
const oauthServer: Bun.Server<undefined> = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname.includes('oauth-protected-resource')) {
      return Response.json({
        resource: `${oauthBase}mcp`,
        authorization_servers: [oauthBase],
      })
    }
    if (url.pathname.includes('oauth-authorization-server')) {
      return Response.json({
        issuer: oauthBase,
        authorization_endpoint: `${oauthBase}authorize`,
        token_endpoint: `${oauthBase}token`,
        registration_endpoint: `${oauthBase}register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
      })
    }
    if (url.pathname === '/register') {
      const metadata = await request.json()
      expect(metadata.token_endpoint_auth_method).toBe('none')
      expect(metadata.redirect_uris).toEqual([
        'http://gateway.test/api/upstream-oauth/callback',
      ])
      registrations++
      return Response.json({
        ...metadata,
        client_id: `dynamic-${registrations}`,
      })
    }
    if (url.pathname === '/token') {
      tokenRequest = new URLSearchParams(await request.text())
      if (tokenRequest.get('client_id')?.startsWith('dynamic-')) {
        expect(request.headers.has('authorization')).toBe(false)
      } else expect(request.headers.get('authorization')).toStartWith('Basic ')
      return Response.json({
        access_token: 'access',
        refresh_token: 'refresh',
        token_type: 'Bearer',
        expires_in: 3600,
      })
    }
    return new Response('not found', { status: 404 })
  },
})
oauthBase = oauthServer.url.toString()

beforeAll(async () => {
  await migrate(pool)
  await pool.query(
    "INSERT INTO organizations (id, display_name) VALUES ('org', 'Test')",
  )
  await pool.query(
    "INSERT INTO groups (id, organization_id, display_name) VALUES ('managers', 'org', 'Managers')",
  )
  await pool.query(
    "INSERT INTO group_capabilities (group_id, capability_name) VALUES ('managers', 'manage_accounts')",
  )
  for (const id of ['manager', 'user', 'other']) {
    await pool.query(
      "INSERT INTO principals (id, organization_id, kind, display_name) VALUES ($1,'org','user',$1)",
      [id],
    )
    await pool.query('INSERT INTO users (principal_id, email) VALUES ($1,$2)', [
      id,
      `${id}@test`,
    ])
  }
  await pool.query(
    "INSERT INTO group_memberships (group_id, principal_id) VALUES ('managers','manager')",
  )
})

afterAll(async () => {
  oauthServer.stop(true)
  await manager.close()
  await pool.end()
  await Bun.sleep(10)
  await socket.stop()
  await database.close()
})

describe('upstream OAuth', () => {
  test('returns safe application settings and preserves an unchanged secret', async () => {
    const connection = await manager.create({
      organizationId: 'org',
      displayName: 'Saved OAuth settings',
      transport: { kind: 'streamable_http', url: `${oauthBase}mcp` },
      groupIds: [],
      policies: [],
      state: 'disabled',
    })
    const oauth = new UpstreamOAuth(pool, vault, 'http://gateway.test')
    await oauth.configureConnection(connection.id, {
      clientId: 'saved-client',
      clientSecret: 'original-secret',
      scope: 'read',
    })
    await oauth.configureConnection(connection.id, {
      clientId: 'saved-client',
      clientSecret: '',
      scope: 'read write',
    })
    expect(await oauth.configuration(connection.id)).toEqual({
      clientId: 'saved-client',
      scope: 'read write',
      hasSecret: true,
    })
    const account = await manager.addAccount({
      connectionId: connection.id,
      kind: 'personal',
      ownerUserId: 'user',
      displayName: 'Saved settings',
    })
    expect(
      await (await oauth.provider(account.id)).clientInformation(),
    ).toEqual({ client_id: 'saved-client', client_secret: 'original-secret' })
    await expect(
      oauth.configureConnection(connection.id, {
        clientId: 'different-client',
        clientSecret: '',
      }),
    ).rejects.toThrow('Enter a new client secret')
    await oauth.configureConnection(connection.id, {
      clientId: 'saved-client',
      clientSecret: 'replacement-secret',
    })
    expect(
      await (await oauth.provider(account.id)).clientInformation(),
    ).toEqual({
      client_id: 'saved-client',
      client_secret: 'replacement-secret',
    })
    await oauth.configureConnection(connection.id, undefined)
    expect(await oauth.configuration(connection.id)).toBeUndefined()
  })

  test('registers automatically without a configured client and keeps registration scoped to the Account', async () => {
    const connection = await manager.create({
      organizationId: 'org',
      displayName: 'Automatic OAuth',
      transport: { kind: 'streamable_http', url: `${oauthBase}mcp` },
      groupIds: [],
      policies: [],
      state: 'disabled',
    })
    const account = await manager.addAccount({
      connectionId: connection.id,
      kind: 'personal',
      ownerUserId: 'user',
      displayName: 'Automatic',
    })
    const oauth = new UpstreamOAuth(pool, vault, 'http://gateway.test')
    const started = await oauth.start(account.id, 'user')
    const authorization = new URL(started.authorizationUrl)
    const clientId = authorization.searchParams.get('client_id')!
    expect(clientId).toStartWith('dynamic-')
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    const before = await (await oauth.provider(account.id)).tokens()
    expect(before).toBeUndefined()
    const callback = await upstreamOAuthHandler(
      new Request(
        `http://gateway.test/api/upstream-oauth/callback?state=${authorization.searchParams.get('state')}&code=test-code`,
      ),
      {
        startOAuth: (id, principal) => oauth.start(id, principal),
        finishOAuth: (state, code) => oauth.finish(state, code),
      },
    )
    expect(callback.status).toBe(303)
    expect(new URL(callback.headers.get('location')!).pathname).toBe(
      '/connections',
    )
    expect(
      new URL(callback.headers.get('location')!).searchParams.get('connection'),
    ).toBe(connection.id)
    expect(tokenRequest.get('client_id')).toBe(clientId)
    expect(tokenRequest.get('code_verifier')).toBeTruthy()
    const provider = await oauth.provider(account.id)
    expect((await provider.clientInformation())?.client_id).toBe(clientId)
    expect((await provider.tokens())?.access_token).toBe('access')
    const previousUrl = process.env.APPLICATION_URL
    process.env.APPLICATION_URL = 'http://gateway.test'
    let connections = 0
    const connectedManager = new ConnectionManager(
      pool,
      vault,
      async (_config, secrets, authProvider) => {
        expect(secrets).toEqual({})
        expect((await authProvider?.clientInformation())?.client_id).toBe(
          clientId,
        )
        expect((await authProvider?.tokens())?.access_token).toBe('access')
        connections++
        return fakeUpstream
      },
    )
    if (previousUrl === undefined) delete process.env.APPLICATION_URL
    else process.env.APPLICATION_URL = previousUrl
    try {
      await connectedManager.refreshConnection(connection.id, 'user')
      await connectedManager.setEnabled(connection.id, true)
      await connectedManager.callAccountTool(
        connection.id,
        account.id,
        'read_issue',
        {},
      )
      expect(connections).toBe(2)
    } finally {
      await connectedManager.close()
    }
    const other = await manager.addAccount({
      connectionId: connection.id,
      kind: 'personal',
      ownerUserId: 'other',
      displayName: 'Other',
    })
    expect(
      await (await oauth.provider(other.id)).clientInformation(),
    ).toBeUndefined()
    await expect(oauth.start(account.id, 'other')).rejects.toThrow(
      'another User',
    )
    await expect(
      oauth.finish(authorization.searchParams.get('state')!, 'test-code'),
    ).rejects.toThrow('invalid or expired')
    const encrypted = await pool.query(
      'SELECT secret_ciphertext FROM mcp_accounts WHERE id=$1',
      [account.id],
    )
    expect(
      new TextDecoder().decode(encrypted.rows[0].secret_ciphertext),
    ).not.toContain(clientId)
  })
  test('authorizes a Personal Account with discovery, state, PKCE, and encrypted tokens', async () => {
    const connection = await manager.create({
      organizationId: 'org',
      displayName: 'OAuth MCP',
      transport: { kind: 'streamable_http', url: `${oauthServer.url}mcp` },
      groupIds: [],
      policies: [],
      state: 'disabled',
    })
    const account = await manager.addAccount({
      connectionId: connection.id,
      kind: 'personal',
      ownerUserId: 'user',
      displayName: 'Mine',
    })
    const oauth = new UpstreamOAuth(pool, vault, 'http://gateway.test')
    await oauth.configureConnection(connection.id, {
      clientId: 'client',
      clientSecret: 'secret',
      scope: 'mcp',
    })
    await expect(oauth.start(account.id, 'other')).rejects.toThrow(
      'another User',
    )
    const started = await oauth.start(account.id, 'user')
    const authorization = new URL(started.authorizationUrl)
    expect(authorization.searchParams.get('code_challenge')).toBeTruthy()
    expect(authorization.searchParams.get('redirect_uri')).toBe(
      'http://gateway.test/api/upstream-oauth/callback',
    )
    await oauth.finish(authorization.searchParams.get('state')!, 'code')
    expect(tokenRequest.get('code_verifier')).toBeTruthy()
    const stored = await pool.query(
      'SELECT secret_ciphertext FROM mcp_accounts WHERE id=$1',
      [account.id],
    )
    expect(
      new TextDecoder().decode(stored.rows[0].secret_ciphertext),
    ).not.toContain('access')
    expect(await (await oauth.provider(account.id)).tokens()).toMatchObject({
      access_token: 'access',
      refresh_token: 'refresh',
    })
    await expect(
      oauth.finish(authorization.searchParams.get('state')!, 'code'),
    ).rejects.toThrow('invalid or expired')
  })

  test('only an Account manager may authorize a Shared Account', async () => {
    const connectionId = (
      await pool.query(
        "SELECT id FROM mcp_connections WHERE namespace='oauth_mcp'",
      )
    ).rows[0].id as string
    const account = await manager.addAccount({
      connectionId,
      kind: 'shared',
      displayName: 'Team',
    })
    const oauth = new UpstreamOAuth(pool, vault, 'http://gateway.test')
    await expect(oauth.start(account.id, 'user')).rejects.toThrow(
      'manage_accounts',
    )
    expect(
      (await oauth.start(account.id, 'manager')).authorizationUrl,
    ).toContain('/authorize?')
  })
})
