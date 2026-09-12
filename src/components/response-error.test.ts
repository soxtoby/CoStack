import { expect, test } from 'bun:test'
import { responseError } from './response-error'

test('shows Better Auth messages and application errors', async () => {
  for (const body of [
    { code: 'issuer_mismatch', message: 'OIDC issuer mismatch' },
    { error: 'Issuer URL is required' },
  ]) {
    const error = await responseError(Response.json(body, { status: 400 }))
    expect(error.message).toBe('message' in body ? body.message : body.error)
  }
})

test('shows plain errors and gives a status for opaque responses', async () => {
  expect(
    (
      await responseError(
        new Response('Forbidden', {
          status: 403,
          headers: { 'content-type': 'text/plain' },
        }),
      )
    ).message,
  ).toBe('Forbidden')
  expect(
    (
      await responseError(
        new Response('<html>proxy error</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
      )
    ).message,
  ).toBe('Request failed (HTTP 502)')
})
