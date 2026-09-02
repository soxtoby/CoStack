import { createFileRoute } from '@tanstack/react-router'
import { createServerOnlyFn } from '@tanstack/react-start'
import { controlHandler as handleControlRequest } from '../../connections/control'

const controlHandler = createServerOnlyFn(handleControlRequest)

export const Route = createFileRoute('/api/control')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => controlHandler(request),
      POST: ({ request }: { request: Request }) => controlHandler(request),
    },
  },
})
