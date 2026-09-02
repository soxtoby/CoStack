import { describe, expect, test } from 'bun:test'
import { assertAdministratorChange, may } from './authorization'
import type { PrincipalAuthorization } from './authorization'

function principal(
  input: Partial<PrincipalAuthorization> = {},
): PrincipalAuthorization {
  return {
    id: 'user-1',
    disabled: false,
    administrator: false,
    capabilities: new Set(),
    ...input,
  }
}

describe('authorization', () => {
  test('grants an assigned capability', () => {
    expect(
      may(
        principal({ capabilities: new Set(['manage_connections']) }),
        'manage_connections',
      ),
    ).toBe(true)
  })

  test('administrators have every capability', () => {
    expect(may(principal({ administrator: true }), 'manage_sso')).toBe(true)
  })

  test('disabled principals have no capabilities', () => {
    expect(
      may(
        principal({
          disabled: true,
          administrator: true,
          capabilities: new Set(['manage_sso']),
        }),
        'manage_sso',
      ),
    ).toBe(false)
  })

  test('protects the final active Administrator', () => {
    expect(() => assertAdministratorChange(1, true)).toThrow('final active')
    expect(() => assertAdministratorChange(2, true)).not.toThrow()
  })
})
