CREATE TABLE connection_tools (
  connection_id text NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  input_schema jsonb NOT NULL,
  output_schema jsonb,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, name)
);

CREATE TABLE connection_health (
  connection_id text PRIMARY KEY REFERENCES mcp_connections(id) ON DELETE CASCADE,
  checked_at timestamptz NOT NULL DEFAULT now(),
  healthy boolean NOT NULL,
  error text
);
