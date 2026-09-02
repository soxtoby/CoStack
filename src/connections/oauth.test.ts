import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { Pool } from 'pg'
import { migrate } from '../database/migrate'
import { ConnectionManager } from './manager'
import { UpstreamOAuth } from './oauth'
import { SecretVault } from './secrets'
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
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      })
    }
    if (url.pathname === '/token') {
      tokenRequest = new URLSearchParams(await request.text())
      expect(request.headers.get('authorization')).toStartWith('Basic ')
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
