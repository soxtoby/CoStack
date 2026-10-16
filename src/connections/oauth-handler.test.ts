import { expect, test } from 'bun:test'
import { upstreamOAuthHandler } from './oauth-handler'

const rejections: Array<Record<string, string>> = [
  {
    error: 'access_denied',
    error_description: 'AADSTS65004: Consent was declined.',
    state: 'authorization-state',
  },
  { error: 'unauthorized_client' },
]

test.each(rejections)(
  'reports an OAuth rejection: $error',
  async (parameters) => {
    const url = new URL('https://gateway.test/api/upstream-oauth/callback')
    url.search = new URLSearchParams(parameters).toString()
    const response = await upstreamOAuthHandler(new Request(url), {
      startOAuth: unexpectedAuthorization,
      finishOAuth: unexpectedAuthorization,
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: parameters.error,
      ...(parameters.error_description
        ? { error_description: parameters.error_description }
        : {}),
    })
  },
)

function unexpectedAuthorization(): never {
  throw new Error('An OAuth rejection must not complete authorization')
}
