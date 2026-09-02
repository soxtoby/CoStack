CREATE TABLE gateway_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  bootstrap_completed_at timestamptz,
  recovery_user_id text REFERENCES "user"(id),
  audit_retention_days integer NOT NULL DEFAULT 90 CHECK (audit_retention_days IN (30, 90, 180, 365))
);

INSERT INTO gateway_settings (singleton) VALUES (true);

ALTER TABLE service_accounts
  ADD COLUMN oauth_client_id text UNIQUE REFERENCES "oauthClient"("clientId") ON DELETE SET NULL;

CREATE UNIQUE INDEX sso_provider_single_active ON "ssoProvider" ((true));
