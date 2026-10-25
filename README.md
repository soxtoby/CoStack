# CoStack

CoStack exposes authorized upstream MCP tools through one Streamable HTTP endpoint. Its UI manages local Groups, Connections, Shared and Personal Accounts, wildcard tool policy, SSO, and metadata-only audit records.

## Windows development

Install Bun, then copy `.env.example` to `.env`. Generate secrets in PowerShell:

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

Use one result for `ACCOUNT_SECRET_KEY` and separate random values for `BETTER_AUTH_SECRET`, `BOOTSTRAP_TOKEN`, and `RECOVERY_TOKEN`. Then run:

```powershell
bun install
bun run dev
```

The development command starts persistent PGlite on loopback, migrates it, then starts TanStack Start. It serves the same `/mcp`, `/health`, auth, and administration routes as production. PGlite data lives in `.pglite`. It listens on port 5432; set `PGLITE_PORT` when another PostgreSQL server already uses that port.

Open `/api/setup/bootstrap` with the bootstrap token to create the first Administrator and organization. Configure one OIDC provider through Better Auth. Pre-provision a User's verified email and Groups before their first SSO login. Keep the recovery token outside PostgreSQL.

## Production

Set `APPLICATION_URL` to the public HTTPS origin and provide `DATABASE_URL`, `BETTER_AUTH_SECRET`, `ACCOUNT_SECRET_KEY`, `BOOTSTRAP_TOKEN`, and `RECOVERY_TOKEN`. `DATABASE_URL` must target PostgreSQL. Startup applies committed migrations under an advisory lock and seeds the official MCP Registry after an organization exists. The server listens before that work finishes: `/health` answers at once and other requests wait for it. Enabled Connections refresh on startup and every six hours.

```sh
docker build -t costack .
docker run --rm -p 3000:3000 --env-file .env costack
```

The image pins Bun, the ASP.NET Core runtime and [ndx](https://github.com/devlooped/ndx), runs as a non-root user, and supports exact-version Bun/npm and .NET STDIO MCP commands. It has no .NET SDK: `dnx` is an alias for ndx, which downloads and runs .NET tool packages the same way without one. `bun run bundle` builds the server into one file, so the image ships no `node_modules`. `/health` is a process health check. Container termination stops accepting requests, closes upstream MCP clients, then closes PostgreSQL. The image is suitable for Azure Container Apps; Azure resource definitions are outside this repository.

### Azure Container Apps probes

When a scaled-to-zero app wakes, its first request waits until the replica's readiness probe passes. The default TCP readiness probe waits 3 seconds, then checks every 5 seconds. Probing `/health` every second routes that request sooner:

```yaml
probes:
  - type: Startup
    httpGet: { path: /health, port: 3000 }
    initialDelaySeconds: 1
    periodSeconds: 1
    failureThreshold: 10
  - type: Readiness
    httpGet: { path: /health, port: 3000 }
    initialDelaySeconds: 1
    periodSeconds: 1
    failureThreshold: 3
  - type: Liveness
    httpGet: { path: /health, port: 3000 }
    periodSeconds: 10
    timeoutSeconds: 3
    failureThreshold: 3
```

The startup probe allows 11 seconds for the port to open; raise `periodSeconds` if the `CoStack listening` event's `ElapsedMilliseconds` approaches that. `az containerapp update` has no probe options: set them under the container in the portal's Health probes tab, or add them to the container in `az containerapp show -o yaml` output and apply it with `az containerapp update --yaml`.

### Logging

Server logs use Sonant's console sink at Information level and above. Azure Container Apps captures this output in its console log stream. The `CoStack starting`, `CoStack listening` and `CoStack ready` events carry `ElapsedMilliseconds` since the process started, which separates the platform's share of a cold start from CoStack's own.

Set `SEQ_URL` to the Seq server's base URL to also send the same structured events to Seq. Set `SEQ_API_KEY` if the Seq server requires an ingestion key; provide it as a Container App secret. Without `SEQ_URL`, logging uses only the console. Events include `Application: CoStack`.

Seq delivery failures are reported to the console. Graceful shutdown closes the logger and flushes buffered Seq events after the server and database stop. Audit records remain in PostgreSQL.

### Entra-only PostgreSQL

Enable a managed identity on the Container App and have a PostgreSQL Entra administrator create a database role for that identity. Grant it `CONNECT` on the application database and `USAGE, CREATE` on its `public` schema so startup migrations can create and update the application's tables. Do not grant the application server administrator privileges.

Set `DATABASE_AUTHENTICATION=azure-managed-identity` and a passwordless URL:

```text
DATABASE_URL=postgresql://<database-role>@<server>.postgres.database.azure.com:5432/costack?sslmode=verify-full
```

URL-encode the role name if needed. System-assigned identity is the default; set `DATABASE_IDENTITY_CLIENT_ID` to select a user-assigned identity. Each new physical database connection requests a token through Azure Identity, allowing expired tokens to refresh without restarting the app. This mode requires verified TLS and rejects passwords in the URL. Keep private DNS linked to the app's VNet and allow access to PostgreSQL on port 5432.

The default `DATABASE_AUTHENTICATION=password` retains the existing connection-string behavior, including local PGlite development. Entra database authentication is independent of the application's OIDC user sign-in configuration.

For ChatGPT, use the gateway's Client ID Metadata Document flow. For Claude, create a predefined OAuth client and enter its client ID and secret in Claude. Both connect to `${APPLICATION_URL}/mcp` and require a publicly reachable HTTPS deployment.

## Bundled MCPs

Common services appear immediately on Add connection, without registry access. To add another, follow [the bundled catalog guide](docs/bundled-mcps.md).

## Scope

CoStack supports Streamable HTTP and STDIO upstreams, tools only, local Groups, one OIDC provider, and metadata-only audit logs. STDIO commands may use `bunx`, `dotnet`, `dnx --yes` (the `--yes` is required because there is no interactive prompt to approve the download), or another executable already in the image. `dotnet` runs framework-dependent apps; SDK commands such as `dotnet tool` are unavailable. Give `dnx` an exact `package@version`: without one, ndx follows the newest release and restarts the server when one is published, which drops its MCP session. Runtime file uploads, legacy SSE, payload logging, SAML, infrastructure provisioning, and automatic package upgrades are not supported.

Run `bun run check` before submitting changes. Build locally with `bun run build`, then run `bun run start` against PostgreSQL.
