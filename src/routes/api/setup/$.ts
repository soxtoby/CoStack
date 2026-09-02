import { createFileRoute } from '@tanstack/react-router'
import { createServerOnlyFn } from '@tanstack/react-start'
import { setupHandler as handleSetupRequest } from '../../../auth/setup'

const setupHandler = createServerOnlyFn(handleSetupRequest)

export const Route = createFileRoute('/api/setup/$')({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) => setupHandler(request),
    },
  },
})
