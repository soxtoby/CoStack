import { createFileRoute } from '@tanstack/react-router'
import { AddConnectionPage, useControlView } from '../components/control-app'

export const Route = createFileRoute('/_app/connections_/new')({
  component: Page,
})
function Page() {
  return <AddConnectionPage {...useControlView()} />
}
