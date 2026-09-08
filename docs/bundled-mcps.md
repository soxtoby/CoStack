# Bundled MCP catalog

Add one object to `bundledMcps` in `src/connections/bundled-mcps.ts`. No new UI, routes, database seeds, or registry credentials are needed.

Each entry supplies a unique `id`, `displayName`, local `icon` path (store vendor SVG/PNG assets in `public/icons`), short `description`, search `keywords`, typed `transport`, vendor `documentationUrl`, Account `setup` instructions, and `registryIds` (use `[]` if absent).

Verify vendor ownership and transport/authentication settings against the linked vendor documentation. Never include credentials. HTTP entries should use the vendor's HTTPS endpoint; STDIO entries should pin package versions and state runtime requirements in `setup`.

The UI shows entries immediately, keeps them above and independent of registry search, and hides corresponding official-registry results. Custom-registry entries remain separate. Selection creates an unsaved review form with access disabled and tools blocked. Bundled configurations do not invent a registry version or provenance. Setup guidance also appears when adding an Account to a matching configuration.

GitHub provides the initial example. Copy its object and replace all fields, then run `bun run typecheck` and `bun test src/connections/bundled-mcps.test.ts src/components/bundled-mcps.test.tsx`. Add behavior tests only if the new entry needs new behavior. Finally verify the authenticated connection and tool discovery with real credentials.
