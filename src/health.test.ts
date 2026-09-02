import { describe, expect, test } from 'bun:test'
import { healthResponse } from './server/health'

describe('health contract', () => {
  test('returns the stable response shape', async () => {
    const response = healthResponse()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
  })
})
