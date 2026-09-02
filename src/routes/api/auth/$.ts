import { createFileRoute } from '@tanstack/react-router'
import { createServerOnlyFn } from '@tanstack/react-start'
import { authHandler as handleAuthRequest } from '../../../auth/auth'

const authHandler = createServerOnlyFn(handleAuthRequest)

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => authHandler(request),
      POST: ({ request }: { request: Request }) => authHandler(request),
    },
  },
})
