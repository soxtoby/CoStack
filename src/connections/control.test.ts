import { describe, expect, test } from 'bun:test'
import {
  controlActionAccess,
  mayPerformControlAction,
} from './control-authorization'
import type { Capability, PrincipalAuthorization } from '../auth/authorization'

function principal(
  capabilities: Array<Capability> = [],
  administrator = false,
): PrincipalAuthorization {
  return {
    id: 'principal-1',
    disabled: false,
    administrator,
    capabilities: new Set(capabilities),
  }
}

describe('/api/control action authorization', () => {
  test('restricts registry browsing and import to connection managers', () => {
    for (const action of [
      'browse-registry',
      'import-registry',
      'set-tool-policies',
    ]) {
      expect(mayPerformControlAction(principal(), action)).toBe(false)
      expect(
        mayPerformControlAction(principal(['manage_accounts']), action),
      ).toBe(false)
      expect(
        mayPerformControlAction(principal(['manage_connections']), action),
      ).toBe(true)
    }
  })
  test('reserves audit retention changes for Administrators', () => {
    expect(controlActionAccess('set-audit-retention')).toBe('administrator')
    expect(
      mayPerformControlAction(principal(['view_audit']), 'set-audit-retention'),
    ).toBe(false)
    expect(
      mayPerformControlAction(principal([], true), 'set-audit-retention'),
    ).toBe(true)
  })

  test('keeps connection and account capabilities separate', () => {
    const connectionManager = principal(['manage_connections'])
    const accountManager = principal(['manage_accounts'])

    expect(
      mayPerformControlAction(connectionManager, 'create-connection'),
    ).toBe(true)
    expect(
      mayPerformControlAction(connectionManager, 'create-shared-account'),
    ).toBe(false)
    expect(
      mayPerformControlAction(accountManager, 'create-shared-account'),
    ).toBe(true)
    expect(mayPerformControlAction(accountManager, 'create-connection')).toBe(
      false,
    )
  })

  test('rejects every action for a disabled Principal', () => {
    const disabled = {
      ...principal(['manage_connections', 'manage_accounts'], true),
      disabled: true,
    }
    expect(mayPerformControlAction(disabled, 'create-connection')).toBe(false)
    expect(mayPerformControlAction(disabled, 'set-approval-method')).toBe(false)
  })

  test('leaves self-service actions outside administrative capabilities', () => {
    expect(controlActionAccess('set-approval-method')).toBeUndefined()
    expect(controlActionAccess('create-personal-account')).toBeUndefined()
  })
})
