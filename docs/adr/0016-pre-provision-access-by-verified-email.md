# Pre-provision access by verified email

Administrators may prepare Group memberships for an email address before first sign-in without sending an invitation link. After Better Auth validates the configured SSO Provider and a verified matching email, the gateway atomically binds the record to the immutable issuer and subject; unverified email is rejected with no manual review flow. This keeps onboarding small while accepting email as a one-time identity bootstrap within one trusted provider.
