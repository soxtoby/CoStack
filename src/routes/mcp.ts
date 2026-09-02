import { createFileRoute } from '@tanstack/react-router'
import { createServerOnlyFn } from '@tanstack/react-start'
import { mcpHandler as handleMcpRequest } from '../gateway/mcp'

const mcpHandler = createServerOnlyFn(handleMcpRequest)

export const Route = createFileRoute('/mcp')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => mcpHandler(request),
      POST: ({ request }: { request: Request }) => mcpHandler(request),
    },
  },
})
