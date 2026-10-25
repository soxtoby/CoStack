import { healthResponse } from './health'

/**
 * Answers health checks while startup work is still running, so the platform
 * can route a cold start's first request sooner; that request then waits for
 * startup rather than for the platform's next probe.
 */
export function afterStartup(
  startup: Promise<unknown>,
  handle: (request: Request) => Response | Promise<Response>,
) {
  return async (request: Request) => {
    if (new URL(request.url).pathname === '/health') return healthResponse()
    await startup
    return handle(request)
  }
}
