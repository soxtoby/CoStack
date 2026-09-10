# Bundled MCP catalog

Add one object to `bundledMcps` in `src/connections/bundled-mcps.ts`. No new UI, routes, database seeds, or registry credentials are needed.

Each entry supplies a unique `id`, `displayName`, local `icon` path (store vendor SVG/PNG assets in `public/icons`), short `description`, search `keywords`, typed `transport`, vendor `documentationUrl`, Account `setup` instructions, and `registryIds` (use `[]` if absent).

Verify vendor ownership and transport/authentication settings against the linked vendor documentation. Never include credentials. HTTP entries should use the vendor's HTTPS endpoint; STDIO entries should pin package versions and state runtime requirements in `setup`.

The UI shows entries immediately, keeps them above and independent of registry search, and hides corresponding official-registry results. Custom-registry entries remain separate. Selection creates an unsaved review form with access disabled and tools blocked. Bundled configurations do not invent a registry version or provenance. Setup guidance also appears when adding an Account to a matching configuration.

GitHub provides the initial example. Copy its object and replace all fields, then run `bun run typecheck` and `bun test src/connections/bundled-mcps.test.ts src/components/bundled-mcps.test.tsx`. Add behavior tests only if the new entry needs new behavior. Finally verify the authenticated connection and tool discovery with real credentials.

The catalog also includes [Slack](https://docs.slack.dev/ai/slack-mcp-server/), [Microsoft Teams](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-teams-tools), and [Linear](https://linear.app/docs/mcp). Slack requires an internal or Marketplace app with configured OAuth credentials. Linear supports OAuth or a bearer API key. Teams uses a tenant-specific URL: enter the Entra tenant UUID in the required tenant ID field; saving replaces `{tenantId}` in the URL. Setup guidance still recognizes the configured Teams URL. Teams requires Agent 365 Frontier access and administrator consent; see [Microsoft’s authentication requirements](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/mcp-authentication#bring-your-own-microsoft-entra-app-registration). Its bundled instructions use a manually supplied access token, which must be replaced when it expires.

Icons are downloaded from the vendors: Slack’s developer documentation favicon, Linear’s website SVG favicon, and the Teams website favicon hosted on Microsoft’s CDN.
