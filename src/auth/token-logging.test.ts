import { describe, expect, test } from 'bun:test'
import { createLogger } from 'sonant'
import { logTokenFailures } from './token-logging'
import type { LogEvent } from 'sonant'

describe('logTokenFailures', () => {
  test('rejected refresh logs the grant, client and OAuth error', async () => {
    const { log, events } = recordingLogger()
    const rejection = {
      error: 'invalid_grant',
      error_description: 'invalid refresh token',
    }
    const request = tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-secret',
      client_id: 'claude',
    })

    const result = await logTokenFailures(
      request,
      respondWith(400, rejection),
      log,
    )

    expect(events.map(({ properties }) => properties)).toEqual([
      {
        GrantType: 'refresh_token',
        ClientId: 'claude',
        StatusCode: 400,
        Error: 'invalid_grant',
        ErrorDescription: 'invalid refresh token',
      },
    ])
    expect(await result.json()).toEqual(rejection)
  })

  test('rejected request with Basic client authentication logs the client id without the secret', async () => {
    const { log, events } = recordingLogger()
    const request = tokenRequest(
      { grant_type: 'refresh_token', refresh_token: 'refresh-secret' },
      { authorization: `Basic ${btoa('claude%3Aai:client-secret')}` },
    )

    await logTokenFailures(
      request,
      respondWith(401, { error: 'invalid_client' }),
      log,
    )

    expect(events.map(({ properties }) => properties.ClientId)).toEqual([
      'claude:ai',
    ])
  })

  test('rejection without an OAuth error logs the Better Auth code and message', async () => {
    const { log, events } = recordingLogger()
    const request = tokenRequest({ grant_type: 'refresh_token' })

    await logTokenFailures(
      request,
      respondWith(500, { code: 'FAILED', message: 'Database unavailable' }),
      log,
    )

    expect(
      events.map(({ properties }) => [
        properties.Error,
        properties.ErrorDescription,
      ]),
    ).toEqual([['FAILED', 'Database unavailable']])
  })

  test('successful request passes the body through and logs nothing', async () => {
    const { log, events } = recordingLogger()
    const request = tokenRequest({
      grant_type: 'authorization_code',
      code: 'code',
    })

    const result = await logTokenFailures(
      request,
      async (received) => new Response(await received.text()),
      log,
    )

    expect(await result.text()).toBe('grant_type=authorization_code&code=code')
    expect(events).toEqual([])
  })
})

function recordingLogger() {
  const events: Array<LogEvent> = []
  const log = createLogger({
    sinks: [{ emit: (event) => void events.push(event), flush: () => {} }],
  })
  return { log, events }
}

function tokenRequest(
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return new Request('https://costack.test/api/auth/oauth2/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: new URLSearchParams(fields),
  })
}

/** Reads the request body first, as Better Auth does. */
function respondWith(status: number, body: object) {
  return async (request: Request) => {
    await request.text()
    return Response.json(body, { status })
  }
}
