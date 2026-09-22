ALTER TABLE mcp_accounts
  ADD COLUMN variables jsonb NOT NULL DEFAULT '{}'::jsonb;
