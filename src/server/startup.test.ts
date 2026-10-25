import { describe, expect, test } from 'bun:test'
import { afterStartup } from './startup'

describe('afterStartup', () => {
  test('health answers during startup while other requests wait for it', async () => {
    const { promise: startup, resolve } = Promise.withResolvers<void>()
    const handle = afterStartup(startup, () => new Response('handled'))

    const health = await handle(new Request('https://costack.test/health'))
    let handled = false
    const pending = handle(new Request('https://costack.test/mcp')).then(
      (response) => {
        handled = true
        return response
      },
    )
    await Bun.sleep(0)

    expect(health.status).toBe(200)
    expect(handled).toBe(false)
    resolve()
    expect(await (await pending).text()).toBe('handled')
  })
})
