// The build creates this entrypoint.
// @ts-expect-error Production output does not exist before `bun run build`.
import serverEntry from './dist/server/server.js'
import { logger } from './src/server/logging'
import { afterStartup } from './src/server/startup'
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

export function createProductionServer(startup: Promise<unknown>) {
  return Bun.serve({
    hostname: Bun.env.HOST ?? '0.0.0.0',
    port,
    error(error) {
      logger.error(error, 'Unhandled request failure')
      return new Response('Internal Server Error', { status: 500 })
    },
    fetch: afterStartup(startup, async (request) => {
      const url = new URL(request.url)
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
    }),
  })
}

if (import.meta.main) {
  // Each startup event carries the time since the process started, separating
  // the platform's share of a cold start from CoStack's own.
  const elapsed = () => ({ ElapsedMilliseconds: Math.round(performance.now()) })
  logger.with(elapsed()).info('CoStack starting')
  // Listen before the database work so a cold start's first request waits
  // only for that work, not for it plus the platform's next readiness probe.
  const startup = (async () => {
    await migrate()
    await ensureOfficialRegistrySource()
    await pruneAudit(databasePool())
  })()
  const server = createProductionServer(startup)
  logger
    .with(elapsed())
    .info('CoStack listening on {Url}', { Url: server.url.toString() })
  await startup
  logger.with(elapsed()).info('CoStack ready')
  await refreshDueConnections()
  const refreshTimer = setInterval(
    () =>
      void Promise.all([
        refreshDueConnections(),
        pruneAudit(databasePool()),
      ]).catch((error: unknown) =>
        logger.error(
          new Error('Background maintenance failed', { cause: error }),
          'Background maintenance failed',
        ),
      ),
    6 * 60 * 60 * 1000,
  )
  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    clearInterval(refreshTimer)
    logger.info('CoStack shutting down')
    try {
      await server.stop(false)
      await Promise.allSettled([closeGateway(), closeConnectionControl()])
      await closeDatabasePool()
      logger.info('CoStack stopped')
    } catch (error) {
      logger.error(
        new Error('Shutdown failed', { cause: error }),
        'CoStack shutdown failed',
      )
      process.exitCode = 1
    } finally {
      await logger
        .close()
        .catch((error: unknown) =>
          logger.error(
            new Error('Logging shutdown failed', { cause: error }),
            'Failed to flush logs during shutdown',
          ),
        )
    }
  }
  process.once('SIGTERM', () => void shutdown())
  process.once('SIGINT', () => void shutdown())
}
