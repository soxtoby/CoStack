# Azure DevOps remote MCP authentication

Researched 2026-10-16 using Microsoft documentation and unauthenticated HTTP metadata requests. No tenant configuration, credentials, or authenticated Azure DevOps data was accessed.

## Conclusion

The absence of dynamic client registration does not prevent a gateway from connecting. A gateway can use a Microsoft Entra application registered in advance, perform delegated authorization for each connected user, and send the resulting access token to the remote MCP endpoint. Microsoft documents this pattern for custom desktop clients and, most relevant to a hosted gateway, Cursor Cloud Agents. The latter requires a Web redirect URI and a client secret. [Remote MCP setup](https://learn.microsoft.com/en-us/azure/devops/mcp-server/remote-mcp-server?view=azure-devops#configure-cursor-cloud-agents)

## Azure configuration

1. Use an Entra-backed Azure DevOps organization and an account with the required project/resource permissions.
2. Register a client application for CoStack. Register its actual OAuth callback as a **Web** redirect URI and create a client secret. CoStack's callback, as identified in the companion code investigation, is `${APPLICATION_URL}/api/upstream-oauth/callback`. Use the public deployed origin and an exact URI match. Keep the secret on the gateway.
3. Add delegated API permissions for **Azure DevOps MCP**, application ID `2a72489c-aab2-4b65-b93a-a91edccf33b8`. Select the required permissions and grant administrator consent as prescribed by Microsoft's custom-client setup. Tool filtering does not grant permissions; both delegated scope and the user's Azure DevOps permissions must permit an operation. [Custom-client setup and permissions](https://learn.microsoft.com/en-us/azure/devops/mcp-server/remote-mcp-server?view=azure-devops#choose-oauth-scopes-for-custom-clients)

If that API is absent from the tenant, an Application Administrator, Cloud Application Administrator, or Global Administrator can provision its service principal. Microsoft's documented sequence is to sign into the intended tenant, confirm the service principal is missing, create it, and verify it. Provisioning only creates the resource's service principal; it does not register the gateway or create unavailable scopes. [Provisioning guidance](https://learn.microsoft.com/en-us/azure/devops/mcp-server/remote-mcp-server-troubleshooting?view=azure-devops#cant-find-the-azure-devops-mcp-enterprise-application-in-the-tenant)

```powershell
az login --tenant <tenant-id> --allow-no-subscriptions
az ad sp create --id 2a72489c-aab2-4b65-b93a-a91edccf33b8
```

Those commands are instructions for an administrator; they were not run during this research.

## Live discovery results

An unauthenticated MCP `initialize` POST to `https://mcp.dev.azure.com/` returned HTTP 401 with:

```http
WWW-Authenticate: Bearer resource_metadata="https://mcp.dev.azure.com/.well-known/oauth-protected-resource/"
```

The [protected-resource metadata](https://mcp.dev.azure.com/.well-known/oauth-protected-resource) returned HTTP 200 and:

```json
{
  "resource": "https://mcp.dev.azure.com",
  "authorization_servers": [
    "https://login.microsoftonline.com/organizations/v2.0"
  ],
  "bearer_methods_supported": ["header"],
  "scopes_supported": ["https://mcp.dev.azure.com/.default"]
}
```

The [Entra OIDC metadata](https://login.microsoftonline.com/organizations/v2.0/.well-known/openid-configuration) returned:

```json
{
  "authorization_endpoint": "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
  "token_endpoint": "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
  "issuer": "https://login.microsoftonline.com/{tenantid}/v2.0",
  "token_endpoint_auth_methods_supported": [
    "client_secret_post",
    "private_key_jwt",
    "client_secret_basic",
    "self_signed_tls_client_auth"
  ],
  "scopes_supported": ["openid", "profile", "email", "offline_access"]
}
```

It did **not** advertise `registration_endpoint` or `code_challenge_methods_supported`. Both `https://login.microsoftonline.com/.well-known/oauth-authorization-server/organizations/v2.0` and `https://login.microsoftonline.com/organizations/v2.0/.well-known/oauth-authorization-server` returned HTTP 404. The installed SDK successfully handles OIDC fallback and PKCE despite that omission, as checked below. These are live observations, subject to change.

The companion investigation also fetched [organization-specific metadata](https://mcp.dev.azure.com/.well-known/oauth-protected-resource/ZapDev). It returned HTTP 200, resource `https://mcp.dev.azure.com/ZapDev`, a **tenant-specific** authorization server under `https://login.microsoftonline.com/<organization-tenant-id>/v2.0`, and scope `https://mcp.dev.azure.com/.default`. The organization-specific URL therefore supplies the tenant automatically.

## Scope and token flow

Use this as the starting scope configuration when the required delegated permissions are already configured on the client registration:

```text
https://mcp.dev.azure.com/.default offline_access
```

The MCP resource's live metadata supplies the first scope. Microsoft explains that `.default` requests the resource permissions already configured for the application; it does not mean all permissions exposed by that resource. `offline_access` must be requested to receive a refresh token. [Scopes and permissions](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc#the-default-scope), [Authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#successful-response-2)

The ordinary Azure DevOps REST API uses a different resource identifier, `499b84ac-1321-427f-aa17-267ca6975798`, and URI `https://app.vssps.visualstudio.com`. Do not substitute its `.default` scope for the MCP resource scope merely because both expose Azure DevOps operations. [Azure DevOps Entra integration](https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/entra-oauth?view=azure-devops#tips-for-building-and-migrating)

Use authorization code flow with PKCE `S256`, and authenticate the hosted confidential client with its secret during code redemption and refresh. Entra supports both form-body secret authentication and HTTP Basic. PKCE is recommended for confidential clients and does not replace their client credential. Persist each newly returned refresh token and handle consent/revocation failures by reconnecting. [Authorization and token requests](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)

This is delegated user access. A client secret is the gateway's credential during that flow; adding one does not turn the integration into an application-only/client-credentials grant. The researched remote-MCP setup documents delegated permissions, not an application-only MCP integration.

## Authority and tenancy

The root endpoint's live metadata selects the tenant-independent `organizations` authority. Microsoft associates that authority with applications accepting accounts from any organizational directory; a single-tenant application uses its tenant ID/domain authority. [Application tenancy and authorities](https://learn.microsoft.com/en-us/entra/identity-platform/howto-convert-app-to-be-multi-tenant#update-your-code-to-send-requests-to-common)

**Recommendation for CoStack:** configure `https://mcp.dev.azure.com/<organization>` and a single-tenant Web registration in that organization's tenant. The organization-specific metadata advertises the correct tenant authority, so no authority override is required. Use a multitenant registration only if deliberately using the root endpoint's `organizations` authority and accepting accounts across tenants. For guest access, Microsoft's troubleshooting guide requires the organization-specific MCP URL. [Guest access](https://learn.microsoft.com/en-us/azure/devops/mcp-server/remote-mcp-server-troubleshooting?view=azure-devops#guest-b2b-access-fails)

## Local compatibility checks

The companion code investigation found existing CoStack support for a pre-registered OAuth client ID, client secret, and scope in the Advanced OAuth application form (`src/components/control-app.tsx`). The provider returns this client information and stores tokens in `src/connections/oauth.ts`, so providing the registration bypasses dynamic client registration. These are existing capabilities; this research did not change application code.

The companion code investigation ran the installed MCP SDK's `discoverOAuthServerInfo` against `https://mcp.dev.azure.com/ZapDev`, then started `auth` with a fake pre-registered client ID/secret and stopped at the generated redirect. No browser sign-in or token exchange occurred. The generated authorization URL used the organization tenant, CoStack callback, scope `https://mcp.dev.azure.com/.default offline_access`, organization resource URI, and PKCE `S256`. This verifies discovery and authorization-request construction with the installed SDK, including the absent PKCE advertisement. Five existing OAuth tests passed with 44 assertions.

## Verification still required

### Compatibility issue found during setup

The subsequent real sign-in returned `invalid_target` / `AADSTS9010010`: the requested resource did not match the scopes. The installed SDK sends the organization-specific protected resource (`https://mcp.dev.azure.com/<organization>`) while the configured scope identifies the service-wide resource (`https://mcp.dev.azure.com/.default`). Microsoft requires the resource and scope to resolve to the same resource application, including exact URI matching. [Resource matching guidance](https://learn.microsoft.com/en-us/entra/agent-id/secure-mcp-server-with-entra-id#i-get-error-aadsts9010010-when-a-client-requests-a-token-for-my-mcp-server)

A local CoStack compatibility fix validates the advertised resource against the MCP connection, then omits the conflicting `resource` parameter for `mcp.dev.azure.com`. The fully qualified scope identifies the token audience while organization-specific discovery retains the correct tenant authority. Other servers retain resource validation and forwarding. A regression reproduces the rejection before the fix and exercises authorization, code exchange, and refresh afterward. This fix is not deployed; the earlier successful URL-construction probe did not establish Entra acceptance.

- Register/configure the client and complete a real account sign-in.
- Confirm the granted scopes for the actual tools and tenant; the public metadata exposes only `.default`, not a complete delegated-permission catalog.
- Exercise a read-only tool and token refresh. An unauthenticated 401 and successful metadata discovery do not establish an authenticated connection.

The remote endpoint does not accept PATs. [Authentication troubleshooting](https://learn.microsoft.com/en-us/azure/devops/mcp-server/remote-mcp-server-troubleshooting?view=azure-devops#authentication-errors)
