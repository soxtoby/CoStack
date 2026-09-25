import { may } from '../auth/authorization'
import type { Capability, PrincipalAuthorization } from '../auth/authorization'

export type ControlAccess = Capability | 'administrator'

export function controlActionAccess(action: string): ControlAccess | undefined {
  if (
    [
      'create-connection',
      'edit-connection',
      'set-tool-policies',
      'clone-connection',
      'set-enabled',
      'delete-connection',
      'refresh-connection',
      'create-registry-source',
      'import-registry',
      'browse-registry',
    ].includes(action)
  )
    return 'manage_connections'
  if (
    [
      'create-shared-account',
      'replace-shared-secret',
      'delete-shared-secret',
      'delete-shared-account',
      'configure-upstream-oauth',
    ].includes(action)
  )
    return 'manage_accounts'
  if (action === 'set-audit-retention') return 'administrator'
  return undefined
}

export function mayPerformControlAction(
  authorization: PrincipalAuthorization | undefined,
  action: string,
) {
  if (!authorization || authorization.disabled) return false
  const access = controlActionAccess(action)
  if (!access) return true
  return access === 'administrator'
    ? authorization.administrator
    : may(authorization, access)
}
