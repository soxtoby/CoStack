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

The development command starts persistent PGlite on loopback, migrates it, then starts TanStack Start. It serves the same `/mcp`, `/health`, auth, and administration routes as production. PGlite data lives in `.pglite`.

Open `/api/setup/bootstrap` with the bootstrap token to create the first Administrator and organization. Configure one OIDC provider through Better Auth. Pre-provision a User's verified email and Groups before their first SSO login. Keep the recovery token outside PostgreSQL.

## Production

Set `APPLICATION_URL` to the public HTTPS origin and provide `DATABASE_URL`, `BETTER_AUTH_SECRET`, `ACCOUNT_SECRET_KEY`, `BOOTSTRAP_TOKEN`, and `RECOVERY_TOKEN`. `DATABASE_URL` must target PostgreSQL. Startup applies committed migrations under an advisory lock and seeds the official MCP Registry after an organization exists. Enabled Connections refresh on startup and every six hours.

```sh
docker build -t costack .
docker run --rm -p 3000:3000 --env-file .env costack
```

The image pins Bun and the .NET SDK, runs as a non-root user, and supports exact-version Bun/npm and .NET STDIO MCP commands. `/health` is a process health check. Container termination stops accepting requests, closes upstream MCP clients, then closes PostgreSQL. The image is suitable for Azure Container Apps; Azure resource definitions are outside this repository.

For ChatGPT, use the gateway's Client ID Metadata Document flow. For Claude, create a predefined OAuth client and enter its client ID and secret in Claude. Both connect to `${APPLICATION_URL}/mcp` and require a publicly reachable HTTPS deployment.

## Scope

CoStack supports Streamable HTTP and STDIO upstreams, tools only, local Groups, one OIDC provider, and metadata-only audit logs. STDIO commands may use `bunx`, `dotnet`, or another executable already in the image. Runtime file uploads, legacy SSE, payload logging, SAML, infrastructure provisioning, and automatic package upgrades are not supported.

Run `bun run check` before submitting changes. Build locally with `bun run build`, then run `bun run start` against PostgreSQL.
