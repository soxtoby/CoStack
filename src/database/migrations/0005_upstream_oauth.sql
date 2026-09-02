ALTER TABLE mcp_connections
  ADD COLUMN oauth_client_ciphertext bytea,
  ADD COLUMN oauth_client_nonce bytea,
  ADD COLUMN oauth_client_format_version integer,
  ADD CONSTRAINT mcp_connections_oauth_client_complete CHECK (
    (oauth_client_ciphertext IS NULL AND oauth_client_nonce IS NULL AND oauth_client_format_version IS NULL) OR
    (oauth_client_ciphertext IS NOT NULL AND oauth_client_nonce IS NOT NULL AND oauth_client_format_version IS NOT NULL)
  );

CREATE TABLE upstream_oauth_flows (
  state text PRIMARY KEY,
  connection_id text NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES mcp_accounts(id) ON DELETE CASCADE,
  principal_id text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  secret_ciphertext bytea NOT NULL,
  secret_nonce bytea NOT NULL,
  secret_format_version integer NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
