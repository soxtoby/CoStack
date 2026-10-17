ALTER TABLE mcp_accounts
  ADD COLUMN authorization_error text,
  ADD COLUMN authorization_failed_at timestamptz,
  ADD CONSTRAINT mcp_accounts_authorization_failure_complete CHECK (
    (authorization_error IS NULL) = (authorization_failed_at IS NULL)
  );
