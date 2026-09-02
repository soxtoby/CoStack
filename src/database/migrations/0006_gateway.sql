CREATE TABLE approval_requests (
  id text PRIMARY KEY,
  principal_id text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  account_id text REFERENCES mcp_accounts(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  arguments_hash text NOT NULL,
  policy_effect tool_policy_effect NOT NULL CHECK (policy_effect = 'require_approval'),
  nonce text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX approval_requests_expiry ON approval_requests (expires_at);

