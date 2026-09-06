import { createFileRoute } from '@tanstack/react-router'
import { Connections, useControlView } from '../components/control-app'

export const Route = createFileRoute('/_app/connections')({
  component: Page,
  validateSearch: (
    search: Record<string, unknown>,
  ): { connection?: string; oauth?: 'connected' } => ({
    ...(typeof search.connection === 'string'
      ? { connection: search.connection }
      : {}),
    ...(search.oauth === 'connected' ? { oauth: 'connected' as const } : {}),
  }),
})

function Page() {
  const view = useControlView()
  return <Connections {...view} />
}
