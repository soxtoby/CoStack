import { asError, logger } from '../server/logging'
import type { Logger } from 'sonant'

/** OAuth errors use `error`; Better Auth's own rejections use `code`. */
interface ErrorBody {
  error?: string
  error_description?: string
  code?: string
  message?: string
}

/**
 * Better Auth answers rejected token requests without logging them, so an MCP
 * Client that loses its grant otherwise leaves no trace on the server.
 */
export async function logTokenFailures(
  request: Request,
  handle: (request: Request) => Promise<Response>,
  log: Logger = logger,
) {
  const copy = request.clone()
  const response = await handle(request)
  if (!response.ok) await logFailure(copy, response.clone(), log)
  return response
}

async function logFailure(request: Request, response: Response, log: Logger) {
  try {
    const fields = new URLSearchParams(await request.text())
    const body = (await response.json().catch(() => ({}))) as ErrorBody
    log
      .with({
        ClientId: clientId(request, fields),
        StatusCode: response.status,
        ErrorDescription: body.error_description ?? body.message,
      })
      .warn('Token request for grant {GrantType} failed with {Error}', {
        GrantType: fields.get('grant_type'),
        Error: body.error ?? body.code,
      })
  } catch (error) {
    log.warn(asError(error), 'Could not log a failed token request')
  }
}

/** RFC 6749 section 2.3.1 form-encodes the client id inside Basic credentials. */
function clientId(request: Request, fields: URLSearchParams) {
  const [scheme, credentials] =
    request.headers.get('authorization')?.split(' ') ?? []
  if (scheme?.toLowerCase() !== 'basic' || !credentials)
    return fields.get('client_id')
  const [id = ''] = atob(credentials).split(':')
  return decodeURIComponent(id)
}
