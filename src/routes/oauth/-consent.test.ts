import { expect, test } from 'bun:test'
import { loadOAuthClientName } from './consent'

test('loads the registered OAuth client name for consent', async () => {
  let requested = ''
  const name = await loadOAuthClientName('codex/client', (input) => {
    requested = String(input)
    return Promise.resolve(Response.json({ client_name: 'Codex' }))
  })

  expect(requested).toBe(
    '/api/auth/oauth2/public-client?client_id=codex%2Fclient',
  )
  expect(name).toBe('Codex')
})

test('uses the generic label when client metadata is unavailable', async () => {
  expect(
    await loadOAuthClientName('missing', () =>
      Promise.resolve(new Response(null, { status: 404 })),
    ),
  ).toBeUndefined()
})
