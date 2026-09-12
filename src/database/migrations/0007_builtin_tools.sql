ALTER TABLE gateway_settings
  ADD COLUMN tool_policies jsonb NOT NULL DEFAULT '[{"pattern":"*","effect":"allow"}]',
  ADD COLUMN tool_policy_revision integer NOT NULL DEFAULT 1;
