import { createFileRoute } from '@tanstack/react-router'
import { createServerOnlyFn } from '@tanstack/react-start'
import { upstreamOAuthRequestHandler as handleUpstreamOAuthRequest } from '../../../connections/control'

const upstreamOAuthRequestHandler = createServerOnlyFn(
  handleUpstreamOAuthRequest,
)

export const Route = createFileRoute('/api/upstream-oauth/callback')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) =>
        upstreamOAuthRequestHandler(request),
    },
  },
})
