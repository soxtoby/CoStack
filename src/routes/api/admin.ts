import { createFileRoute } from '@tanstack/react-router'
import { createServerOnlyFn } from '@tanstack/react-start'
import { adminHandler as handleAdminRequest } from '../../auth/admin'

const adminHandler = createServerOnlyFn(handleAdminRequest)

export const Route = createFileRoute('/api/admin')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => adminHandler(request),
      POST: ({ request }: { request: Request }) => adminHandler(request),
    },
  },
})
