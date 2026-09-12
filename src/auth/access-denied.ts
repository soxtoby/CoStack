export type AccessDeniedReason = 'not-added' | 'email-unverified' | 'disabled'

export class SsoAccessDenied extends Error {
  constructor(readonly reason: AccessDeniedReason) {
    super(
      reason === 'email-unverified'
        ? 'SSO email must be verified'
        : 'Administrator access is required',
    )
  }
}
