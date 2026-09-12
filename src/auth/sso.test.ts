import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { betterAuth } from 'better-auth'
import { sso } from '@better-auth/sso'
import { Pool } from 'pg'
import { migrate } from '../database/migrate'
import { SsoConfiguration } from './sso'
import { ssoProvisioning } from './sso-provisioning'
import { grantAccess } from './access'

const database = await PGlite.create()
const socket = new PGLiteSocketServer({
  db: database,
  host: '127.0.0.1',
  port: 0,
})
await socket.start()
const pool = new Pool({
  host: '127.0.0.1',
  port: Number(socket.getServerConn().split(':')[1]),
  database: 'postgres',
  user: 'postgres',
  max: 1,
})
const applicationUrl = 'http://gateway.test'
const issuer = 'https://login.idp.test/organization/v2.0'
const metadata = (value: string) => ({
  issuer: value,
  authorization_endpoint: `${value}/authorize`,
  token_endpoint: `${value}/token`,
  jwks_uri: `${value}/keys`,
  userinfo_endpoint: 'https://profile.idp.test/oidc/userinfo',
  token_endpoint_auth_methods_supported: ['client_secret_post'],
})
let document: Record<string, unknown> = metadata(issuer)
let privateDns = false
let privateProfileDns = false
const configuration = new SsoConfiguration(pool, applicationUrl, (hostname) =>
  Promise.resolve([
    { address: '8.8.8.8' },
    {
      address:
        privateDns || (privateProfileDns && hostname === 'profile.idp.test')
          ? '10.0.0.1'
          : '8.8.4.4',
    },
  ]),
)
const auth = betterAuth({
  baseURL: applicationUrl,
  secret: 'test-only-secret-that-is-at-least-thirty-two-characters',
  database: pool,
  emailAndPassword: { enabled: true },
  trustedOrigins: configuration.trustedOrigins,
  plugins: [sso(ssoProvisioning(pool, applicationUrl))],
})
let cookie = ''
const realFetch = globalThis.fetch
let discoveryRequests = 0
let ssoEmailVerified = false
let ssoEmail = 'sso-person@example.test'
let ssoSubject = 'sso-subject'
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
  Object.assign(
    (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      if (url.includes('.idp.test/')) {
        if (url.endsWith('/token'))
          return Promise.resolve(
            Response.json({
              access_token: 'test-access-token',
              token_type: 'Bearer',
            }),
          )
        if (url.endsWith('/userinfo'))
          return Promise.resolve(
            Response.json({
              sub: ssoSubject,
              email: ssoEmail,
              name: 'SSO Person',
              email_verified: ssoEmailVerified,
            }),
          )
        discoveryRequests++
        return Promise.resolve(Response.json(document))
      }
      return realFetch(input, init)
    },
    { preconnect: realFetch.preconnect },
  ),
)

function request(origin = applicationUrl, session = cookie) {
  return new Request(`${applicationUrl}/api/admin`, {
    method: 'POST',
    headers: { origin, cookie: session, 'content-type': 'application/json' },
  })
}

function save(value = issuer) {
  return configuration.save(
    request(),
    {
      issuer: value,
      clientId: 'test-client',
      clientSecret: 'test-secret',
    },
    auth,
  )
}

beforeAll(async () => {
  await migrate(pool)
  const response = await auth.handler(
    new Request(`${applicationUrl}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin: applicationUrl, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Admin',
        email: 'admin@example.test',
        password: 'test-password',
      }),
    }),
  )
  expect(response.status).toBe(200)
  cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  const { user } = await response.json()
  await pool.query(
    "INSERT INTO organizations(id,display_name) VALUES('org','Test')",
  )
  await pool.query(
    "INSERT INTO principals(id,organization_id,kind,display_name) VALUES($1,'org','user','Admin')",
    [user.id],
  )
  await pool.query(
    "INSERT INTO groups(id,organization_id,display_name,is_administrators) VALUES('admins','org','Administrators',true)",
  )
  await pool.query(
    "INSERT INTO group_memberships(group_id,principal_id) VALUES('admins',$1)",
    [user.id],
  )
})

afterAll(async () => {
  fetchSpy.mockRestore()
  await pool.end()
  await Bun.sleep(10)
  await socket.stop()
  await database.close()
})

test('registers an arbitrary issuer and its advertised cross-origin endpoint', async () => {
  const response = await save()
  expect(await response.text()).not.toContain('error')
  expect(response.status).toBe(200)
  const { rows } = await pool.query(
    'SELECT issuer,"oidcConfig" FROM "ssoProvider"',
  )
  expect(rows[0].issuer).toBe(issuer)
  expect(
    (await pool.query('SELECT "requireVerifiedEmail" FROM "ssoProvider"'))
      .rows[0].requireVerifiedEmail,
  ).toBe(true)
  expect(JSON.parse(rows[0].oidcConfig).userInfoEndpoint).toBe(
    'https://profile.idp.test/oidc/userinfo',
  )
})

test('a fresh instance derives sign-in and callback trust from persisted configuration', async () => {
  const fresh = new SsoConfiguration(pool, applicationUrl, () =>
    Promise.resolve([{ address: '8.8.8.8' }]),
  )
  for (const path of [
    '/api/auth/sign-in/sso',
    '/api/auth/sso/callback/organization',
  ]) {
    expect(
      await fresh.trustedOrigins(new Request(`${applicationUrl}${path}`)),
    ).toEqual(['https://login.idp.test', 'https://profile.idp.test'])
  }
  expect(await fresh.trustedOrigins()).toEqual([])
  for (const path of [
    '/api/auth/sign-in/email',
    '/api/auth/sso/register',
    '/api/auth/sso/update-provider',
  ]) {
    expect(
      await fresh.trustedOrigins(new Request(`${applicationUrl}${path}`)),
    ).toEqual([])
  }
  const response = await auth.handler(
    new Request(`${applicationUrl}/api/auth/sign-in/sso`, {
      method: 'POST',
      headers: request().headers,
      body: JSON.stringify({
        providerId: 'organization',
        callbackURL: `${applicationUrl}/`,
      }),
    }),
  )
  expect(response.status).toBe(200)
  const authorizationUrl = new URL((await response.json()).url)
  expect(authorizationUrl.href).toStartWith(`${issuer}/authorize?`)
  expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(
    configuration.redirectUri(),
  )
})

test('blank secret on update keeps the saved secret', async () => {
  const response = await configuration.save(
    request(),
    { issuer, clientId: 'test-client', clientSecret: '' },
    auth,
  )
  expect(response.status).toBe(200)
  const config = JSON.parse(
    (await pool.query('SELECT "oidcConfig" FROM "ssoProvider"')).rows[0]
      .oidcConfig,
  )
  expect(config.clientSecret).toBe('test-secret')
})

test('rejects unauthorized or cross-origin saves before discovery', async () => {
  const count = discoveryRequests
  for (const [req, status] of [
    [request(applicationUrl, ''), 401],
    [request('https://login.idp.test'), 403],
  ] as const) {
    try {
      await configuration.save(req, { issuer }, auth)
      throw new Error('Save unexpectedly succeeded')
    } catch (error) {
      expect(error).toBeInstanceOf(Response)
      expect((error as Response).status).toBe(status)
    }
  }
  await pool.query(
    "UPDATE groups SET is_administrators=false WHERE id='admins'",
  )
  try {
    await expect(save()).rejects.toMatchObject({ status: 403 })
  } finally {
    await pool.query(
      "UPDATE groups SET is_administrators=true WHERE id='admins'",
    )
  }
  expect(discoveryRequests).toBe(count)
})

test('rejects unsafe issuer URLs before fetching', async () => {
  const count = discoveryRequests
  for (const value of [
    'http://login.idp.test',
    'https://127.0.0.1',
    'https://[::1]',
    'https://[::ffff:127.0.0.1]',
    'https://169.254.169.254',
    'https://10.0.0.1',
    'https://localhost',
    'https://user:secret@login.idp.test',
    `${issuer}?query=1`,
  ]) {
    await expect(save(value)).rejects.toThrow()
  }
  privateDns = true
  try {
    await expect(save()).rejects.toThrow('must resolve to public addresses')
  } finally {
    privateDns = false
  }
  expect(discoveryRequests).toBe(count)
})

test('rejects mismatched or unsafe discovery on update without changing the provider', async () => {
  document = metadata('https://other.idp.test')
  await expect(save()).rejects.toThrow('does not match')
  document = {
    ...metadata(issuer),
    userinfo_endpoint: 'https://169.254.169.254/userinfo',
  }
  await expect(save()).rejects.toThrow('public HTTPS')
  document = metadata(issuer)
  expect(
    (await pool.query('SELECT issuer FROM "ssoProvider"')).rows[0].issuer,
  ).toBe(issuer)
})

test('rejects private DNS behind advertised or persisted endpoint hosts', async () => {
  privateProfileDns = true
  try {
    await expect(save()).rejects.toThrow('must resolve to public addresses')
    await expect(
      configuration.trustedOrigins(
        new Request(`${applicationUrl}/api/auth/sso/callback/organization`),
      ),
    ).rejects.toThrow('must resolve to public addresses')
  } finally {
    privateProfileDns = false
  }
})

test('temporary save trust cannot be reused and is removed after failure', async () => {
  let internalRequest: Request | undefined
  await expect(
    configuration.save(
      request(),
      { issuer, clientId: 'test', clientSecret: 'test' },
      {
        api: auth.api,
        handler: async (upstream) => {
          internalRequest = upstream
          expect(await configuration.trustedOrigins(upstream)).toContain(
            'https://login.idp.test',
          )
          expect(await configuration.trustedOrigins(upstream.clone())).toEqual(
            [],
          )
          throw new Error('Simulated save failure')
        },
      },
    ),
  ).rejects.toThrow('Simulated save failure')
  expect(internalRequest).toBeDefined()
  expect(await configuration.trustedOrigins(internalRequest)).toEqual([])
})

test('updating issuer replaces old endpoints and trust', async () => {
  const replacement = 'https://replacement.idp.test'
  document = metadata(replacement)
  document.userinfo_endpoint = `${replacement}/userinfo`
  const response = await save(replacement)
  expect(response.status).toBe(200)
  const config = JSON.parse(
    (await pool.query('SELECT "oidcConfig" FROM "ssoProvider"')).rows[0]
      .oidcConfig,
  )
  expect(config.discoveryEndpoint).toBe(
    `${replacement}/.well-known/openid-configuration`,
  )
  expect(config.tokenEndpoint).toBe(`${replacement}/token`)
  expect(config.userInfoEndpoint).toBe(`${replacement}/userinfo`)
  expect(
    await configuration.trustedOrigins(
      new Request(`${applicationUrl}/api/auth/sign-in/sso`),
    ),
  ).toEqual([replacement])
})

test('fails explicitly when the update API cannot clear a removed endpoint', async () => {
  delete document.userinfo_endpoint
  await expect(save('https://replacement.idp.test')).rejects.toThrow(
    'no user-info endpoint',
  )
})

test('sign-out returns an HTTP response that clears cookies and revokes the session', async () => {
  expect(
    await auth.api.getSession({ headers: request().headers }),
  ).not.toBeNull()
  const response = await auth.api.signOut({
    headers: request().headers,
    asResponse: true,
  })
  expect(response).toBeInstanceOf(Response)
  expect(response.status).toBe(200)
  expect(
    response.headers
      .getSetCookie()
      .some(
        (value) =>
          value.includes('session_token=;') && value.includes('Max-Age=0'),
      ),
  ).toBe(true)
  expect(await auth.api.getSession({ headers: request().headers })).toBeNull()
})

async function ssoCallback() {
  const start = await auth.handler(
    new Request(`${applicationUrl}/api/auth/sign-in/sso`, {
      method: 'POST',
      headers: { origin: applicationUrl, 'content-type': 'application/json' },
      body: JSON.stringify({
        providerId: 'organization',
        callbackURL: `${applicationUrl}/connections`,
      }),
    }),
  )
  expect(start.status).toBe(200)
  const state = new URL((await start.json()).url).searchParams.get('state')!
  const callbackCookie = start.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  return auth.handler(
    new Request(
      `${configuration.redirectUri()}?code=test-code&state=${encodeURIComponent(state)}`,
      {
        headers: { cookie: callbackCookie },
      },
    ),
  )
}

test('unverified SSO email redirects to an explanation instead of a 500, including retries', async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await ssoCallback()
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      `${applicationUrl}/access-denied?reason=email-unverified&email=${encodeURIComponent(ssoEmail)}`,
    )
  }
  expect(
    (
      await pool.query(
        "SELECT principal_id FROM users WHERE email='sso-person@example.test'",
      )
    ).rows,
  ).toEqual([])
})

test('verified SSO email without prepared access redirects to the administrator message', async () => {
  ssoEmailVerified = true
  const response = await ssoCallback()
  expect(response.status).toBe(302)
  expect(response.headers.get('location')).toBe(
    `${applicationUrl}/access-denied?reason=not-added&email=${encodeURIComponent(ssoEmail)}`,
  )
  expect(
    (
      await pool.query(
        "SELECT principal_id FROM users WHERE email='sso-person@example.test'",
      )
    ).rows,
  ).toEqual([])
})

test('a previously rejected SSO user can retry after an administrator adds access', async () => {
  await grantAccess(pool, 'org', 'sso-person@example.test', [])
  const response = await ssoCallback()
  expect(response.status).toBe(302)
  expect(response.headers.get('location')).toBe(`${applicationUrl}/connections`)
  const user = (
    await pool.query(
      "SELECT oidc_subject FROM users WHERE email='sso-person@example.test'",
    )
  ).rows[0]
  expect(user.oidc_subject).toBe('sso-subject')
  expect(
    response.headers
      .getSetCookie()
      .some((value) => value.includes('session_token=')),
  ).toBe(true)
})

test('explicitly disabling verification admits only matching prepared email and can be re-enabled', async () => {
  const login = await auth.api.signInEmail({
    body: { email: 'admin@example.test', password: 'test-password' },
    asResponse: true,
  })
  cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  const replacement = 'https://replacement.idp.test'
  document = metadata(replacement)
  document.userinfo_endpoint = `${replacement}/userinfo`
  const update = (requireVerifiedEmail: boolean) =>
    configuration.save(
      request(),
      {
        issuer: replacement,
        clientId: 'test-client',
        requireVerifiedEmail,
      },
      auth,
    )
  expect((await update(false)).status).toBe(200)
  expect((await save(replacement)).status).toBe(200)
  expect(
    (await pool.query('SELECT "requireVerifiedEmail" FROM "ssoProvider"'))
      .rows[0].requireVerifiedEmail,
  ).toBe(false)
  ssoEmailVerified = false
  ssoEmail = 'unverified-person@example.test'
  ssoSubject = 'unverified-subject'
  expect((await ssoCallback()).headers.get('location')).toBe(
    `${applicationUrl}/access-denied?reason=not-added&email=${encodeURIComponent(ssoEmail)}`,
  )
  await grantAccess(pool, 'org', ssoEmail, [])
  const admitted = await ssoCallback()
  expect(admitted.headers.get('location')).toBe(`${applicationUrl}/connections`)
  expect(
    (
      await pool.query('SELECT "emailVerified" FROM "user" WHERE email=$1', [
        ssoEmail,
      ])
    ).rows[0].emailVerified,
  ).toBe(false)
  expect((await update(true)).status).toBe(200)
  expect((await ssoCallback()).headers.get('location')).toBe(
    `${applicationUrl}/access-denied?reason=email-unverified&email=${encodeURIComponent(ssoEmail)}`,
  )
})
