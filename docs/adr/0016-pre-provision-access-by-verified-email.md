# Pre-provision access by verified email

Administrators may prepare Group memberships for an email address before first sign-in without sending an invitation link. After Better Auth validates the configured SSO Provider and a verified matching email, the gateway atomically binds the record to the immutable issuer and subject; unverified email is rejected with no manual review flow. This keeps onboarding small while accepting email as a one-time identity bootstrap within one trusted provider.

The provider's “Require verified email” setting defaults to enabled, including for existing providers. An SSO administrator may explicitly disable it when trusting the configured provider's reported email. Matching active Pre-provisioned Access remains required; the email is not relabelled verified, and subsequent access remains bound to issuer and subject. No approval queue or email delivery is required.
