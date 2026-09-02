CREATE TABLE organizations (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE principal_kind AS ENUM ('user', 'service_account');
CREATE TYPE approval_method AS ENUM ('gateway_enforced', 'client_managed');

CREATE TABLE principals (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  kind principal_kind NOT NULL,
  display_name text NOT NULL,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);

CREATE TABLE users (
  principal_id text PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  oidc_issuer text,
  oidc_subject text,
  email text NOT NULL,
  approval_method approval_method NOT NULL DEFAULT 'gateway_enforced',
  UNIQUE (oidc_issuer, oidc_subject)
);

CREATE TABLE service_accounts (
  principal_id text PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE
);

CREATE TABLE groups (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  display_name text NOT NULL,
  is_administrators boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, display_name)
);

CREATE UNIQUE INDEX groups_one_administrators_group
  ON groups (organization_id)
  WHERE is_administrators;

CREATE TABLE group_memberships (
  group_id text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  principal_id text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, principal_id)
);

CREATE TABLE capabilities (
  name text PRIMARY KEY
);

CREATE TABLE group_capabilities (
  group_id text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  capability_name text NOT NULL REFERENCES capabilities(name) ON DELETE CASCADE,
  PRIMARY KEY (group_id, capability_name)
);

CREATE TABLE pre_provisioned_access (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  normalized_email text NOT NULL,
  expires_at timestamptz NOT NULL,
  claimed_by_user_id text REFERENCES users(principal_id),
  claimed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, normalized_email),
  CHECK ((claimed_by_user_id IS NULL) = (claimed_at IS NULL))
);

CREATE TABLE pre_provisioned_access_groups (
  access_id text NOT NULL REFERENCES pre_provisioned_access(id) ON DELETE CASCADE,
  group_id text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (access_id, group_id)
);

CREATE TYPE connection_transport AS ENUM ('stdio', 'streamable_http');
CREATE TYPE connection_state AS ENUM ('enabled', 'disabled');

CREATE TABLE registry_sources (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  display_name text NOT NULL,
  base_url text NOT NULL,
  is_official boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, display_name),
  UNIQUE (organization_id, base_url)
);

CREATE TABLE mcp_connections (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  display_name text NOT NULL,
  namespace text NOT NULL,
  transport connection_transport NOT NULL,
  transport_config jsonb NOT NULL,
  state connection_state NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  registry_source_id text REFERENCES registry_sources(id),
  registry_server_id text,
  registry_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, namespace)
);

CREATE TABLE connection_groups (
  connection_id text NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  group_id text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (connection_id, group_id)
);

CREATE TYPE tool_policy_effect AS ENUM ('allow', 'require_approval', 'block');

CREATE TABLE tool_policies (
  id text PRIMARY KEY,
  connection_id text NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  pattern text NOT NULL,
  effect tool_policy_effect NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, pattern)
);

CREATE TYPE account_kind AS ENUM ('shared', 'personal');

CREATE TABLE mcp_accounts (
  id text PRIMARY KEY,
  connection_id text NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  kind account_kind NOT NULL,
  owner_user_id text REFERENCES users(principal_id) ON DELETE CASCADE,
  display_name text NOT NULL,
  namespace text NOT NULL,
  secret_ciphertext bytea,
  secret_nonce bytea,
  secret_format_version integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'shared' AND owner_user_id IS NULL) OR
    (kind = 'personal' AND owner_user_id IS NOT NULL)
  ),
  CHECK (
    (secret_ciphertext IS NULL AND secret_nonce IS NULL AND secret_format_version IS NULL) OR
    (secret_ciphertext IS NOT NULL AND secret_nonce IS NOT NULL AND secret_format_version IS NOT NULL)
  )
);

CREATE UNIQUE INDEX mcp_accounts_shared_namespace
  ON mcp_accounts (namespace)
  WHERE kind = 'shared';

CREATE UNIQUE INDEX mcp_accounts_personal_namespace
  ON mcp_accounts (owner_user_id, namespace)
  WHERE kind = 'personal';

CREATE TABLE audit_records (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  principal_id text REFERENCES principals(id) ON DELETE SET NULL,
  principal_display_name text,
  mcp_client_id text,
  connection_id text REFERENCES mcp_connections(id) ON DELETE SET NULL,
  account_id text REFERENCES mcp_accounts(id) ON DELETE SET NULL,
  tool_name text,
  policy_effect tool_policy_effect,
  outcome text NOT NULL,
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  error_code text
);

CREATE INDEX audit_records_organization_occurred_at
  ON audit_records (organization_id, occurred_at DESC);

INSERT INTO capabilities (name) VALUES
  ('manage_connections'),
  ('manage_accounts'),
  ('manage_principals_groups'),
  ('manage_sso'),
  ('view_audit');
