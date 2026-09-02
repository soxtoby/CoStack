// The build creates this entrypoint.
// @ts-expect-error Production output does not exist before `bun run build`.
import serverEntry from './dist/server/server.js'
import { healthResponse } from './src/server/health'
import { migrate } from './src/database/migrate'
import { authHandler } from './src/auth/auth'
import { setupHandler } from './src/auth/setup'
import { closeGateway, mcpHandler } from './src/gateway/mcp'
import { pruneAudit } from './src/gateway/audit'
import { closeDatabasePool, databasePool } from './src/database/pool'
import { adminHandler } from './src/auth/admin'
import {
  closeConnectionControl,
  controlHandler,
  ensureOfficialRegistrySource,
  refreshDueConnections,
  upstreamOAuthRequestHandler,
} from './src/connections/control'

const port = Number(Bun.env.PORT ?? 3000)
const clientRoot = new URL('./dist/client/', import.meta.url)

function safeAssetPath(pathname: string) {
  const decoded = decodeURIComponent(pathname)
  if (decoded.includes('..')) return undefined
  return new URL(`.${decoded}`, clientRoot)
}

export function createProductionServer() {
  return Bun.serve({
    hostname: Bun.env.HOST ?? '0.0.0.0',
    port,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/health') return healthResponse()
      if (url.pathname === '/mcp') return mcpHandler(request)
      if (url.pathname.startsWith('/api/auth/')) return authHandler(request)
      if (url.pathname.startsWith('/.well-known/')) return authHandler(request)
      if (url.pathname.startsWith('/api/setup/')) return setupHandler(request)
      if (url.pathname === '/api/admin') return adminHandler(request)
      if (url.pathname === '/api/control') return controlHandler(request)
      if (url.pathname.startsWith('/api/upstream-oauth/'))
        return upstreamOAuthRequestHandler(request)

      const assetUrl = safeAssetPath(url.pathname)
      if (assetUrl) {
        const asset = Bun.file(assetUrl)
        if (await asset.exists()) {
          return new Response(asset, {
            headers: {
              'Cache-Control': url.pathname.startsWith('/assets/')
                ? 'public, max-age=31536000, immutable'
                : 'no-cache',
            },
          })
        }
      }
      return serverEntry.fetch(request)
    },
  })
}

if (import.meta.main) {
  await migrate()
  await ensureOfficialRegistrySource()
  await pruneAudit(databasePool())
  const server = createProductionServer()
  await refreshDueConnections()
  const refreshTimer = setInterval(
    () =>
      void Promise.all([
        refreshDueConnections(),
        pruneAudit(databasePool()),
      ]).catch(console.error),
    6 * 60 * 60 * 1000,
  )
  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    clearInterval(refreshTimer)
    await server.stop(false)
    await Promise.allSettled([closeGateway(), closeConnectionControl()])
    await closeDatabasePool()
  }
  process.once('SIGTERM', () => void shutdown())
  process.once('SIGINT', () => void shutdown())
  console.log(`CoStack listening on ${server.url}`)
}
