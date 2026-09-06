import { createFileRoute } from '@tanstack/react-router'
import {
  ConfigureConnectionPage,
  useControlView,
} from '../components/control-app'

export const Route = createFileRoute(
  '/_app/connections_/$connectionId/configure',
)({
  component: Page,
  validateSearch: (
    search: Record<string, unknown>,
  ): { tab: 'connection' | 'tools' } => ({
    tab: search.tab === 'tools' ? 'tools' : 'connection',
  }),
})
function Page() {
  const { connectionId } = Route.useParams()
  const { tab } = Route.useSearch()
  return (
    <ConfigureConnectionPage
      {...useControlView()}
      connectionId={connectionId}
      tab={tab}
    />
  )
}
