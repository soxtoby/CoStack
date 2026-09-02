# Use TanStack Start on a custom Bun server

The application uses React 19 and TanStack Start in one package, hosted by a custom `Bun.serve` process. The server handles `/mcp` with the MCP SDK's stateless Web Standard handler before forwarding web requests to TanStack Start, whose documented Better Auth integration owns browser auth routes; this accepts TanStack Start's release-candidate churn in exchange for a Bun-native server and typed React application model.
