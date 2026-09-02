# Never persist tool arguments or results

Audit records contain Principal, MCP Client, Connection, Account, tool, policy decision, timing, and outcome metadata, but never tool arguments or results. Arbitrary MCP payloads may contain secrets or regulated data, and reliable generic redaction is impossible; runtime logs follow the same exclusion.
