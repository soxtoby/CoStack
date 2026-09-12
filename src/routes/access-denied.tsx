import { createFileRoute } from '@tanstack/react-router'
import { AccessDenied } from '../components/control-app'
import type { AccessDeniedReason } from '../auth/access-denied'

export const Route = createFileRoute('/access-denied')({
  validateSearch: (
    search: Record<string, unknown>,
  ): { reason: AccessDeniedReason; email: string | undefined } => ({
    email: typeof search.email === 'string' ? search.email : undefined,
    reason:
      search.reason === 'email-unverified' || search.reason === 'disabled'
        ? search.reason
        : 'not-added',
  }),
  component: AccessDeniedPage,
})

function AccessDeniedPage() {
  return <AccessDenied {...Route.useSearch()} />
}
