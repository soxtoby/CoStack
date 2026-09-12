-- Shared namespaces must never overlap any user's Personal namespace.
-- A single claim row serializes concurrent writers without snapshot-dependent
-- cross-account checks. Existing per-owner and Shared unique indexes remain.
LOCK TABLE mcp_accounts IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT namespace FROM mcp_accounts
    GROUP BY namespace HAVING count(DISTINCT kind) > 1
  ) THEN
    RAISE EXCEPTION 'Shared and Personal account namespaces conflict; resolve conflicting accounts before applying this migration'
      USING ERRCODE = '23505', CONSTRAINT = 'mcp_accounts_namespace_scope';
  END IF;
END;
$$;

CREATE TABLE account_namespace_claims (
  namespace text PRIMARY KEY,
  kind account_kind NOT NULL,
  account_count integer NOT NULL CHECK (account_count > 0)
);

INSERT INTO account_namespace_claims(namespace, kind, account_count)
SELECT namespace, kind, count(*) FROM mcp_accounts GROUP BY namespace, kind;

CREATE FUNCTION maintain_account_namespace_claim() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  claimed text;
  remaining integer;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.namespace = OLD.namespace AND NEW.kind = OLD.kind THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.namespace = OLD.namespace THEN
    UPDATE account_namespace_claims SET kind = NEW.kind
    WHERE namespace = NEW.namespace AND account_count = 1
    RETURNING namespace INTO claimed;
    IF claimed IS NULL THEN
      RAISE EXCEPTION 'Account namespace is already used by another account; choose a different account name'
        USING ERRCODE = '23505', CONSTRAINT = 'mcp_accounts_namespace_scope';
    END IF;
    RETURN NULL;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    INSERT INTO account_namespace_claims(namespace, kind, account_count)
    VALUES (NEW.namespace, NEW.kind, 1)
    ON CONFLICT (namespace) DO UPDATE
      SET account_count = account_namespace_claims.account_count + 1
      WHERE account_namespace_claims.kind = EXCLUDED.kind
    RETURNING namespace INTO claimed;

    IF claimed IS NULL THEN
      RAISE EXCEPTION 'Account namespace is already used by a Shared or Personal account; choose a different account name'
        USING ERRCODE = '23505', CONSTRAINT = 'mcp_accounts_namespace_scope';
    END IF;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    SELECT account_count INTO remaining FROM account_namespace_claims
    WHERE namespace = OLD.namespace FOR UPDATE;
    IF remaining = 1 THEN
      DELETE FROM account_namespace_claims WHERE namespace = OLD.namespace;
    ELSE
      UPDATE account_namespace_claims SET account_count = account_count - 1
      WHERE namespace = OLD.namespace;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER mcp_accounts_namespace_scope
AFTER INSERT OR DELETE OR UPDATE OF namespace, kind ON mcp_accounts
FOR EACH ROW EXECUTE FUNCTION maintain_account_namespace_claim();
